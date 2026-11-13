import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

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
    return { repositoryRoot: null, checkoutSha: null, branch: null, dirty: null };
  }
  const checkoutSha = runGit(root, ["rev-parse", "--verify", "HEAD"]);
  const branch = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const dirty = status.error || status.status !== 0 ? null : status.stdout.length > 0;
  return {
    repositoryRoot: root,
    checkoutSha: checkoutSha && FULL_SHA.test(checkoutSha) ? checkoutSha : null,
    branch: branch || null,
    dirty,
  };
}

function toolVersion(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    env,
    timeout: 20_000,
  });
  if (result.error) return "unavailable";
  const output = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n")
    .trim()
    .split(/\r?\n/, 1)[0];
  return output || "unavailable";
}

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

export async function createManifest({
  installerPath,
  payloadPath,
  packagedPayloadPath,
  repoRoot = process.cwd(),
  env = process.env,
  tools: suppliedTools,
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
  const target = env.TARGET || env.CARGO_BUILD_TARGET || "x86_64-pc-windows-msvc";
  const profile = env.PROFILE || "release";
  const tools = suppliedTools || {
    node: process.version,
    pnpm: toolVersion("pnpm", ["--version"], env),
    rustc: toolVersion("rustc", ["--version"], env),
    cargo: toolVersion("cargo", ["--version"], env),
    tauriCli: toolVersion("pnpm", ["exec", "tauri", "--version"], env),
    msvc: env.VCToolsVersion || "unavailable",
    windowsSdk: (env.WindowsSDKVersion || "unavailable").replace(/[\\/]+$/, ""),
  };

  const installer = await artifactRecord(installerPath);
  const builtExe = await artifactRecord(payloadPath);
  const packagedExe = await artifactRecord(packagedPayloadPath);

  const ref = env.VELORA_BUILD_REF || env.GITHUB_REF || git.branch || "detached";
  const manifest = {
    schemaVersion: 1,
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
    artifacts: { installer, builtExe, packagedExe },
  };
  validateManifestShape(manifest);
  return manifest;
}

export function validateManifestShape(manifest) {
  assert.equal(manifest.schemaVersion, 1, "Unsupported provenance manifest schema version.");
  assert.ok(FULL_SHA.test(manifest.source.sourceSha), "Manifest sourceSha must be full length.");
  assert.ok(FULL_SHA.test(manifest.source.checkoutSha), "Manifest checkoutSha must be full length.");
  assert.ok(manifest.source.ref && manifest.source.event, "Manifest source ref/event is missing.");
  assert.equal(
    manifest.source.clean,
    manifest.source.dirty === null ? null : !manifest.source.dirty,
    "Manifest clean and dirty values disagree.",
  );
  if (manifest.source.event === "pull_request") {
    assert.ok(manifest.source.pullRequest, "PR event requires PR head and synthetic merge metadata.");
    assert.equal(manifest.source.sourceSha, manifest.source.pullRequest.headSha);
    assert.equal(manifest.source.checkoutSha, manifest.source.pullRequest.syntheticMergeSha);
  } else {
    assert.equal(manifest.source.pullRequest, null, "Non-PR event must not claim synthetic PR metadata.");
  }
  assert.ok(manifest.app.name && manifest.app.version, "Manifest app identity is missing.");
  assert.ok(manifest.build.target && manifest.build.profile, "Manifest build target/profile is missing.");
  for (const name of ["node", "pnpm", "rustc", "cargo", "tauriCli", "msvc", "windowsSdk"]) {
    assert.equal(typeof manifest.tools[name], "string", `Manifest tool ${name} is missing.`);
  }
  for (const name of ["installer", "builtExe", "packagedExe"]) {
    const artifact = manifest.artifacts[name];
    assert.ok(artifact.name && Number.isSafeInteger(artifact.sizeBytes), `Manifest ${name} identity is invalid.`);
    assert.ok(HEX_SHA256.test(artifact.sha256), `Manifest ${name} SHA-256 is invalid.`);
  }
  return true;
}

export async function verifyManifest({
  manifest,
  installerPath,
  payloadPath,
  packagedPayloadPath,
  repoRoot = process.cwd(),
}) {
  validateManifestShape(manifest);
  const git = inspectSource(repoRoot);
  if (git.checkoutSha !== manifest.source.checkoutSha) {
    throw new Error("Manifest checkout SHA does not match the repository HEAD.");
  }
  if (git.dirty !== manifest.source.dirty) {
    throw new Error("Manifest clean/dirty state does not match the current checkout.");
  }
  const actual = {
    installer: await artifactRecord(installerPath),
    builtExe: await artifactRecord(payloadPath),
    packagedExe: await artifactRecord(packagedPayloadPath),
  };
  for (const name of Object.keys(actual)) {
    assert.deepEqual(actual[name], manifest.artifacts[name], `Manifest ${name} entry does not match its file.`);
  }
  return true;
}

function parseArguments(args) {
  const [command, ...tokens] = args;
  const values = new Map();
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error(`Invalid command line near ${name || "<end>"}.`);
    values.set(name, value);
  }
  const value = (name) => {
    const result = values.get(`--${name}`);
    if (!result) throw new Error(`Missing required option --${name}.`);
    return result;
  };
  return { command, value };
}

async function runCli() {
  const { command, value } = parseArguments(process.argv.slice(2));
  const installerPath = value("installer");
  const payloadPath = value("payload");
  const packagedPayloadPath = value("packaged-payload");
  const manifestPath = value("manifest");
  const repoRoot = process.cwd();
  if (command === "write") {
    const manifest = await createManifest({
      installerPath,
      payloadPath,
      packagedPayloadPath,
      repoRoot,
    });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await verifyManifest({
      manifest,
      installerPath,
      payloadPath,
      packagedPayloadPath,
      repoRoot,
    });
  } else if (command === "verify") {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await verifyManifest({
      manifest,
      installerPath,
      payloadPath,
      packagedPayloadPath,
      repoRoot,
    });
  } else {
    throw new Error("Usage: build-provenance.mjs <write|verify> --installer FILE --payload FILE --packaged-payload FILE --manifest FILE");
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  process.stdout.write(
    `Verified ${manifest.source.checkoutSha} (${manifest.source.event}, ${manifest.source.dirty === false ? "clean" : "dirty/unknown"})\n` +
      `Installer SHA-256: ${manifest.artifacts.installer.sha256}\n` +
      `Built EXE SHA-256: ${manifest.artifacts.builtExe.sha256}\n` +
      `Packaged payload EXE SHA-256: ${manifest.artifacts.packagedExe.sha256}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
