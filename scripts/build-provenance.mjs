// Build provenance for the unsigned VELORA Windows installer.
//
// What a manifest can and cannot prove (see docs/velora-s0b-build-provenance.md):
//
// * INTERNAL CONSISTENCY: the manifest matches its JSON schema, its fields agree
//   with each other, the installer / built EXE / packaged EXE files on disk match
//   the recorded size and SHA-256, the packaged EXE is related to the built EXE by
//   exactly the one transformation the pinned Tauri bundler is known to apply, and
//   the manifest agrees with the checkout it is verified in (Git HEAD, dirty state,
//   merge parents, app version, pinned Tauri CLI).
// * CI ORIGIN: only when verification runs with `--ci` inside the GitHub Actions
//   job is the manifest compared with the context GitHub gave that job (event
//   payload, ref, SHA, run id) and with the tools actually installed on the runner.
//   This is the CI runner's own assertion about itself.
//
// Hashes and the manifest are NOT a digital signature and NOT cryptographic proof
// of authenticity: anyone who controls the workflow, the runner or the artifact
// store can produce a manifest that passes. A future signature or artifact
// attestation is a separate decision.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA_VERSION = 2;
export const MANIFEST_FILE_NAME = "velora-build-provenance.json";
const SCHEMA_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../docs/schemas/velora-build-provenance.schema.json",
);

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_TOOLS = ["node", "pnpm", "rustc", "cargo", "tauriCli", "msvc", "windowsSdk"];
const UNAVAILABLE = "unavailable";
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_CI_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** What each recorded tool version must look like. Matches the schema. */
export const TOOL_PATTERNS = {
  node: /^v\d+\.\d+\.\d+$/,
  pnpm: /^\d+\.\d+\.\d+$/,
  rustc: /^rustc \d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)? /,
  cargo: /^cargo \d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)? /,
  tauriCli: /^tauri-cli \d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/,
  msvc: /^\d+\.\d+\.\d+(?:\.\d+)?$/,
  windowsSdk: /^10\.\d+\.\d+\.\d+$/,
};

/**
 * The exact build-to-payload transformation allowed per Tauri CLI version.
 *
 * For the unsigned NSIS bundle, the pinned CLI patches one bundle-type marker in
 * the built EXE (`..._UNK` -> `..._NSS`, same length) before handing the EXE to
 * makensis, then restores the original input file. Nothing else may differ.
 * A different bundler version, a signed build, or another bundle type needs a new
 * reviewed entry here; the verifier never accepts an unlisted version.
 */
export const PAYLOAD_POLICIES = new Map([
  [
    "2.12.4",
    {
      id: "tauri-cli-2.12.4-nsis-unsigned",
      markerPrefix: "__TAURI_BUNDLE_TYPE_VAR_",
      builtTag: "UNK",
      packagedTag: "NSS",
    },
  ],
]);

function runGit(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

export function inspectSource(directory) {
  const root = runGit(directory, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    return { repositoryRoot: null, checkoutSha: null, branch: null, dirty: null, parents: null };
  }
  const checkoutSha = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const branch = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const dirty = status.error || status.status !== 0 ? null : status.stdout.length > 0;
  const revList = runGit(root, ["rev-list", "--parents", "-n", "1", "HEAD"]);
  const parents = revList ? revList.split(/\s+/).slice(1) : null;
  return {
    repositoryRoot: root,
    checkoutSha: checkoutSha && FULL_SHA.test(checkoutSha) ? checkoutSha : null,
    branch: branch || null,
    dirty,
    parents,
  };
}

// ---------------------------------------------------------------------------
// Tool versions
// ---------------------------------------------------------------------------

/**
 * Runs a fixed command line and returns its trimmed stdout, or null. Only a
 * zero exit status with output on stdout counts; stderr is never a version.
 * `shell` is needed for the pnpm shim on Windows; every command string here is a
 * constant and no input is interpolated.
 */
function runTool(commandLine, { shell = false, args = [], env, cwd } = {}) {
  const result = spawnSync(commandLine, args, {
    encoding: "utf8",
    windowsHide: true,
    shell,
    env,
    cwd,
    timeout: 60_000,
  });
  if (result.error || result.status !== 0) return null;
  const line = (result.stdout || "").trim().split(/\r?\n/, 1)[0].trim();
  return line || null;
}

function accepted(name, value) {
  return value && TOOL_PATTERNS[name].test(value) ? value : UNAVAILABLE;
}

/**
 * The linker rustc really uses and the Windows SDK it really searches: a tiny
 * probe program with a deliberate unresolved symbol is linked with
 * `/VERBOSE:LIB`; the failing link prints the `link.exe` path (MSVC toolset
 * version) and the `kernel32.lib` it found (Windows SDK version). Nothing is
 * guessed from "the newest version installed" or from variables that the build
 * does not read.
 */
export function parseLinkerProbe(output) {
  const msvc = /MSVC[\\/]+(\d+\.\d+\.\d+(?:\.\d+)?)[\\/]+bin[\\/]/i.exec(output)?.[1];
  const sdk = /Windows Kits[\\/]+10[\\/]+Lib[\\/]+(10\.\d+\.\d+\.\d+)[\\/]+um[\\/]/i.exec(output)?.[1];
  return { msvc: msvc || null, windowsSdk: sdk || null };
}

async function probeMsvcToolchain(target, env) {
  if (!target.endsWith("-msvc")) return { msvc: null, windowsSdk: null };
  const directory = await mkdtemp(path.join(os.tmpdir(), "velora-linker-probe-"));
  try {
    const source = path.join(directory, "probe.rs");
    await writeFile(
      source,
      'extern "C" { fn velora_probe_unresolved_symbol(); }\nfn main() { unsafe { velora_probe_unresolved_symbol() } }\n',
    );
    const result = spawnSync(
      "rustc",
      ["--target", target, "-C", "link-arg=/VERBOSE:LIB", "-o", path.join(directory, "probe.exe"), source],
      { encoding: "utf8", windowsHide: true, env, timeout: 120_000 },
    );
    if (result.error) return { msvc: null, windowsSdk: null };
    return parseLinkerProbe(`${result.stdout || ""}\n${result.stderr || ""}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Versions taken from the environment that is actually used for the build. */
export async function collectTools({ env = process.env, target, repoRoot = process.cwd() } = {}) {
  const tauriLine = runTool("pnpm exec tauri --version", { shell: true, env, cwd: repoRoot });
  const probe = await probeMsvcToolchain(target || "x86_64-pc-windows-msvc", env);
  return {
    node: accepted("node", process.version),
    pnpm: accepted("pnpm", runTool("pnpm --version", { shell: true, env, cwd: repoRoot })),
    rustc: accepted("rustc", runTool("rustc", { args: ["--version"], env })),
    cargo: accepted("cargo", runTool("cargo", { args: ["--version"], env })),
    tauriCli: accepted("tauriCli", tauriLine),
    msvc: accepted("msvc", probe.msvc),
    windowsSdk: accepted("windowsSdk", probe.windowsSdk),
  };
}

function missingTools(tools) {
  return REQUIRED_TOOLS.filter((name) => tools?.[name] === UNAVAILABLE || !tools?.[name]);
}

// ---------------------------------------------------------------------------
// Schema validation (the JSON schema file is the single source of truth)
// ---------------------------------------------------------------------------

function isIsoDateTime(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 19) === value.slice(0, 19);
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  const actual = jsonType(value);
  return actual === type || (type === "number" && actual === "integer");
}

export function validateAgainstSchema(value, schema, root = schema, pointer = "$") {
  const errors = [];
  if (schema.$ref) {
    const target = schema.$ref.startsWith("#/")
      ? schema.$ref.slice(2).split("/").reduce((node, key) => node?.[key], root)
      : null;
    if (!target) return [`${pointer}: unresolved schema reference ${schema.$ref}`];
    return validateAgainstSchema(value, target, root, pointer);
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((option) => validateAgainstSchema(value, option, root, pointer).length === 0);
    if (passing.length !== 1) errors.push(`${pointer}: does not match exactly one allowed form`);
    return errors;
  }
  if ("const" in schema && value !== schema.const) errors.push(`${pointer}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${pointer}: must be one of ${schema.enum.join(", ")}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(value, type))) {
      errors.push(`${pointer}: expected ${types.join(" or ")}, found ${jsonType(value)}`);
      return errors;
    }
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${pointer}: too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${pointer}: does not match ${schema.pattern}`);
    if (schema.format === "date-time" && !isIsoDateTime(value)) errors.push(`${pointer}: is not a valid UTC ISO-8601 date-time`);
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${pointer}: below ${schema.minimum}`);
  }
  if (jsonType(value) === "object") {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${pointer}.${key}: is required`);
    }
    for (const [key, child] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validateAgainstSchema(value[key], child, root, `${pointer}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties || {}))) errors.push(`${pointer}.${key}: is not an allowed field`);
      }
    }
  }
  return errors;
}

function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
}

export function validateManifestSchema(manifest) {
  const errors = validateAgainstSchema(manifest, loadSchema());
  assert.equal(errors.length, 0, `Manifest does not match its schema:\n${errors.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Payload relation: built EXE -> packaged EXE
// ---------------------------------------------------------------------------

function occurrences(buffer, needle) {
  const offsets = [];
  let from = 0;
  for (;;) {
    const at = buffer.indexOf(needle, from);
    if (at < 0) return offsets;
    offsets.push(at);
    from = at + 1;
  }
}

export function payloadPolicyFor(tauriCli) {
  const version = /^tauri-cli (\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/.exec(tauriCli || "")?.[1];
  const policy = version ? PAYLOAD_POLICIES.get(version) : null;
  if (!policy) {
    throw new Error(
      `No reviewed payload transformation policy for ${tauriCli || "an unknown Tauri CLI"}. ` +
        "Review the bundler's patch rule and add an entry to PAYLOAD_POLICIES; unrelated files are never accepted.",
    );
  }
  return policy;
}

/**
 * The packaged EXE must be the built EXE with exactly one bundle-type marker
 * changed in place, and nothing else. Both files are only read, never run.
 */
export function verifyPayloadRelation(builtBytes, packagedBytes, policy) {
  const prefix = Buffer.from(policy.markerPrefix);
  const builtMarker = Buffer.from(`${policy.markerPrefix}${policy.builtTag}`);
  const packagedMarker = Buffer.from(`${policy.markerPrefix}${policy.packagedTag}`);
  assert.equal(builtMarker.length, packagedMarker.length, "Policy markers must have equal length.");
  for (const [label, bytes] of [["built", builtBytes], ["packaged", packagedBytes]]) {
    assert.ok(
      bytes.length > 0x40 && bytes[0] === 0x4d && bytes[1] === 0x5a,
      `The ${label} payload is not a Windows executable (missing MZ header).`,
    );
  }
  assert.equal(
    builtBytes.length,
    packagedBytes.length,
    "Built and packaged executables differ in size; only an equal-length marker change is allowed.",
  );
  const builtPrefixes = occurrences(builtBytes, prefix);
  const packagedPrefixes = occurrences(packagedBytes, prefix);
  assert.equal(builtPrefixes.length, 1, "The built executable must contain exactly one bundle-type marker.");
  assert.equal(packagedPrefixes.length, 1, "The packaged executable must contain exactly one bundle-type marker.");
  const builtAt = occurrences(builtBytes, builtMarker);
  const packagedAt = occurrences(packagedBytes, packagedMarker);
  assert.deepEqual(builtAt, [builtPrefixes[0]], `The built executable's marker is not ${policy.markerPrefix}${policy.builtTag}.`);
  assert.deepEqual(
    packagedAt,
    [packagedPrefixes[0]],
    `The packaged executable's marker is not ${policy.markerPrefix}${policy.packagedTag}.`,
  );
  const offset = builtAt[0];
  assert.equal(packagedAt[0], offset, "The bundle-type marker moved between the built and packaged executables.");
  const end = offset + builtMarker.length;
  assert.ok(
    builtBytes.subarray(0, offset).equals(packagedBytes.subarray(0, offset)) &&
      builtBytes.subarray(end).equals(packagedBytes.subarray(end)),
    "The packaged executable differs from the built executable outside the allowed bundle-type marker.",
  );
  return {
    policy: policy.id,
    transformation: `${policy.markerPrefix}${policy.builtTag}->${policy.markerPrefix}${policy.packagedTag}`,
    markerOffset: offset,
  };
}

/** Exactly one packaged EXE may exist in an extracted installer. */
export async function findSinglePackagedExecutable(directory, name = "nexus-aurea.exe") {
  const matches = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === name) matches.push(full);
    }
  }
  await walk(directory);
  assert.equal(matches.length, 1, `Expected exactly one packaged ${name} in the extraction; found ${matches.length}.`);
  return matches[0];
}

// ---------------------------------------------------------------------------
// Manifest creation
// ---------------------------------------------------------------------------

function readPullRequestEvent(env) {
  if (env.GITHUB_EVENT_PATH) {
    try {
      return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    } catch {
      throw new Error("Could not read the GitHub event payload for build provenance.");
    }
  }
  return null;
}

function validOptionalSha(value, label) {
  if (value == null || value === "") return null;
  if (!FULL_SHA.test(value)) throw new Error(`${label} must be a full Git commit SHA.`);
  return value;
}

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

async function artifactRecord(filePath) {
  const details = await stat(filePath);
  return {
    name: path.basename(filePath),
    sizeBytes: details.size,
    sha256: await sha256File(filePath),
  };
}

/** `…/target/<triple>/<profile>/nexus-aurea.exe` -> { target, profile }. */
export function buildLocationOf(payloadPath) {
  const parts = path.resolve(payloadPath).split(path.sep);
  const targetIndex = parts.lastIndexOf("target");
  if (targetIndex < 0 || parts.length - targetIndex !== 4) return null;
  return { target: parts[targetIndex + 1], profile: parts[targetIndex + 2] };
}

export async function createManifest({
  installerPath,
  payloadPath,
  packagedPayloadPath,
  repoRoot = process.cwd(),
  env = process.env,
  tools: suppliedTools,
  requireTools = false,
  now = new Date(),
}) {
  const git = inspectSource(repoRoot);
  if (!git.repositoryRoot || !git.checkoutSha) {
    throw new Error("A full Git checkout SHA is required to create an installer manifest.");
  }

  const expectedSha = validOptionalSha(env.VELORA_SOURCE_SHA || env.GITHUB_SHA, "VELORA_SOURCE_SHA/GITHUB_SHA");
  const expectedCheckoutSha = validOptionalSha(env.VELORA_CHECKOUT_SHA, "VELORA_CHECKOUT_SHA");
  for (const expected of [expectedSha, expectedCheckoutSha].filter(Boolean)) {
    if (expected !== git.checkoutSha) {
      throw new Error(`Checkout SHA mismatch: Git reports ${git.checkoutSha}, CI supplied ${expected}.`);
    }
  }

  const event = env.VELORA_BUILD_EVENT || env.GITHUB_EVENT_NAME || "local";
  const eventData = event === "pull_request" ? readPullRequestEvent(env) : null;
  const prHeadSha = validOptionalSha(
    env.VELORA_PR_HEAD_SHA || eventData?.pull_request?.head?.sha,
    "pull request head SHA",
  );
  const prBaseSha = validOptionalSha(
    env.VELORA_PR_BASE_SHA || eventData?.pull_request?.base?.sha,
    "pull request base SHA",
  );
  const pullRequest = event === "pull_request";
  if (pullRequest && (!prHeadSha || !prBaseSha)) {
    throw new Error("Pull request provenance requires both head and base SHAs.");
  }

  const packageJson = JSON.parse(await readFile(path.join(git.repositoryRoot, "package.json"), "utf8"));
  const location = buildLocationOf(payloadPath);
  const target = location?.target || env.TARGET || env.CARGO_BUILD_TARGET || "x86_64-pc-windows-msvc";
  const profile = location?.profile || env.PROFILE || "release";
  const tools = suppliedTools || (await collectTools({ env, target, repoRoot: git.repositoryRoot }));
  const absent = missingTools(tools);
  if (requireTools && absent.length > 0) {
    throw new Error(`Required build tool versions are unavailable: ${absent.join(", ")}.`);
  }

  const installer = await artifactRecord(installerPath);
  const builtExe = await artifactRecord(payloadPath);
  const packagedExe = await artifactRecord(packagedPayloadPath);
  const relation = verifyPayloadRelation(
    await readFile(payloadPath),
    await readFile(packagedPayloadPath),
    payloadPolicyFor(tools.tauriCli),
  );

  const ref = env.VELORA_BUILD_REF || env.GITHUB_REF || git.branch || "detached";
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    app: { name: "VELORA", version: packageJson.version },
    source: {
      sourceSha: prHeadSha || git.checkoutSha,
      checkoutSha: git.checkoutSha,
      branch: git.branch,
      headBranch: env.GITHUB_HEAD_REF || null,
      ref,
      dirty: git.dirty,
      clean: git.dirty === null ? null : !git.dirty,
      event,
      pullRequest: pullRequest
        ? {
            headSha: prHeadSha,
            baseSha: prBaseSha,
            syntheticMergeSha: git.checkoutSha,
          }
        : null,
    },
    build: {
      generatedAt: now.toISOString(),
      target,
      profile,
      runnerOs: env.RUNNER_OS || process.platform,
      runId: env.GITHUB_RUN_ID || null,
      runAttempt: env.GITHUB_RUN_ATTEMPT || null,
    },
    tools,
    artifacts: { installer, builtExe, packagedExe, payloadRelation: relation },
  };
  validateManifestShape(manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

/**
 * Schema plus agreement between the manifest's own fields. This is the part of
 * "verification" that needs no outside data.
 */
export function validateManifestShape(manifest, { now = new Date() } = {}) {
  validateManifestSchema(manifest);
  const { source, build, artifacts } = manifest;
  assert.equal(
    source.clean,
    source.dirty === null ? null : !source.dirty,
    "Manifest clean and dirty values disagree.",
  );
  if (source.event === "pull_request") {
    assert.ok(source.pullRequest, "PR event requires PR head and synthetic merge metadata.");
    assert.equal(source.sourceSha, source.pullRequest.headSha, "sourceSha must be the PR head SHA.");
    assert.equal(source.checkoutSha, source.pullRequest.syntheticMergeSha, "checkoutSha must be the synthetic merge SHA.");
    assert.notEqual(source.pullRequest.headSha, source.pullRequest.baseSha, "PR head and base must differ.");
    assert.notEqual(source.checkoutSha, source.pullRequest.headSha, "A PR checkout must be the synthetic merge, not the head.");
    assert.match(source.ref, /^refs\/pull\/\d+\/merge$/, "A pull request build must record its merge ref.");
  } else {
    assert.equal(source.pullRequest, null, "Non-PR event must not claim synthetic PR metadata.");
    assert.equal(source.sourceSha, source.checkoutSha, "Outside a PR, sourceSha and checkoutSha must be equal.");
    if (source.event === "push") assert.match(source.ref, /^refs\/(?:heads|tags)\/.+/, "A push build must record a branch or tag ref.");
  }
  const generated = new Date(build.generatedAt).getTime();
  assert.ok(generated <= now.getTime() + MAX_CLOCK_SKEW_MS, "Manifest generatedAt is in the future.");
  assert.ok(generated >= Date.parse("2024-01-01T00:00:00Z"), "Manifest generatedAt is implausibly old.");
  assert.match(artifacts.installer.name, /-setup\.exe$/i, "Installer artifact must be a setup executable.");
  assert.equal(artifacts.builtExe.name, "nexus-aurea.exe", "Built EXE artifact name is unexpected.");
  assert.equal(artifacts.packagedExe.name, "nexus-aurea.exe", "Packaged EXE artifact name is unexpected.");
  assert.ok(artifacts.installer.sizeBytes > 0 && artifacts.builtExe.sizeBytes > 0, "Artifact sizes must be positive.");
  assert.equal(
    artifacts.builtExe.sizeBytes,
    artifacts.packagedExe.sizeBytes,
    "Built and packaged EXE sizes must be equal.",
  );
  assert.notEqual(
    artifacts.builtExe.sha256,
    artifacts.packagedExe.sha256,
    "Built and packaged EXE must differ by the bundle-type marker.",
  );
  assert.ok(
    artifacts.payloadRelation.markerOffset < artifacts.builtExe.sizeBytes,
    "Payload relation marker offset lies outside the file.",
  );
  return true;
}

function readCargoVersion(text) {
  const section = /\[package\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] || "";
  return /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1] || null;
}

function lockedTauriCliVersion(lockText) {
  const importer = /^\s*'?@tauri-apps\/cli'?:\s*\r?\n\s*specifier:[^\n]*\r?\n\s*version:\s*([0-9][^\s\r\n]*)/m.exec(lockText);
  return importer?.[1] || null;
}

function checkAgainstCheckout(manifest, repoRoot) {
  const checks = [];
  const git = inspectSource(repoRoot);
  assert.ok(git.repositoryRoot, "A Git checkout is required to verify the manifest source.");
  assert.equal(git.checkoutSha, manifest.source.checkoutSha, "Manifest checkout SHA does not match the repository HEAD.");
  checks.push("checkout SHA equals Git HEAD");
  assert.equal(git.dirty, manifest.source.dirty, "Manifest clean/dirty state does not match the current checkout.");
  checks.push("dirty state equals the checkout");

  const pr = manifest.source.pullRequest;
  if (pr) {
    assert.deepEqual(
      git.parents,
      [pr.baseSha, pr.headSha],
      "The checkout is not a merge of the recorded PR base and head (parents differ).",
    );
    checks.push("HEAD is a merge of the recorded PR base and head");
  }

  const packageJson = JSON.parse(readFileSync(path.join(git.repositoryRoot, "package.json"), "utf8"));
  assert.equal(manifest.app.version, packageJson.version, "Manifest app version does not match package.json.");
  const cargoVersion = readCargoVersion(readFileSync(path.join(git.repositoryRoot, "src-tauri", "Cargo.toml"), "utf8"));
  assert.equal(manifest.app.version, cargoVersion, "Manifest app version does not match src-tauri/Cargo.toml.");
  checks.push("app version equals package.json and Cargo.toml");

  const locked = lockedTauriCliVersion(readFileSync(path.join(git.repositoryRoot, "pnpm-lock.yaml"), "utf8"));
  assert.ok(locked, "Could not read the locked @tauri-apps/cli version from pnpm-lock.yaml.");
  assert.equal(manifest.tools.tauriCli, `tauri-cli ${locked}`, "Manifest Tauri CLI version differs from the pnpm lockfile.");
  checks.push("Tauri CLI version equals the pnpm lockfile");
  return checks;
}

async function checkCiOrigin({ manifest, env, payloadPath, collect, now, maxAgeMs }) {
  const checked = [];
  assert.equal(env.GITHUB_ACTIONS, "true", "CI origin can only be confirmed inside a GitHub Actions job.");
  const absent = missingTools(manifest.tools);
  assert.equal(absent.length, 0, `Required build tool versions are unavailable: ${absent.join(", ")}.`);
  checked.push("all seven tool versions recorded");

  const { source, build } = manifest;
  assert.equal(env.GITHUB_EVENT_NAME, source.event, "Manifest event differs from the CI event.");
  assert.equal(env.GITHUB_REF, source.ref, "Manifest ref differs from the CI ref.");
  assert.equal(env.GITHUB_SHA, source.checkoutSha, "Manifest checkout SHA differs from GITHUB_SHA.");
  assert.equal(env.GITHUB_RUN_ID, build.runId, "Manifest run id differs from the CI run.");
  assert.equal(env.GITHUB_RUN_ATTEMPT, build.runAttempt, "Manifest run attempt differs from the CI run.");
  assert.equal(env.RUNNER_OS, build.runnerOs, "Manifest runner OS differs from the CI runner.");
  assert.equal(env.GITHUB_HEAD_REF || null, source.headBranch, "Manifest head branch differs from the CI head ref.");
  checked.push("event, ref, SHA, run id/attempt, runner OS and head branch equal the CI context");

  if (source.event === "pull_request") {
    const event = readPullRequestEvent(env);
    assert.ok(event?.pull_request, "The CI event payload has no pull request.");
    assert.equal(event.pull_request.head.sha, source.pullRequest.headSha, "PR head SHA differs from the CI event payload.");
    assert.equal(event.pull_request.base.sha, source.pullRequest.baseSha, "PR base SHA differs from the CI event payload.");
    assert.equal(source.ref, `refs/pull/${event.pull_request.number}/merge`, "Merge ref differs from the CI event's PR number.");
    checked.push("PR head, base and number equal the CI event payload");
  }

  const location = buildLocationOf(payloadPath);
  assert.ok(location, "The built EXE is not under target/<triple>/<profile>/, so the build variant cannot be confirmed.");
  assert.equal(location.target, build.target, "Manifest target differs from the target the EXE was built for.");
  assert.equal(location.profile, build.profile, "Manifest profile differs from the profile the EXE was built with.");
  checked.push("target and profile equal the build output location");

  const actualTools = await collect({ env, target: build.target });
  for (const name of REQUIRED_TOOLS) {
    assert.equal(manifest.tools[name], actualTools[name], `Manifest ${name} version differs from the installed tool.`);
  }
  checked.push("tool versions equal the tools installed on this runner");

  const age = now.getTime() - new Date(build.generatedAt).getTime();
  assert.ok(age <= maxAgeMs, "Manifest was generated too long before this verification.");
  checked.push("generated within the allowed time window");
  return checked;
}

/**
 * Throws on any violation. On success returns a report that keeps the two levels
 * of assurance apart: `internalConsistency` is always true on return;
 * `ciOrigin.confirmed` is true only when `ci` was requested and every CI check
 * passed. Neither is a signature.
 */
export async function verifyManifest({
  manifest,
  installerPath,
  payloadPath,
  packagedPayloadPath,
  repoRoot = process.cwd(),
  env = process.env,
  ci = false,
  now = new Date(),
  maxAgeMs = DEFAULT_CI_MAX_AGE_MS,
  collect = collectTools,
}) {
  validateManifestShape(manifest, { now });
  const sourceChecks = checkAgainstCheckout(manifest, repoRoot);

  const actual = {
    installer: await artifactRecord(installerPath),
    builtExe: await artifactRecord(payloadPath),
    packagedExe: await artifactRecord(packagedPayloadPath),
  };
  for (const name of Object.keys(actual)) {
    assert.deepEqual(actual[name], manifest.artifacts[name], `Manifest ${name} entry does not match its file.`);
  }
  const relation = verifyPayloadRelation(
    await readFile(payloadPath),
    await readFile(packagedPayloadPath),
    payloadPolicyFor(manifest.tools.tauriCli),
  );
  assert.deepEqual(relation, manifest.artifacts.payloadRelation, "Manifest payload relation does not match the files.");

  const report = {
    internalConsistency: true,
    sourceChecks,
    ciOrigin: { confirmed: false, checked: [], note: "Not checked: verification ran without --ci." },
    authenticity: "Not a digital signature: hashes and metadata do not prove who built these files.",
  };
  if (ci) {
    const checked = await checkCiOrigin({ manifest, env, payloadPath, collect, now, maxAgeMs });
    report.ciOrigin = {
      confirmed: true,
      checked,
      note: "Matches the GitHub Actions context and runner tools of this job; the CI runner is the only witness.",
    };
  }
  return report;
}

// ---------------------------------------------------------------------------
// Release assets
// ---------------------------------------------------------------------------

/** The only files a release may carry: one installer and its manifest. */
export async function selectReleaseAssets(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).filter((entry) => entry.isFile());
  const installers = entries.filter((entry) => /-setup\.exe$/i.test(entry.name));
  const manifests = entries.filter((entry) => entry.name === MANIFEST_FILE_NAME);
  const unexpected = entries.filter((entry) => !installers.includes(entry) && !manifests.includes(entry));
  assert.equal(installers.length, 1, `Expected exactly one installer for the release; found ${installers.length}.`);
  assert.equal(manifests.length, 1, `Expected exactly one ${MANIFEST_FILE_NAME} for the release; found ${manifests.length}.`);
  assert.equal(unexpected.length, 0, `Unexpected files in the release directory: ${unexpected.map((e) => e.name).join(", ")}.`);
  return { installer: path.join(directory, installers[0].name), manifest: path.join(directory, manifests[0].name) };
}

/**
 * Checks, without the original build outputs, that the manifest that would be
 * published belongs to the installer that would be published and to this
 * release's CI run. Same limits as `verifyManifest`: consistency, not a signature.
 */
export async function verifyReleaseAssets({ installerPath, manifestPath, env = process.env, now = new Date(), preview = false }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  validateManifestShape(manifest, { now });
  assert.deepEqual(
    await artifactRecord(installerPath),
    manifest.artifacts.installer,
    "The release installer does not match the manifest installer entry.",
  );
  const absent = missingTools(manifest.tools);
  assert.equal(absent.length, 0, `Required build tool versions are unavailable: ${absent.join(", ")}.`);
  assert.equal(manifest.source.dirty, false, "A release manifest must describe a clean checkout.");
  const checked = [];
  if (env.GITHUB_ACTIONS === "true") {
    assert.equal(env.GITHUB_SHA, manifest.source.checkoutSha, "The manifest was not built from the release commit.");
    assert.equal(env.GITHUB_RUN_ID, manifest.build.runId, "The manifest comes from a different CI run.");
    if (!preview) {
      assert.equal(manifest.source.event, "push", "A release manifest must come from a push (tag) build.");
      assert.equal(env.GITHUB_REF, manifest.source.ref, "The manifest ref is not the release tag.");
    }
    checked.push(preview
      ? "commit and run id equal this job's context (preview: event and tag are not release-checked)"
      : "commit, run id, event and tag ref equal the release job's context");
  }
  return { internalConsistency: true, ciOrigin: { confirmed: checked.length > 0, checked } };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const BOOLEAN_FLAGS = new Set(["--ci", "--preview"]);

function parseArguments(args) {
  const [command, ...tokens] = args;
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const name = tokens[index];
    if (BOOLEAN_FLAGS.has(name)) {
      values.set(name, true);
      continue;
    }
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`Invalid command line near ${name || "<end>"}.`);
    }
    values.set(name, value);
    index += 1;
  }
  const value = (name) => {
    const result = values.get(`--${name}`);
    if (!result) throw new Error(`Missing required option --${name}.`);
    return result;
  };
  const optional = (name) => values.get(`--${name}`) || null;
  return { command, value, optional, flag: (name) => values.get(`--${name}`) === true };
}

async function packagedPayloadFrom({ value, optional }) {
  const file = optional("packaged-payload");
  const directory = optional("extracted-dir");
  assert.ok(Boolean(file) !== Boolean(directory), "Pass exactly one of --packaged-payload or --extracted-dir.");
  return file || (await findSinglePackagedExecutable(directory));
}

function describe(report) {
  const lines = [
    "Internal consistency: PASS (schema, fields, file hashes, payload relation, checkout)",
    report.ciOrigin.confirmed
      ? `CI origin: CONFIRMED against the GitHub Actions context (${report.ciOrigin.checked.length} checks)`
      : `CI origin: NOT CONFIRMED (${report.ciOrigin.note || "no CI context"})`,
    "Authenticity: NOT PROVEN (no digital signature; hashes alone are not proof of origin)",
  ];
  return `${lines.join("\n")}\n`;
}

async function runCli() {
  const cli = parseArguments(process.argv.slice(2));
  const { command, value } = cli;
  const repoRoot = process.cwd();
  if (command === "release-assets") {
    const assets = await selectReleaseAssets(value("dir"));
    process.stdout.write(`${assets.installer}\n${assets.manifest}\n`);
    return;
  }
  if (command === "verify-release") {
    const report = await verifyReleaseAssets({
      installerPath: value("installer"),
      manifestPath: value("manifest"),
      preview: cli.flag("preview"),
    });
    process.stdout.write(describe({ ...report, ciOrigin: { ...report.ciOrigin, note: "not inside GitHub Actions" } }));
    return;
  }
  const installerPath = value("installer");
  const payloadPath = value("payload");
  const packagedPayloadPath = await packagedPayloadFrom(cli);
  const manifestPath = value("manifest");
  const ci = cli.flag("ci");
  let report;
  if (command === "write") {
    const manifest = await createManifest({
      installerPath,
      payloadPath,
      packagedPayloadPath,
      repoRoot,
      requireTools: ci,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    report = await verifyManifest({ manifest, installerPath, payloadPath, packagedPayloadPath, repoRoot, ci });
  } else if (command === "verify") {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    report = await verifyManifest({ manifest, installerPath, payloadPath, packagedPayloadPath, repoRoot, ci });
  } else {
    throw new Error(
      "Usage: build-provenance.mjs <write|verify> --installer FILE --payload FILE (--packaged-payload FILE | --extracted-dir DIR) --manifest FILE [--ci]\n" +
        "       build-provenance.mjs release-assets --dir DIR\n" +
        "       build-provenance.mjs verify-release --installer FILE --manifest FILE",
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tools = REQUIRED_TOOLS.map((name) => `${name}=${manifest.tools[name]}`).join(", ");
  process.stdout.write(
    `Verified ${manifest.source.checkoutSha} (${manifest.source.event}, ${manifest.source.dirty === false ? "clean" : "dirty/unknown"})\n` +
      `Installer SHA-256: ${manifest.artifacts.installer.sha256}\n` +
      `Built EXE SHA-256: ${manifest.artifacts.builtExe.sha256}\n` +
      `Packaged payload EXE SHA-256: ${manifest.artifacts.packagedExe.sha256}\n` +
      `Payload relation: ${manifest.artifacts.payloadRelation.transformation} at offset ${manifest.artifacts.payloadRelation.markerOffset} (${manifest.artifacts.payloadRelation.policy})\n` +
      `Tools: ${tools}\n` +
      describe(report),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
