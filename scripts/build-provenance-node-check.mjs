import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  PAYLOAD_POLICIES,
  TOOL_PATTERNS,
  buildLocationOf,
  createManifest,
  findSinglePackagedExecutable,
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

/** A synthetic "PE": MZ header, deterministic filler and one bundle-type marker. */
function syntheticExe(tag = "UNK", { size = 4096, markerOffset = MARKER_OFFSET, extraMarkers = [], seed = 7 } = {}) {
  const bytes = Buffer.alloc(size);
  let state = seed;
  for (let index = 0; index < size; index += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = 0x30 + (state % 40); // printable, never contains the marker prefix
  }
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  if (tag) bytes.write(`${MARKER}${tag}`, markerOffset, "ascii");
  extraMarkers.forEach(([offset, extraTag]) => bytes.write(`${MARKER}${extraTag}`, offset, "ascii"));
  return bytes;
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
  await writeFile(installerPath, Buffer.from("synthetic installer bytes"));
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

  rejects("a text file as the built EXE", Buffer.from("this is only text, not an executable ".repeat(200)), packaged, /not a Windows executable/);
  rejects("a text file as the packaged EXE", built, Buffer.from("this is only text, not an executable ".repeat(200)), /not a Windows executable/);
  rejects("a different EXE with the same marker rule", syntheticExe("UNK", { seed: 99 }), packaged, /outside the allowed bundle-type marker/);

  const modifiedCode = Buffer.from(packaged);
  modifiedCode[2000] ^= 0xff;
  rejects("a modified byte in the code", built, modifiedCode, /outside the allowed bundle-type marker/);
  const modifiedResource = Buffer.from(built);
  modifiedResource[4000] ^= 0x01;
  rejects("a modified byte at the very end", modifiedResource, packaged, /outside the allowed bundle-type marker/);

  rejects("a truncated payload", built, packaged.subarray(0, 4000), /differ in size/);
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

test("exactly one packaged EXE must exist in the extracted installer", async () => {
  const parent = await temporaryDirectory("extraction");
  await mkdir(path.join(parent, "$PLUGINSDIR"), { recursive: true });
  await assert.rejects(findSinglePackagedExecutable(parent), /found 0/);
  await writeFile(path.join(parent, "nexus-aurea.exe"), syntheticExe("NSS"));
  assert.equal(path.basename(await findSinglePackagedExecutable(parent)), "nexus-aurea.exe");
  await mkdir(path.join(parent, "second"), { recursive: true });
  await writeFile(path.join(parent, "second", "NEXUS-AUREA.EXE"), syntheticExe("NSS"));
  await assert.rejects(findSinglePackagedExecutable(parent), /found 2/);
});

test("manifest creation and verification reject an unrelated or modified EXE", async () => {
  const build = await prepareBuild("relation-rejects");
  const { files } = build;
  const originalPackaged = await readFile(files.packagedPayloadPath);

  await writeFile(files.packagedPayloadPath, Buffer.from("a plain text file in place of the EXE ".repeat(100)));
  await assert.rejects(createManifest({ ...files, env: build.env, tools: TOOLS }), /not a Windows executable/);
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
  ["target: other platform (CI compares with the build output)", (m) => { m.build.target = "aarch64-apple-darwin"; }, /target the EXE was built for/, true],
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
  await writeFile(installerPath, "installer");
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
