import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import {
  createManifest,
  inspectSource,
  verifyManifest,
} from "./build-provenance.mjs";

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

async function initializeRepository(directory) {
  await mkdir(directory, { recursive: true });
  git(directory, ["init", "--initial-branch=main"]);
  git(directory, ["config", "user.name", "VELORA provenance test"]);
  git(directory, ["config", "user.email", "velora-provenance@example.invalid"]);
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ version: "0.9.2" }));
  await writeFile(path.join(directory, "README.md"), "first\n");
  git(directory, ["add", "package.json", "README.md"]);
  git(directory, ["commit", "-m", "first synthetic commit"]);
}

after(async () => {
  await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

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

test("manifest distinguishes PR head and synthetic merge and verifies installer payload hashes", async () => {
  const parent = await temporaryDirectory("manifest-integrity");
  const repo = path.join(parent, "repository");
  const outputs = path.join(parent, "outputs");
  await initializeRepository(repo);
  await mkdir(outputs);
  const installerPath = path.join(outputs, "velora-setup.exe");
  const payloadPath = path.join(outputs, "nexus-aurea.exe");
  const packagedPayloadPath = path.join(outputs, "extracted-nexus-aurea.exe");
  await writeFile(installerPath, Buffer.from("synthetic installer bytes"));
  await writeFile(payloadPath, Buffer.from("synthetic built EXE bytes"));
  await writeFile(packagedPayloadPath, Buffer.from("synthetic built EXE bytes"));

  const checkoutSha = inspectSource(repo).checkoutSha;
  const prHeadSha = "a".repeat(40);
  const prBaseSha = "b".repeat(40);
  const manifest = await createManifest({
    installerPath,
    payloadPath,
    packagedPayloadPath,
    repoRoot: repo,
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/88/merge",
      GITHUB_SHA: checkoutSha,
      VELORA_SOURCE_SHA: checkoutSha,
      VELORA_CHECKOUT_SHA: checkoutSha,
      VELORA_PR_HEAD_SHA: prHeadSha,
      VELORA_PR_BASE_SHA: prBaseSha,
      TARGET: "x86_64-pc-windows-msvc",
      PROFILE: "release",
      RUNNER_OS: "Windows",
    },
    tools: {
      node: "v22.0.0",
      pnpm: "11.25.0",
      rustc: "rustc synthetic",
      cargo: "cargo synthetic",
      tauriCli: "tauri synthetic",
      msvc: "14.synthetic",
      windowsSdk: "10.synthetic",
    },
    now: new Date("2026-11-13T12:00:00Z"),
  });

  assert.equal(manifest.source.sourceSha, prHeadSha);
  assert.equal(manifest.source.checkoutSha, checkoutSha);
  assert.equal(manifest.source.pullRequest.headSha, prHeadSha);
  assert.equal(manifest.source.pullRequest.syntheticMergeSha, checkoutSha);
  assert.equal(manifest.source.ref, "refs/pull/88/merge");
  assert.equal(manifest.artifacts.builtExe.sha256, manifest.artifacts.packagedExe.sha256);
  assert.equal(manifest.artifacts.installer.sha256.length, 64);
  assert.equal(await verifyManifest({
    manifest,
    installerPath,
    payloadPath,
    packagedPayloadPath,
    repoRoot: repo,
  }), true);

  await writeFile(packagedPayloadPath, Buffer.from("tampered payload"));
  await assert.rejects(
    verifyManifest({ manifest, installerPath, payloadPath, packagedPayloadPath, repoRoot: repo }),
    /does not match its file|Packaged EXE differs/,
  );
});

test("manifest rejects stale CI checkout SHA", async () => {
  const parent = await temporaryDirectory("stale-checkout");
  const repo = path.join(parent, "repository");
  const outputs = path.join(parent, "outputs");
  await initializeRepository(repo);
  await mkdir(outputs);
  const installerPath = path.join(outputs, "setup.exe");
  const payloadPath = path.join(outputs, "app.exe");
  const packagedPayloadPath = path.join(outputs, "packaged.exe");
  await writeFile(installerPath, "installer");
  await writeFile(payloadPath, "exe");
  await writeFile(packagedPayloadPath, "exe");
  await assert.rejects(
    createManifest({
      installerPath,
      payloadPath,
      packagedPayloadPath,
      repoRoot: repo,
      env: { GITHUB_SHA: "f".repeat(40) },
    }),
    /Checkout SHA mismatch/,
  );
});
