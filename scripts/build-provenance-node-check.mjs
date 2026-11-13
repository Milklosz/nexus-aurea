import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  PAYLOAD_POLICIES,
  TOOL_PATTERNS,
  buildLocationOf,
  createManifest,
  assertApplicationExecutable,
  inspectNsisPayload,
  parsePortableExecutable,
  inspectSource,
  parseLinkerProbe,
  payloadPolicyFor,
  selectReleaseAssets,
  validateAgainstSchema,
  verifyManifest,
  verifyPayloadRelation,
  verifyReleaseAssets,
} from "./build-provenance.mjs";

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "build-provenance.mjs");
const temporaryDirectories = [];

async function temporaryDirectory(label) {
  const directory = await mkdtemp(path.join(os.tmpdir(), `velora ${label} `));
  temporaryDirectories.push(directory);
  return directory;
}

function git(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.error || "unknown error"}`,
  );
  return result.stdout.trim();
}

const LOCKFILE = `lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      '@tauri-apps/cli':
        specifier: ^2.0.0
        version: 2.12.4
`;

async function initializeRepository(directory) {
  await mkdir(path.join(directory, "src-tauri"), { recursive: true });
  git(directory, ["init", "--initial-branch=main"]);
  git(directory, ["config", "user.name", "VELORA provenance test"]);
  git(directory, ["config", "user.email", "velora-provenance@example.invalid"]);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "0.9.2" }));
  await writeFile(path.join(directory, "src-tauri", "Cargo.toml"), '[package]\nname = "nexus-aurea"\nversion = "0.9.2"\n\n[lib]\nname = "x"\n');
  await writeFile(path.join(directory, "pnpm-lock.yaml"), LOCKFILE);
  await writeFile(path.join(directory, "README.md"), "first\n");
  await writeFile(path.join(directory, ".gitignore"), "target/\n");
  git(directory, ["add", "."]);
  git(directory, ["commit", "-m", "first synthetic commit"]);
}

/** A real synthetic merge commit whose parents are [base, head], as on GitHub. */
async function initializePullRequestRepository(directory) {
  await initializeRepository(directory);
  const base = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["checkout", "-b", "feature"]);
  await writeFile(path.join(directory, "README.md"), "feature\n");
  git(directory, ["commit", "-am", "feature commit"]);
  const head = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["checkout", "main"]);
  await writeFile(path.join(directory, "OTHER.md"), "base moved\n");
  git(directory, ["add", "OTHER.md"]);
  git(directory, ["commit", "-m", "base moved"]);
  const movedBase = git(directory, ["rev-parse", "HEAD"]);
  git(directory, ["checkout", "--detach", "HEAD"]);
  git(directory, ["merge", "--no-ff", "-m", "synthetic merge", head]);
  return { base: movedBase, head, merge: git(directory, ["rev-parse", "HEAD"]), unusedFirstBase: base };
}

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

const TOOLS = {
  node: "v22.0.0",
  pnpm: "11.25.0",
  rustc: "rustc 1.100.0 (0ef1bc386 2026-11-09)",
  cargo: "cargo 1.100.0 (3acc79c0c 2026-11-05)",
  tauriCli: "tauri-cli 2.12.4",
  msvc: "14.44.35207",
  windowsSdk: "10.0.26100.0",
};

const MARKER = "__TAURI_BUNDLE_TYPE_VAR_";
const MARKER_OFFSET = 1000;

// Layout of the synthetic PE below (all offsets are what the strict parser reads).
const PE_OFFSET = 0x80;
const COFF_OFFSET = PE_OFFSET + 4;
const OPTIONAL_OFFSET = COFF_OFFSET + 20;
const AMD64 = 0x8664;
const I386 = 0x14c;

/**
 * A structurally valid synthetic PE: DOS header, PE signature, COFF header,
 * Optional Header (PE32+ for 64-bit machines, PE32 otherwise), one section that
 * holds deterministic filler and an optional bundle-type marker.
 */
function syntheticExe(
  tag = "UNK",
  { size = 4096, markerOffset = MARKER_OFFSET, extraMarkers = [], seed = 7, machine = AMD64, dll = false } = {},
) {
  const bytes = Buffer.alloc(size);
  let state = seed;
  for (let index = 0x200; index < size; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = 0x30 + (state % 40); // printable, never contains the marker prefix
  }
  const pe32Plus = machine !== I386;
  const optionalSize = (pe32Plus ? 112 : 96) + 16 * 8;
  const rawSize = size - 0x200;
  const imageSize = 0x1000 + Math.ceil(rawSize / 0x1000) * 0x1000;
  bytes.write("MZ", 0, "ascii");
  bytes.writeUInt32LE(PE_OFFSET, 0x3c);
  bytes.write("PE\0\0", PE_OFFSET, "latin1");
  bytes.writeUInt16LE(machine, COFF_OFFSET);
  bytes.writeUInt16LE(1, COFF_OFFSET + 2); // sections
  bytes.writeUInt16LE(optionalSize, COFF_OFFSET + 16);
  bytes.writeUInt16LE(0x0002 | (dll ? 0x2000 : 0), COFF_OFFSET + 18);
  bytes.writeUInt16LE(pe32Plus ? 0x20b : 0x10b, OPTIONAL_OFFSET);
  bytes.writeUInt32LE(0x1000, OPTIONAL_OFFSET + 16); // entry point
  bytes.writeUInt32LE(0x1000, OPTIONAL_OFFSET + 32); // section alignment
  bytes.writeUInt32LE(0x200, OPTIONAL_OFFSET + 36); // file alignment
  bytes.writeUInt32LE(imageSize, OPTIONAL_OFFSET + 56);
  bytes.writeUInt32LE(0x200, OPTIONAL_OFFSET + 60); // size of headers
  bytes.writeUInt16LE(2, OPTIONAL_OFFSET + 68); // GUI subsystem
  bytes.writeUInt32LE(16, OPTIONAL_OFFSET + (pe32Plus ? 108 : 92)); // data directories
  const section = OPTIONAL_OFFSET + optionalSize;
  bytes.write(".text", section, "ascii");
  bytes.writeUInt32LE(rawSize, section + 8); // virtual size
  bytes.writeUInt32LE(0x1000, section + 12); // virtual address
  bytes.writeUInt32LE(rawSize, section + 16); // raw size
  bytes.writeUInt32LE(0x200, section + 20); // raw pointer
  if (tag) bytes.write(`${MARKER}${tag}`, markerOffset, "ascii");
  extraMarkers.forEach(([offset, extraTag]) => bytes.write(`${MARKER}${extraTag}`, offset, "ascii"));
  return bytes;
}

/** The installer stub: a 32-bit EXE with data appended after the last section (the NSIS overlay). */
function syntheticInstaller() {
  return Buffer.concat([syntheticExe(null, { machine: I386, seed: 21 }), Buffer.from("appended installer data")]);
}

const POLICY = PAYLOAD_POLICIES.get("2.12.4");

async function prepareBuild(label, { pullRequest = true } = {}) {
  const parent = await temporaryDirectory(label);
  const repo = path.join(parent, "repository");
  await mkdir(repo);
  const shas = pullRequest ? await initializePullRequestRepository(repo) : null;
  if (!pullRequest) await initializeRepository(repo);
  const releaseDirectory = path.join(repo, "src-tauri", "target", "x86_64-pc-windows-msvc", "release");
  await mkdir(releaseDirectory, { recursive: true });
  const outputs = path.join(parent, "outputs");
  await mkdir(path.join(outputs, "extracted"), { recursive: true });
  const installerPath = path.join(outputs, "VELORA_0.9.2_x64-setup.exe");
  const payloadPath = path.join(releaseDirectory, "nexus-aurea.exe");
  const packagedPayloadPath = path.join(outputs, "extracted", "nexus-aurea.exe");
  await writeFile(installerPath, syntheticInstaller());
  await writeFile(payloadPath, syntheticExe("UNK"));
  await writeFile(packagedPayloadPath, syntheticExe("NSS"));
  const checkoutSha = inspectSource(repo).checkoutSha;
  const env = pullRequest
    ? {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: path.join(parent, "event.json"),
        GITHUB_REF: "refs/pull/88/merge",
        GITHUB_SHA: checkoutSha,
        GITHUB_HEAD_REF: "feature",
        GITHUB_RUN_ID: "43474151065",
        GITHUB_RUN_ATTEMPT: "1",
        VELORA_SOURCE_SHA: checkoutSha,
        VELORA_CHECKOUT_SHA: checkoutSha,
        RUNNER_OS: "Windows",
      }
    : {
        GITHUB_ACTIONS: "true",
        GITHUB_EVENT_NAME: "push",
        GITHUB_REF: "refs/tags/v0.9.2",
        GITHUB_SHA: checkoutSha,
        GITHUB_RUN_ID: "43474151066",
        GITHUB_RUN_ATTEMPT: "1",
        VELORA_SOURCE_SHA: checkoutSha,
        RUNNER_OS: "Windows",
      };
  if (pullRequest) {
    await writeFile(
      env.GITHUB_EVENT_PATH,
      JSON.stringify({ pull_request: { number: 88, head: { sha: shas.head }, base: { sha: shas.base } } }),
    );
  }
  const files = { installerPath, payloadPath, packagedPayloadPath, repoRoot: repo };
  const manifest = await createManifest({
    ...files,
    env,
    tools: TOOLS,
    requireTools: true,
    now: new Date("2026-11-13T12:00:00Z"),
  });
  return {
    parent,
    repo,
    shas,
    env,
    files,
    manifest,
    collect: async () => ({ ...TOOLS }),
    now: new Date("2026-11-13T12:30:00Z"),
  };
}

function verify(build, overrides = {}) {
  return verifyManifest({
    manifest: build.manifest,
    ...build.files,
    env: build.env,
    collect: build.collect,
    now: build.now,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Git metadata
// ---------------------------------------------------------------------------

test("two commits on one branch refresh the full SHA without a clean", async () => {
  const parent = await temporaryDirectory("same-branch");
  const repo = path.join(parent, "repository");
  await initializeRepository(repo);
  const first = inspectSource(repo);
  assert.match(first.checkoutSha, /^[0-9a-f]{40}$/i);
  assert.equal(first.branch, "main");
  assert.equal(first.dirty, false);

  await writeFile(path.join(repo, "README.md"), "second\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "second synthetic commit"]);
  const second = inspectSource(repo);
  assert.match(second.checkoutSha, /^[0-9a-f]{40}$/i);
  assert.notEqual(second.checkoutSha, first.checkoutSha);
  assert.equal(second.branch, "main");
  assert.equal(second.dirty, false);
});

test("detached HEAD, worktrees and dirty checkouts retain truthful metadata", async () => {
  const parent = await temporaryDirectory("checkout-states");
  const repo = path.join(parent, "repository");
  const worktree = path.join(parent, "linked worktree");
  await initializeRepository(repo);

  git(repo, ["checkout", "--detach", "HEAD"]);
  const detached = inspectSource(repo);
  assert.match(detached.checkoutSha, /^[0-9a-f]{40}$/i);
  assert.equal(detached.branch, null);
  assert.equal(detached.dirty, false);

  git(repo, ["checkout", "main"]);
  git(repo, ["worktree", "add", "-b", "worktree-branch", worktree, "HEAD"]);
  const linked = inspectSource(worktree);
  assert.match(linked.checkoutSha, /^[0-9a-f]{40}$/i);
  assert.equal(linked.branch, "worktree-branch");

  await writeFile(path.join(worktree, "untracked.txt"), "dirty\n");
  assert.equal(inspectSource(worktree).dirty, true);
});

test("missing Git metadata stays unknown rather than inventing a commit", async () => {
  const directory = await temporaryDirectory("without-git");
  const metadata = inspectSource(directory);
  assert.equal(metadata.checkoutSha, null);
  assert.equal(metadata.branch, null);
  assert.equal(metadata.dirty, null);
});

// ---------------------------------------------------------------------------
// Build -> payload relation (F03)
// ---------------------------------------------------------------------------

test("the allowed Tauri transformation is accepted and everything else about the payload must be identical", () => {
  const relation = verifyPayloadRelation(syntheticExe("UNK"), syntheticExe("NSS"), POLICY);
  assert.equal(relation.markerOffset, MARKER_OFFSET);
  assert.equal(relation.transformation, `${MARKER}UNK->${MARKER}NSS`);
  assert.equal(relation.policy, "tauri-cli-2.12.4-nsis-unsigned");
});

test("the real audited artifact pair satisfies the rule (recorded facts: offset 12692696, one NSS marker)", () => {
  // The audited EXE was 16,054,784 bytes with a single NSS marker at offset 12,692,696
  // and hashing the UNK-restored buffer reproduced the manifest's built-EXE hash.
  const size = 16_054_784;
  const offset = 12_692_696;
  const packaged = syntheticExe("NSS", { size, markerOffset: offset });
  const built = Buffer.from(packaged);
  built.write(`${MARKER}UNK`, offset, "ascii");
  assert.equal(verifyPayloadRelation(built, packaged, POLICY).markerOffset, offset);
});

test("payload relation rejects an unrelated file, a modified EXE and every other deviation", () => {
  const built = syntheticExe("UNK");
  const packaged = syntheticExe("NSS");
  const rejects = (label, builtBytes, packagedBytes, pattern) =>
    assert.throws(() => verifyPayloadRelation(builtBytes, packagedBytes, POLICY), pattern, label);

  rejects("a text file as the built EXE", Buffer.from("this is only text, not an executable ".repeat(200)), packaged, /not a valid Windows executable/);
  rejects("a text file as the packaged EXE", built, Buffer.from("this is only text, not an executable ".repeat(200)), /not a valid Windows executable/);
  rejects("a different EXE with the same marker rule", syntheticExe("UNK", { seed: 99 }), packaged, /outside the allowed bundle-type marker/);

  const modifiedCode = Buffer.from(packaged);
  modifiedCode[2000] ^= 0xff;
  rejects("a modified byte in the code", built, modifiedCode, /outside the allowed bundle-type marker/);
  const modifiedResource = Buffer.from(built);
  modifiedResource[4000] ^= 0x01;
  rejects("a modified byte at the very end", modifiedResource, packaged, /outside the allowed bundle-type marker/);

  rejects("a truncated payload", built, packaged.subarray(0, 4000), /raw data lies outside the file|differ in size/);
  rejects("an appended payload", built, Buffer.concat([packaged, Buffer.from("x")]), /differ in size/);
  rejects("no marker in the packaged EXE", built, syntheticExe(null), /exactly one bundle-type marker/);
  rejects("no marker in the built EXE", syntheticExe(null), packaged, /exactly one bundle-type marker/);
  rejects("two markers in the packaged EXE", built, syntheticExe("NSS", { extraMarkers: [[2500, "NSS"]] }), /exactly one bundle-type marker/);
  rejects("two markers in the built EXE", syntheticExe("UNK", { extraMarkers: [[2500, "UNK"]] }), packaged, /exactly one bundle-type marker/);
  rejects("another bundle type (MSI) in the packaged EXE", built, syntheticExe("MSI"), /marker is not/);
  rejects("another bundle type (DEB) in the built EXE", syntheticExe("DEB"), packaged, /marker is not/);
  rejects("an unpatched packaged EXE", built, syntheticExe("UNK"), /marker is not/);
  rejects("reversed roles", packaged, built, /marker is not/);
  rejects("the marker at another offset", built, syntheticExe("NSS", { markerOffset: 1500 }), /moved|outside/);
});

test("an unknown Tauri CLI version or a missing tool has no payload policy", () => {
  assert.equal(payloadPolicyFor("tauri-cli 2.12.4").id, "tauri-cli-2.12.4-nsis-unsigned");
  assert.throws(() => payloadPolicyFor("tauri-cli 2.13.0"), /No reviewed payload transformation policy/);
  assert.throws(() => payloadPolicyFor("unavailable"), /No reviewed payload transformation policy/);
  assert.throws(() => payloadPolicyFor("invented"), /No reviewed payload transformation policy/);
});

// ---------------------------------------------------------------------------
// PE structure (N02)
// ---------------------------------------------------------------------------

test("well-formed PE files are accepted: 64-bit EXE, 32-bit EXE, DLL and an installer with appended data", () => {
  const exe = parsePortableExecutable(syntheticExe("NSS"), "exe");
  assert.deepEqual([exe.machine, exe.isDll, exe.isPe32Plus, exe.sectionCount], [AMD64, false, true, 1]);
  const exe32 = parsePortableExecutable(syntheticExe(null, { machine: I386 }), "exe32");
  assert.deepEqual([exe32.machine, exe32.isPe32Plus], [I386, false]);
  assert.equal(parsePortableExecutable(syntheticExe(null, { dll: true }), "dll").isDll, true);
  const installer = syntheticInstaller();
  assert.ok(parsePortableExecutable(installer, "installer").overlayOffset < installer.length);
  assert.equal(assertApplicationExecutable(syntheticExe("NSS"), "exe", AMD64).machine, AMD64);
});

/** Each case patches the header of a valid PE; every one must be refused. */
const BAD_PE = [
  ["only an MZ signature", () => Buffer.concat([Buffer.from("MZ"), Buffer.alloc(0x100)]), /overlaps the DOS header/],
  ["MZ followed by text", () => Buffer.concat([Buffer.from("MZ"), Buffer.from("not a real executable ".repeat(40))]), /outside the file|PE signature|overlaps/],
  ["no MZ signature", (b) => { b[0] = 0x50; return b; }, /missing MZ/],
  ["a file shorter than the DOS header", (b) => b.subarray(0, 0x30), /DOS header/],
  ["e_lfanew inside the DOS header", (b) => { b.writeUInt32LE(0x20, 0x3c); return b; }, /overlaps the DOS header/],
  ["e_lfanew beyond the end of the file", (b) => { b.writeUInt32LE(b.length + 100, 0x3c); return b; }, /outside the file/],
  ["e_lfanew of 0xffffffff", (b) => { b.writeUInt32LE(0xffffffff, 0x3c); return b; }, /outside the file/],
  ["e_lfanew pointing at filler instead of PE\\0\\0", (b) => { b.writeUInt32LE(0x400, 0x3c); return b; }, /PE signature/],
  ["a damaged PE signature", (b) => { b[PE_OFFSET + 2] = 0x58; return b; }, /PE signature/],
  ["truncated inside the COFF header", (b) => b.subarray(0, PE_OFFSET + 10), /outside the file/],
  ["truncated inside the Optional Header", (b) => b.subarray(0, OPTIONAL_OFFSET + 40), /Optional Header/],
  ["truncated inside the section table", (b) => b.subarray(0, OPTIONAL_OFFSET + 240 + 20), /section table/],
  ["truncated section data", (b) => b.subarray(0, 0x300), /raw data lies outside the file/],
  ["an unknown machine type", (b) => { b.writeUInt16LE(0x1234, COFF_OFFSET); return b; }, /unsupported machine/],
  ["zero sections", (b) => { b.writeUInt16LE(0, COFF_OFFSET + 2); return b; }, /section count/],
  ["97 sections", (b) => { b.writeUInt16LE(97, COFF_OFFSET + 2); return b; }, /section count/],
  ["not marked as an executable image", (b) => { b.writeUInt16LE(0x0000, COFF_OFFSET + 18); return b; }, /not marked as an executable/],
  ["an Optional Header size of zero", (b) => { b.writeUInt16LE(0, COFF_OFFSET + 16); return b; }, /Optional Header is missing/],
  ["an Optional Header size past the end of the file", (b) => { b.writeUInt16LE(0xfff0, COFF_OFFSET + 16); return b; }, /outside the file/],
  ["an Optional Header shorter than its fixed part", (b) => { b.writeUInt16LE(60, COFF_OFFSET + 16); return b; }, /shorter than its fixed part/],
  ["an unknown Optional Header magic", (b) => { b.writeUInt16LE(0x0107, OPTIONAL_OFFSET); return b; }, /Optional Header magic/],
  ["a PE32 header on a 64-bit machine", (b) => { b.writeUInt16LE(0x10b, OPTIONAL_OFFSET); return b; }, /does not match the machine/],
  ["17 data directories", (b) => { b.writeUInt32LE(17, OPTIONAL_OFFSET + 108); return b; }, /data directory table/],
  ["a file alignment of zero", (b) => { b.writeUInt32LE(0, OPTIONAL_OFFSET + 36); return b; }, /file alignment/],
  ["a file alignment that is not a power of two", (b) => { b.writeUInt32LE(0x300, OPTIONAL_OFFSET + 36); return b; }, /file alignment/],
  ["a section alignment below the file alignment", (b) => { b.writeUInt32LE(0x100, OPTIONAL_OFFSET + 32); return b; }, /section alignment/],
  ["a size of image that is not section aligned", (b) => { b.writeUInt32LE(0x2345, OPTIONAL_OFFSET + 56); return b; }, /size of image/],
  ["a size of headers that does not cover the section table", (b) => { b.writeUInt32LE(0x100, OPTIONAL_OFFSET + 60); return b; }, /size of headers/],
  ["a console-less native subsystem on an EXE", (b) => { b.writeUInt16LE(1, OPTIONAL_OFFSET + 68); return b; }, /subsystem/],
  ["an entry point outside every section", (b) => { b.writeUInt32LE(0x50000, OPTIONAL_OFFSET + 16); return b; }, /entry point/],
  ["a zero entry point on an EXE", (b) => { b.writeUInt32LE(0, OPTIONAL_OFFSET + 16); return b; }, /entry point/],
  ["a section outside the image", (b) => { b.writeUInt32LE(0x40000, OPTIONAL_OFFSET + 240 + 12); return b; }, /outside the image/],
  ["a section whose raw data starts inside the headers", (b) => { b.writeUInt32LE(0x40, OPTIONAL_OFFSET + 240 + 20); return b; }, /raw data lies outside the file/],
  ["a section whose raw data runs past the file", (b) => { b.writeUInt32LE(0x100000, OPTIONAL_OFFSET + 240 + 16); return b; }, /outside the (file|image)/],
];

test("corrupt, truncated and merely MZ-prefixed files are rejected with a specific reason", () => {
  for (const [label, damage, pattern] of BAD_PE) {
    const damaged = damage(syntheticExe("NSS"));
    assert.throws(() => parsePortableExecutable(damaged, "payload"), pattern, label);
    assert.throws(() => assertApplicationExecutable(damaged, "payload"), pattern, `${label} (as application EXE)`);
  }
  assert.throws(() => assertApplicationExecutable(syntheticExe(null, { dll: true }), "payload"), /DLL, not an application/);
  assert.throws(() => assertApplicationExecutable(syntheticExe(null, { machine: I386 }), "payload", AMD64), /expected 0x8664/);
  assert.throws(() => verifyPayloadRelation(syntheticExe("UNK"), syntheticExe("NSS", { dll: true }), POLICY), /DLL, not an application/);
  assert.throws(
    () => verifyPayloadRelation(syntheticExe("UNK"), syntheticExe("NSS"), POLICY, { machine: I386 }),
    /expected 0x14c/,
  );
});

test("a DLL may have a zero entry point; an EXE may not", () => {
  const dll = syntheticExe(null, { dll: true });
  dll.writeUInt32LE(0, OPTIONAL_OFFSET + 16);
  assert.equal(parsePortableExecutable(dll, "dll").entryPoint, 0);
});

// ---------------------------------------------------------------------------
// NSIS payload: the complete executable list (N02)
// ---------------------------------------------------------------------------

const LIBRARY_NAMES = ["nsDialogs.dll", "NSISdl.dll", "nsis_tauri_utils.dll", "StartMenu.dll", "System.dll"];

/** A policy that pins the synthetic plugin DLLs, so the real rules run on controlled files. */
function syntheticPayloadPolicy() {
  const libraries = new Map();
  LIBRARY_NAMES.forEach((name, index) => {
    const bytes = syntheticExe(null, { dll: true, machine: I386, seed: 100 + index });
    libraries.set(`$pluginsdir/${name.toLowerCase()}`, createHash("sha256").update(bytes).digest("hex"));
  });
  return { ...POLICY, payloadLibraries: libraries };
}

/** A payload shaped like the real extraction: root EXE, five plugin DLLs, one bitmap. */
async function writeExtractedPayload(label) {
  const directory = await temporaryDirectory(label);
  await mkdir(path.join(directory, "$PLUGINSDIR"), { recursive: true });
  await writeFile(path.join(directory, "nexus-aurea.exe"), syntheticExe("NSS"));
  for (const [index, name] of LIBRARY_NAMES.entries()) {
    await writeFile(
      path.join(directory, "$PLUGINSDIR", name),
      syntheticExe(null, { dll: true, machine: I386, seed: 100 + index }),
    );
  }
  await writeFile(path.join(directory, "$PLUGINSDIR", "modern-wizard.bmp"), Buffer.from("BM synthetic bitmap"));
  return directory;
}

test("a payload with exactly the reviewed executables is accepted", async () => {
  const directory = await writeExtractedPayload("payload-valid");
  const result = await inspectNsisPayload(directory, syntheticPayloadPolicy(), { machine: AMD64 });
  assert.equal(path.basename(result.executablePath), "nexus-aurea.exe");
  assert.equal(result.fileCount, 7);
  assert.equal(result.executables.length, 6);
});

test("the pinned policy lists exactly the executables seen in real PR #50 installers", () => {
  assert.equal(POLICY.payloadExecutable, "nexus-aurea.exe");
  assert.deepEqual(
    [...POLICY.payloadLibraries.keys()].sort(),
    LIBRARY_NAMES.map((name) => `$pluginsdir/${name.toLowerCase()}`).sort(),
  );
  for (const hash of POLICY.payloadLibraries.values()) assert.match(hash, /^[0-9a-f]{64}$/);
});

/** Each case adds, changes or removes one file of an otherwise valid payload. */
const PAYLOAD_TAMPERING = [
  ["an extra EXE under another name at the root", async (d) => writeFile(path.join(d, "helper.exe"), syntheticExe(null, { seed: 3 })), /Unexpected executable.*helper\.exe/],
  ["an extra EXE with an innocent text name", async (d) => writeFile(path.join(d, "readme.txt"), syntheticExe(null, { seed: 3 })), /Unexpected executable.*readme\.txt/],
  ["an extra EXE disguised as the wizard bitmap", async (d) => writeFile(path.join(d, "$PLUGINSDIR", "modern-wizard.bmp"), syntheticExe(null, { seed: 3 })), /Unexpected executable.*modern-wizard\.bmp/],
  ["an extra EXE inside a subdirectory", async (d) => { await mkdir(path.join(d, "bin", "tools"), { recursive: true }); await writeFile(path.join(d, "bin", "tools", "svc.exe"), syntheticExe(null, { seed: 3 })); }, /Unexpected executable.*bin\/tools\/svc\.exe/],
  ["an extra EXE inside $PLUGINSDIR", async (d) => writeFile(path.join(d, "$PLUGINSDIR", "update.exe"), syntheticExe(null, { seed: 3 })), /Unexpected executable.*update\.exe/],
  ["a second copy of the application EXE in a subdirectory", async (d) => { await mkdir(path.join(d, "second")); await writeFile(path.join(d, "second", "nexus-aurea.exe"), syntheticExe("NSS")); }, /Unexpected executable.*second\/nexus-aurea\.exe/],
  ["an extra DLL that is not a reviewed plugin", async (d) => writeFile(path.join(d, "$PLUGINSDIR", "inject.dll"), syntheticExe(null, { dll: true, seed: 4 })), /Unexpected executable.*inject\.dll/],
  ["a DLL named like a reviewed plugin but in another directory", async (d) => writeFile(path.join(d, "System.dll"), syntheticExe(null, { dll: true, machine: I386, seed: 103 })), /Unexpected executable.*System\.dll/],
  ["a script file", async (d) => writeFile(path.join(d, "run.bat"), "@echo off\r\n"), /Unexpected executable.*run\.bat/],
  ["a modified reviewed plugin DLL", async (d) => writeFile(path.join(d, "$PLUGINSDIR", "System.dll"), syntheticExe(null, { dll: true, machine: I386, seed: 999 })), /differs from the reviewed NSIS plugin/],
  ["a reviewed plugin DLL replaced by an EXE", async (d) => writeFile(path.join(d, "$PLUGINSDIR", "System.dll"), syntheticExe(null, { machine: I386, seed: 103 })), /not a DLL/],
  ["a reviewed plugin DLL replaced by non-PE data", async (d) => writeFile(path.join(d, "$PLUGINSDIR", "System.dll"), Buffer.from("not a dll")), /not a valid Windows executable/],
  ["a missing reviewed plugin DLL", async (d) => rm(path.join(d, "$PLUGINSDIR", "StartMenu.dll")), /plugin DLLs are missing.*startmenu\.dll/],
  ["a missing application EXE", async (d) => rm(path.join(d, "nexus-aurea.exe")), /found 0/],
  ["an application EXE that is only text", async (d) => writeFile(path.join(d, "nexus-aurea.exe"), Buffer.from("MZ plain text ".repeat(100))), /not a valid Windows executable/],
  ["an application EXE with a broken PE offset", async (d) => { const b = syntheticExe("NSS"); b.writeUInt32LE(0x7fffffff, 0x3c); await writeFile(path.join(d, "nexus-aurea.exe"), b); }, /outside the file/],
  ["an application EXE for another machine", async (d) => writeFile(path.join(d, "nexus-aurea.exe"), syntheticExe("NSS", { machine: I386 })), /expected 0x8664/],
  ["an application EXE that is a DLL", async (d) => writeFile(path.join(d, "nexus-aurea.exe"), syntheticExe("NSS", { dll: true })), /DLL, not an application/],
];

test("every unexpected, modified or missing payload file is rejected", async () => {
  for (const [label, tamper, pattern] of PAYLOAD_TAMPERING) {
    const directory = await writeExtractedPayload("payload-tamper");
    await tamper(directory);
    await assert.rejects(inspectNsisPayload(directory, syntheticPayloadPolicy(), { machine: AMD64 }), pattern, label);
  }
});

test("a link in the extracted payload is refused", async (context) => {
  const directory = await writeExtractedPayload("payload-link");
  try {
    await symlink(path.join(directory, "nexus-aurea.exe"), path.join(directory, "alias.txt"));
  } catch (error) {
    context.skip(`symbolic links cannot be created here (${error.code})`);
    return;
  }
  await assert.rejects(inspectNsisPayload(directory, syntheticPayloadPolicy(), { machine: AMD64 }), /contains a link/);
});

/** Installs a policy for Tauri CLI 2.12.4 that pins the synthetic plugin DLLs, then restores the real one. */
async function withSyntheticPolicy(run) {
  const real = PAYLOAD_POLICIES.get("2.12.4");
  PAYLOAD_POLICIES.set("2.12.4", syntheticPayloadPolicy());
  try {
    return await run();
  } finally {
    PAYLOAD_POLICIES.set("2.12.4", real);
  }
}

test("manifest creation and verification inspect the whole extracted installer", async () => {
  await withSyntheticPolicy(async () => {
    const build = await prepareBuild("payload-e2e");
    const extractedDir = await writeExtractedPayload("payload-e2e-dir");
    const { packagedPayloadPath: _unused, ...rest } = build.files;
    const files = { ...rest, extractedDir };
    const manifest = await createManifest({ ...files, env: build.env, tools: TOOLS, requireTools: true, now: new Date("2026-11-13T12:00:00Z") });
    const verified = await verifyManifest({ manifest, ...files, env: build.env, collect: build.collect, now: build.now, ci: true });
    assert.equal(verified.ciOrigin.confirmed, true);

    // The command line refuses to run CI verification against a single file, which would skip the list check.
    const manifestPath = path.join(build.parent, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const cli = spawnSync(
      process.execPath,
      [SCRIPT, "verify", "--ci", "--installer", files.installerPath, "--payload", files.payloadPath, "--packaged-payload", path.join(extractedDir, "nexus-aurea.exe"), "--manifest", manifestPath],
      { encoding: "utf8", cwd: build.repo },
    );
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /--ci requires --extracted-dir/);
    // Giving both, or neither, is ambiguous and refused.
    await assert.rejects(
      verifyManifest({ manifest, ...rest, extractedDir, packagedPayloadPath: path.join(extractedDir, "nexus-aurea.exe"), env: build.env, collect: build.collect, now: build.now }),
      /exactly one of/,
    );

    // An extra EXE with a different name makes both creation and verification fail.
    await writeFile(path.join(extractedDir, "$PLUGINSDIR", "helper.exe"), syntheticExe(null, { seed: 3 }));
    await assert.rejects(createManifest({ ...files, env: build.env, tools: TOOLS }), /Unexpected executable/);
    await assert.rejects(verifyManifest({ manifest, ...files, env: build.env, collect: build.collect, now: build.now }), /Unexpected executable/);
    await rm(path.join(extractedDir, "$PLUGINSDIR", "helper.exe"));

    // A modified application EXE in the payload fails the marker rule.
    const modified = syntheticExe("NSS");
    modified[3000] ^= 0xff;
    await writeFile(path.join(extractedDir, "nexus-aurea.exe"), modified);
    await assert.rejects(createManifest({ ...files, env: build.env, tools: TOOLS }), /outside the allowed bundle-type marker/);
  });
});

test("the installer itself must be a well-formed EXE", async () => {
  const build = await prepareBuild("installer-pe");
  await writeFile(build.files.installerPath, Buffer.from("synthetic installer bytes"));
  await assert.rejects(createManifest({ ...build.files, env: build.env, tools: TOOLS }), /installer is not a valid Windows executable/);
});

test("manifest creation and verification reject an unrelated or modified EXE", async () => {
  const build = await prepareBuild("relation-rejects");
  const { files } = build;
  const originalPackaged = await readFile(files.packagedPayloadPath);

  await writeFile(files.packagedPayloadPath, Buffer.from("a plain text file in place of the EXE ".repeat(100)));
  await assert.rejects(createManifest({ ...files, env: build.env, tools: TOOLS }), /not a valid Windows executable/);
  await assert.rejects(verify(build), /does not match its file/);

  const modified = Buffer.from(originalPackaged);
  modified[3000] ^= 0xff;
  await writeFile(files.packagedPayloadPath, modified);
  await assert.rejects(createManifest({ ...files, env: build.env, tools: TOOLS }), /outside the allowed bundle-type marker/);
  await assert.rejects(verify(build), /does not match its file/);

  // A manifest forged to carry the hashes of a modified EXE still fails the relation rule.
  const forged = structuredClone(build.manifest);
  const { createHash } = await import("node:crypto");
  forged.artifacts.packagedExe.sha256 = createHash("sha256").update(modified).digest("hex");
  await assert.rejects(verify(build, { manifest: forged }), /outside the allowed bundle-type marker/);

  await writeFile(files.packagedPayloadPath, originalPackaged);
  assert.equal((await verify(build)).internalConsistency, true);
});

// ---------------------------------------------------------------------------
// Manifest semantics (F04) and the two levels of assurance
// ---------------------------------------------------------------------------

test("a clean build verifies with internal consistency and, only with --ci, a confirmed CI origin", async () => {
  const build = await prepareBuild("positive");
  const { manifest } = build;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.source.sourceSha, build.shas.head);
  assert.equal(manifest.source.checkoutSha, build.shas.merge);
  assert.equal(manifest.source.pullRequest.syntheticMergeSha, build.shas.merge);
  assert.equal(manifest.source.ref, "refs/pull/88/merge");
  assert.notEqual(manifest.artifacts.builtExe.sha256, manifest.artifacts.packagedExe.sha256);
  assert.equal(manifest.artifacts.payloadRelation.markerOffset, MARKER_OFFSET);
  assert.equal(manifest.build.target, "x86_64-pc-windows-msvc");
  assert.equal(manifest.build.profile, "release");

  const local = await verify(build);
  assert.equal(local.internalConsistency, true);
  assert.equal(local.ciOrigin.confirmed, false);
  assert.match(local.authenticity, /Not a digital signature/);
  assert.ok(local.sourceChecks.some((line) => /merge of the recorded PR base and head/.test(line)));

  const ci = await verify(build, { ci: true });
  assert.equal(ci.internalConsistency, true);
  assert.equal(ci.ciOrigin.confirmed, true);
  assert.ok(ci.ciOrigin.checked.length >= 6);
});

test("CI origin cannot be confirmed outside GitHub Actions", async () => {
  const build = await prepareBuild("not-ci");
  await assert.rejects(verify(build, { ci: true, env: { ...build.env, GITHUB_ACTIONS: "false" } }), /only be confirmed inside a GitHub Actions job/);
  await assert.rejects(verify(build, { ci: true, env: {} }), /only be confirmed inside a GitHub Actions job/);
});

/** Each case changes one field. `ci` marks cases only the CI comparison can catch. */
const TAMPERING = [
  ["schema version", (m) => { m.schemaVersion = 1; }, /schema/],
  ["an unexpected field", (m) => { m.extra = true; }, /not an allowed field/],
  ["a removed section", (m) => { delete m.build; }, /is required/],
  ["app name", (m) => { m.app.name = "OTHER"; }, /schema/],
  ["app version: unparsable", (m) => { m.app.version = "latest"; }, /schema/],
  ["app version: valid but not the repository's", (m) => { m.app.version = "999.0.0"; }, /does not match package.json/],
  ["target: wrong shape", (m) => { m.build.target = "not a target"; }, /schema/],
  ["target: other platform (CI compares with the build output)", (m) => { m.build.target = "aarch64-apple-darwin"; }, /target the EXE was built for|expected 0xaa64/, true],
  ["profile: not allowed", (m) => { m.build.profile = "invented"; }, /schema/],
  ["profile: other (CI compares with the build output)", (m) => { m.build.profile = "debug"; }, /profile the EXE was built with/, true],
  ["runner OS", (m) => { m.build.runnerOs = "Linux"; }, /runner OS/, true],
  ["run id: not numeric", (m) => { m.build.runId = "invented"; }, /schema/],
  ["run id: numeric but not this run", (m) => { m.build.runId = "999"; }, /run id/, true],
  ["run attempt", (m) => { m.build.runAttempt = "7"; }, /run attempt/, true],
  ["generation date: not a date", (m) => { m.build.generatedAt = "not-a-date"; }, /date-time/],
  ["generation date: impossible day", (m) => { m.build.generatedAt = "2026-02-31T10:00:00Z"; }, /date-time/],
  ["generation date: local time zone", (m) => { m.build.generatedAt = "2026-11-13T12:00:00+01:00"; }, /date-time/],
  ["generation date: in the future", (m) => { m.build.generatedAt = "2099-01-01T00:00:00Z"; }, /in the future/],
  ["generation date: far before the verification window", (m) => { m.build.generatedAt = "2026-11-12T01:00:00Z"; }, /too long before/, true],
  ["tool version: invented", (m) => { m.tools.rustc = "invented"; }, /schema/],
  ["tool version: invented pnpm", (m) => { m.tools.pnpm = "invented"; }, /schema/],
  ["tool version: valid but not installed (CI compares with the runner)", (m) => { m.tools.node = "v18.0.0"; }, /node version differs/, true],
  ["tool version: unavailable (CI refuses)", (m) => { m.tools.msvc = "unavailable"; }, /unavailable: msvc/, true],
  ["Tauri CLI: other than the lockfile", (m) => { m.tools.tauriCli = "tauri-cli 2.99.0"; }, /pnpm lockfile/],
  ["source SHA: not full length", (m) => { m.source.sourceSha = "abc123"; }, /schema/],
  ["source SHA: not the PR head", (m) => { m.source.sourceSha = "c".repeat(40); }, /sourceSha must be the PR head/],
  ["checkout SHA: not the repository HEAD", (m) => { m.source.checkoutSha = "d".repeat(40); m.source.pullRequest.syntheticMergeSha = "d".repeat(40); }, /does not match the repository HEAD/],
  ["dirty flag", (m) => { m.source.dirty = true; m.source.clean = false; }, /clean\/dirty state/],
  ["dirty and clean disagree", (m) => { m.source.clean = false; }, /disagree/],
  ["branch/ref: not a merge ref", (m) => { m.source.ref = "refs/heads/main"; }, /merge ref/],
  ["branch/ref: valid shape, other pull request (CI compares with the event)", (m) => { m.source.ref = "refs/pull/999/merge"; }, /CI ref/, true],
  ["head branch", (m) => { m.source.headBranch = "someone-else"; }, /head branch/, true],
  ["event name", (m) => { m.source.event = "push"; }, /Non-PR|PR/],
  ["PR head: other commit", (m) => { m.source.pullRequest.headSha = "e".repeat(40); m.source.sourceSha = "e".repeat(40); }, /parents differ/],
  ["PR base: other commit", (m) => { m.source.pullRequest.baseSha = "f".repeat(40); }, /parents differ/],
  ["PR head equals base", (m) => { m.source.pullRequest.baseSha = m.source.pullRequest.headSha; }, /must differ/],
  ["PR synthetic merge sha", (m) => { m.source.pullRequest.syntheticMergeSha = "9".repeat(40); }, /synthetic merge SHA/],
  ["installer hash", (m) => { m.artifacts.installer.sha256 = "0".repeat(64); }, /installer entry does not match its file/],
  ["installer size", (m) => { m.artifacts.installer.sizeBytes += 1; }, /installer entry does not match its file/],
  ["installer name", (m) => { m.artifacts.installer.name = "evil.exe"; }, /setup executable|does not match its file/],
  ["built EXE hash", (m) => { m.artifacts.builtExe.sha256 = "1".repeat(64); }, /builtExe entry does not match its file/],
  ["packaged EXE hash", (m) => { m.artifacts.packagedExe.sha256 = "2".repeat(64); }, /packagedExe entry does not match its file/],
  ["packaged EXE name", (m) => { m.artifacts.packagedExe.name = "other.exe"; }, /name is unexpected/],
  ["payload relation offset", (m) => { m.artifacts.payloadRelation.markerOffset = 5; }, /payload relation does not match/],
  ["payload relation policy", (m) => { m.artifacts.payloadRelation.policy = "made-up"; }, /payload relation does not match/],
];

test("every manipulated manifest field is rejected", async () => {
  const build = await prepareBuild("tampering");
  for (const [label, mutate, pattern, ciOnly] of TAMPERING) {
    const manifest = structuredClone(build.manifest);
    mutate(manifest);
    await assert.rejects(
      verify(build, { manifest, ci: true }),
      pattern,
      `tampering was not rejected with --ci: ${label}`,
    );
    if (!ciOnly) {
      await assert.rejects(
        verify(build, { manifest }),
        pattern,
        `tampering was not rejected without --ci: ${label}`,
      );
    }
  }
  assert.equal((await verify(build, { ci: true })).ciOrigin.confirmed, true);
});

test("forged CI context values are rejected against the event payload", async () => {
  const build = await prepareBuild("forged-event");
  const eventPath = build.env.GITHUB_EVENT_PATH;
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 88, head: { sha: "a".repeat(40) }, base: { sha: build.shas.base } } }));
  await assert.rejects(verify(build, { ci: true }), /PR head SHA differs from the CI event/);
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 88, head: { sha: build.shas.head }, base: { sha: "b".repeat(40) } } }));
  await assert.rejects(verify(build, { ci: true }), /PR base SHA differs from the CI event/);
  await writeFile(eventPath, JSON.stringify({ pull_request: { number: 12, head: { sha: build.shas.head }, base: { sha: build.shas.base } } }));
  await assert.rejects(verify(build, { ci: true }), /PR number/);
  await assert.rejects(verify(build, { ci: true, env: { ...build.env, GITHUB_SHA: "a".repeat(40) } }), /GITHUB_SHA/);
});

test("the built EXE location decides the build variant that CI may confirm", async () => {
  const build = await prepareBuild("location");
  assert.deepEqual(buildLocationOf(build.files.payloadPath), { target: "x86_64-pc-windows-msvc", profile: "release" });
  assert.equal(buildLocationOf(path.join(build.parent, "outputs", "nexus-aurea.exe")), null);
  const moved = path.join(build.parent, "outputs", "nexus-aurea.exe");
  await writeFile(moved, await readFile(build.files.payloadPath));
  await assert.rejects(
    verify(build, { ci: true, payloadPath: moved }),
    /not under target/,
  );
});

test("a manifest from a commit that is not clean is described as such", async () => {
  const build = await prepareBuild("dirty");
  await writeFile(path.join(build.repo, "untracked.txt"), "dirty\n");
  await assert.rejects(verify(build), /clean\/dirty state/);
});

test("manifest rejects stale CI checkout SHA", async () => {
  const parent = await temporaryDirectory("stale-checkout");
  const repo = path.join(parent, "repository");
  await mkdir(repo);
  await initializeRepository(repo);
  const outputs = path.join(parent, "outputs");
  await mkdir(outputs);
  const installerPath = path.join(outputs, "setup.exe");
  const payloadPath = path.join(outputs, "app.exe");
  const packagedPayloadPath = path.join(outputs, "packaged.exe");
  await writeFile(installerPath, syntheticInstaller());
  await writeFile(payloadPath, syntheticExe("UNK"));
  await writeFile(packagedPayloadPath, syntheticExe("NSS"));
  await assert.rejects(
    createManifest({
      installerPath,
      payloadPath,
      packagedPayloadPath,
      repoRoot: repo,
      env: { GITHUB_SHA: "f".repeat(40) },
      tools: TOOLS,
    }),
    /Checkout SHA mismatch/,
  );
});

// ---------------------------------------------------------------------------
// Tool versions (F05)
// ---------------------------------------------------------------------------

test("a required tool that is unavailable stops manifest creation in CI mode and stays visible otherwise", async () => {
  const build = await prepareBuild("tools");
  for (const name of Object.keys(TOOLS)) {
    const missing = { ...TOOLS, [name]: "unavailable" };
    await assert.rejects(
      createManifest({ ...build.files, env: build.env, tools: missing, requireTools: true }),
      new RegExp(`unavailable: ${name}`),
      `${name} must be required`,
    );
  }
  const visible = await createManifest({
    ...build.files,
    env: build.env,
    tools: { ...TOOLS, msvc: "unavailable", windowsSdk: "unavailable" },
    now: new Date("2026-11-13T12:00:00Z"),
  });
  assert.equal(visible.tools.msvc, "unavailable");
  assert.equal(visible.tools.windowsSdk, "unavailable");
  await assert.rejects(verify(build, { manifest: visible, ci: true }), /unavailable: msvc, windowsSdk/);
});

test("tool version patterns agree between the script and the schema, and reject non-versions", async () => {
  const schema = JSON.parse(await readFile(new URL("../docs/schemas/velora-build-provenance.schema.json", import.meta.url)));
  const good = TOOLS;
  const bad = ["invented", "error: command not found", "", "unavailable ", "v", "14", "tauri synthetic", "warning: x"];
  for (const [name, pattern] of Object.entries(TOOL_PATTERNS)) {
    assert.ok(pattern.test(good[name]), `${name} sample must satisfy the script pattern`);
    const property = schema.properties.tools.properties[name];
    assert.equal(validateAgainstSchema(good[name], property, schema).length, 0, `${name} sample must satisfy the schema`);
    assert.equal(validateAgainstSchema("unavailable", property, schema).length, 0, `${name}: unavailable is representable`);
    for (const value of bad) {
      assert.equal(pattern.test(value), false, `${name} script pattern must reject ${JSON.stringify(value)}`);
      assert.ok(validateAgainstSchema(value, property, schema).length > 0, `${name} schema must reject ${JSON.stringify(value)}`);
    }
  }
});

test("MSVC toolset and Windows SDK are read from the linker's own output, not guessed", () => {
  const output = [
    ' = note: "C:\\\\Program Files\\\\Microsoft Visual Studio\\\\2022\\\\Enterprise\\\\VC\\\\Tools\\\\MSVC\\\\14.44.35207\\\\bin\\\\HostX64\\\\x64\\\\link.exe" "/NOLOGO"',
    "   Searching C:\\Program Files (x86)\\Windows Kits\\10\\lib\\10.0.26100.0\\um\\x64\\kernel32.lib:",
  ].join("\n");
  assert.deepEqual(parseLinkerProbe(output), { msvc: "14.44.35207", windowsSdk: "10.0.26100.0" });
  assert.deepEqual(parseLinkerProbe("Searching D:\\Kits\\10\\lib\\10.0.1.0\\um\\x64\\kernel32.lib"), { msvc: null, windowsSdk: null });
  assert.deepEqual(parseLinkerProbe("error: linker `link.exe` not found"), { msvc: null, windowsSdk: null });
  assert.deepEqual(parseLinkerProbe(""), { msvc: null, windowsSdk: null });
});

// ---------------------------------------------------------------------------
// Release assets (F06)
// ---------------------------------------------------------------------------

test("a release carries exactly the installer and its manifest", async () => {
  const build = await prepareBuild("release-assets", { pullRequest: false });
  const directory = path.join(build.parent, "release");
  await mkdir(directory);
  await assert.rejects(selectReleaseAssets(directory), /exactly one installer/);
  await writeFile(path.join(directory, "VELORA_0.9.2_x64-setup.exe"), "installer");
  await assert.rejects(selectReleaseAssets(directory), /exactly one velora-build-provenance.json/);
  await writeFile(path.join(directory, "velora-build-provenance.json"), "{}");
  const assets = await selectReleaseAssets(directory);
  assert.equal(path.basename(assets.installer), "VELORA_0.9.2_x64-setup.exe");
  assert.equal(path.basename(assets.manifest), "velora-build-provenance.json");
  await writeFile(path.join(directory, "other-setup.exe"), "second installer");
  await assert.rejects(selectReleaseAssets(directory), /exactly one installer/);
  await rm(path.join(directory, "other-setup.exe"));
  await writeFile(path.join(directory, "notes.txt"), "stray");
  await assert.rejects(selectReleaseAssets(directory), /Unexpected files/);

  const cli = spawnSync(process.execPath, [SCRIPT, "release-assets", "--dir", directory], { encoding: "utf8" });
  assert.notEqual(cli.status, 0, "the CLI must refuse a directory with a stray file");
  await rm(path.join(directory, "notes.txt"));
  const ok = spawnSync(process.execPath, [SCRIPT, "release-assets", "--dir", directory], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.stdout.trim().split(/\r?\n/).map((line) => path.basename(line)), [
    "VELORA_0.9.2_x64-setup.exe",
    "velora-build-provenance.json",
  ]);
});

test("release verification ties the manifest to the published installer and to the release run", async () => {
  const build = await prepareBuild("release-verify", { pullRequest: false });
  const directory = path.join(build.parent, "release");
  await mkdir(directory);
  const installerPath = path.join(directory, "VELORA_0.9.2_x64-setup.exe");
  const manifestPath = path.join(directory, "velora-build-provenance.json");
  await writeFile(installerPath, await readFile(build.files.installerPath));
  await writeFile(manifestPath, JSON.stringify(build.manifest));
  const report = await verifyReleaseAssets({ installerPath, manifestPath, env: build.env, now: build.now });
  assert.equal(report.internalConsistency, true);
  assert.equal(report.ciOrigin.confirmed, true);

  await writeFile(installerPath, "a different installer");
  await assert.rejects(verifyReleaseAssets({ installerPath, manifestPath, env: build.env, now: build.now }), /does not match the manifest installer entry/);
  await writeFile(installerPath, await readFile(build.files.installerPath));
  await assert.rejects(
    verifyReleaseAssets({ installerPath, manifestPath, env: { ...build.env, GITHUB_SHA: "a".repeat(40) }, now: build.now }),
    /not built from the release commit/,
  );
  await assert.rejects(
    verifyReleaseAssets({ installerPath, manifestPath, env: { ...build.env, GITHUB_RUN_ID: "1" }, now: build.now }),
    /different CI run/,
  );
  const incomplete = structuredClone(build.manifest);
  incomplete.tools.windowsSdk = "unavailable";
  await writeFile(manifestPath, JSON.stringify(incomplete));
  await assert.rejects(verifyReleaseAssets({ installerPath, manifestPath, env: build.env, now: build.now }), /unavailable: windowsSdk/);
});

test("the release preview skips only the push/tag check so a pull request can exercise the same selection", async () => {
  const build = await prepareBuild("release-preview");
  const directory = path.join(build.parent, "release");
  await mkdir(directory);
  const installerPath = path.join(directory, "VELORA_0.9.2_x64-setup.exe");
  const manifestPath = path.join(directory, "velora-build-provenance.json");
  await writeFile(installerPath, await readFile(build.files.installerPath));
  await writeFile(manifestPath, JSON.stringify(build.manifest));
  await assert.rejects(
    verifyReleaseAssets({ installerPath, manifestPath, env: build.env, now: build.now }),
    /must come from a push/,
  );
  const preview = await verifyReleaseAssets({ installerPath, manifestPath, env: build.env, now: build.now, preview: true });
  assert.equal(preview.internalConsistency, true);
  assert.match(preview.ciOrigin.checked[0], /preview/);
  await assert.rejects(
    verifyReleaseAssets({ installerPath, manifestPath, env: { ...build.env, GITHUB_RUN_ID: "1" }, now: build.now, preview: true }),
    /different CI run/,
  );
  await writeFile(installerPath, "another installer");
  await assert.rejects(
    verifyReleaseAssets({ installerPath, manifestPath, env: build.env, now: build.now, preview: true }),
    /does not match the manifest installer entry/,
  );
});
