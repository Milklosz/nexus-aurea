// Tests for the local SHA-256 artifact manifest (scripts/sha256-manifest.mjs).
// Run with: pnpm test:manifest  (or node --test this file)
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildManifest,
  collectFiles,
  comparePaths,
  inspectGit,
  isExcludedFileName,
  parseArguments,
  readManifestFile,
  renderTextManifest,
  sha256File,
  verifyManifest,
  writeManifestFiles,
} from "./sha256-manifest.mjs";

const SCRIPT = fileURLToPath(new URL("./sha256-manifest.mjs", import.meta.url));
const ROOT = path.resolve(path.dirname(SCRIPT), "..");
const FIXED_NOW = "2026-11-18T12:00:00.000Z";

async function makeTree() {
  return mkdtemp(path.join(tmpdir(), "velora-sha256-manifest-"));
}

function gitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "VELORA Test",
    GIT_AUTHOR_EMAIL: "velora-test@example.invalid",
    GIT_COMMITTER_NAME: "VELORA Test",
    GIT_COMMITTER_EMAIL: "velora-test@example.invalid",
  };
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: gitEnv(),
    windowsHide: true,
  });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function initRepo(directory) {
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"]);
  return git(directory, ["rev-parse", "HEAD"]);
}

test("parseArguments supports repeated --root, values and bare flags", () => {
  assert.deepEqual(parseArguments(["--root", "dist", "--root", "dist/portable", "--dirty", "--output", "out"]), {
    roots: ["dist", "dist/portable"],
    dirty: "true",
    output: "out",
  });
  assert.deepEqual(parseArguments([]), {});
  assert.throws(() => parseArguments(["positional"]), /Unexpected argument/);
  assert.throws(() => parseArguments(["--root"]), /--root requires/);
});

test("sha256File matches a known digest, including a multi-chunk file", async () => {
  const directory = await makeTree();
  try {
    const small = path.join(directory, "small.txt");
    await writeFile(small, "velora\n");
    assert.equal(
      await sha256File(small),
      createHash("sha256").update("velora\n").digest("hex"),
    );

    // Larger than one stream chunk: exercises the streaming path.
    const chunk = Buffer.alloc(1024 * 1024, 7);
    const big = path.join(directory, "big.bin");
    const parts = [];
    for (let index = 0; index < 5; index += 1) parts.push(chunk, Buffer.from(`part-${index}`));
    await writeFile(big, Buffer.concat(parts));
    const expected = createHash("sha256");
    for (const part of parts) expected.update(part);
    assert.equal(await sha256File(big), expected.digest("hex"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("buildManifest records correct file/bytes/sha256 for known inputs", async () => {
  const directory = await makeTree();
  try {
    await mkdir(path.join(directory, "dist", "assets"), { recursive: true });
    await writeFile(path.join(directory, "dist", "index.html"), "<html>velora</html>");
    await writeFile(path.join(directory, "dist", "assets", "app.js"), "console.log(1);");
    const manifest = await buildManifest({
      cwd: directory,
      roots: ["dist"],
      now: FIXED_NOW,
    });
    assert.equal(manifest.kind, "velora-sha256-manifest");
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.generatedAtUtc, FIXED_NOW);
    assert.equal(manifest.fileCount, 2);
    assert.equal(manifest.totalBytes, Buffer.byteLength("<html>velora</html>") + Buffer.byteLength("console.log(1);"));
    assert.deepEqual(manifest.roots, ["dist"]);
    const byPath = new Map(manifest.files.map((record) => [record.path, record]));
    assert.equal(
      byPath.get("dist/index.html").sha256,
      createHash("sha256").update("<html>velora</html>").digest("hex"),
    );
    assert.equal(
      byPath.get("dist/assets/app.js").sha256,
      createHash("sha256").update("console.log(1);").digest("hex"),
    );
    assert.equal(byPath.get("dist/index.html").bytes, Buffer.byteLength("<html>velora</html>"));
    // Outside a git repo the source fields are explicitly unknown, never faked.
    assert.equal(manifest.source.commit, null);
    assert.equal(manifest.source.dirty, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("file ordering is deterministic code-unit order, not locale or creation order", async () => {
  const directory = await makeTree();
  try {
    await mkdir(path.join(directory, "dist", "a"), { recursive: true });
    // Created in deliberately scrambled order.
    for (const name of ["b.txt", "a/x.txt", "2.txt", "10.txt", "a.txt"]) {
      await writeFile(path.join(directory, "dist", name), name);
    }
    const manifest = await buildManifest({ cwd: directory, roots: ["dist"], now: FIXED_NOW });
    const paths = manifest.files.map((record) => record.path);
    assert.deepEqual(paths, [
      "dist/10.txt", // code-unit order: "1" < "2" < "a" < "b"
      "dist/2.txt",
      "dist/a.txt",
      "dist/a/x.txt",
      "dist/b.txt",
    ]);
    assert.deepEqual([...paths].sort(comparePaths), paths);

    // Two independent builds with the same clock produce identical file lists.
    const again = await buildManifest({ cwd: directory, roots: ["dist"], now: FIXED_NOW });
    assert.deepEqual(again.files, manifest.files);
    assert.equal(renderTextManifest(again), renderTextManifest(manifest));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("nested roots are walked once: dist/portable files appear a single time", async () => {
  const directory = await makeTree();
  try {
    await mkdir(path.join(directory, "dist", "portable"), { recursive: true });
    await writeFile(path.join(directory, "dist", "index.html"), "root");
    await writeFile(path.join(directory, "dist", "portable", "VELORA-Portable-Windows-x64.zip"), "zip-bytes");
    const manifest = await buildManifest({
      cwd: directory,
      roots: ["dist", "dist/portable"],
      now: FIXED_NOW,
    });
    const paths = manifest.files.map((record) => record.path);
    assert.deepEqual(paths, ["dist/index.html", "dist/portable/VELORA-Portable-Windows-x64.zip"]);
    assert.equal(new Set(paths).size, paths.length);
    assert.deepEqual(manifest.roots, ["dist", "dist/portable"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("git provenance: clean tree reports HEAD and dirty=false; changes flip the flag", async () => {
  const directory = await makeTree();
  try {
    const commit = await initRepo(directory);
    await mkdir(path.join(directory, "dist"));
    await writeFile(path.join(directory, "dist", "app.js"), "v1");
    git(directory, ["add", "dist"]);
    git(directory, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "add dist"]);
    const head = git(directory, ["rev-parse", "HEAD"]);

    const clean = await buildManifest({ cwd: directory, roots: ["dist"], now: FIXED_NOW });
    assert.equal(clean.source.commit, head);
    assert.notEqual(clean.source.commit, commit, "the second commit moved HEAD");
    assert.equal(clean.source.dirty, false);
    assert.equal(clean.source.branch, "main");

    // Untracked file -> dirty.
    await writeFile(path.join(directory, "dist", "untracked.js"), "x");
    const dirtyUntracked = await buildManifest({ cwd: directory, roots: ["dist"], now: FIXED_NOW });
    assert.equal(dirtyUntracked.source.commit, head);
    assert.equal(dirtyUntracked.source.dirty, true);

    // Tracked modification -> dirty as well.
    await rm(path.join(directory, "dist", "untracked.js"));
    await writeFile(path.join(directory, "dist", "app.js"), "v2-changed");
    const dirtyModified = await buildManifest({ cwd: directory, roots: ["dist"], now: FIXED_NOW });
    assert.equal(dirtyModified.source.dirty, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("inspectGit on this real checkout returns the rev-parse HEAD commit", () => {
  const info = inspectGit(ROOT);
  const head = spawnSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true });
  assert.equal(head.status, 0);
  assert.equal(info.commit, head.stdout.trim().toLowerCase());
  assert.equal(typeof info.dirty, "boolean");
});

test("no secrets: credential-like files are excluded by name and no content leaks", async () => {
  const directory = await makeTree();
  try {
    await mkdir(path.join(directory, "dist", "keys"), { recursive: true });
    await writeFile(path.join(directory, "dist", "index.html"), "public");
    await writeFile(path.join(directory, "dist", ".env"), "AWS_SECRET_ACCESS_KEY=super-secret-value-123");
    await writeFile(path.join(directory, "dist", "keys", "id_rsa"), "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
    await writeFile(path.join(directory, "dist", "credentials.json"), '{"token":"tok_live_secret"}');
    await writeFile(path.join(directory, "dist", "cert.pem"), "-----BEGIN CERTIFICATE-----");

    assert.equal(isExcludedFileName(".env"), true);
    assert.equal(isExcludedFileName("id_rsa.pub"), true);
    assert.equal(isExcludedFileName("index.html"), false);

    const manifest = await buildManifest({ cwd: directory, roots: ["dist"], now: FIXED_NOW });
    const paths = manifest.files.map((record) => record.path);
    assert.deepEqual(paths, ["dist/index.html"]);
    assert.ok(manifest.excluded.includes("dist/.env"));
    assert.ok(manifest.excluded.includes("dist/keys/id_rsa"));
    assert.ok(manifest.excluded.includes("dist/credentials.json"));
    assert.ok(manifest.excluded.includes("dist/cert.pem"));

    // The serialized manifest and the human-readable rendering must contain
    // hashes and paths only — never file contents or secret material.
    for (const rendering of [JSON.stringify(manifest), renderTextManifest(manifest)]) {
      assert.equal(rendering.includes("super-secret-value-123"), false);
      assert.equal(rendering.includes("BEGIN RSA PRIVATE KEY"), false);
      assert.equal(rendering.includes("tok_live_secret"), false);
      assert.equal(rendering.includes("BEGIN CERTIFICATE"), false);
    }
    // Every file entry carries exactly path/bytes/sha256 — nothing else.
    for (const record of manifest.files) {
      assert.deepEqual(Object.keys(record).sort(), ["bytes", "path", "sha256"]);
      assert.match(record.sha256, /^[0-9a-f]{64}$/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("write + verify roundtrip; tampering, additions and deletions are rejected", async () => {
  const directory = await makeTree();
  try {
    await mkdir(path.join(directory, "dist", "portable"), { recursive: true });
    await writeFile(path.join(directory, "dist", "index.html"), "v1");
    await writeFile(path.join(directory, "dist", "portable", "pkg.zip"), "zip-v1");
    const prefix = path.join(directory, "dist", "sha256-manifest");
    const manifest = await buildManifest({
      cwd: directory,
      roots: ["dist"],
      now: FIXED_NOW,
      excludeAbsolutePaths: [`${prefix}.json`, `${prefix}.md`],
    });
    const { jsonPath, textPath } = await writeManifestFiles(manifest, prefix);
    assert.ok(jsonPath.endsWith("sha256-manifest.json"));
    assert.ok(textPath.endsWith("sha256-manifest.md"));

    // The manifest's own output files must not be part of the walked set.
    assert.equal(manifest.files.some((record) => record.path.includes("sha256-manifest")), false);

    const verified = await verifyManifest(jsonPath, { cwd: directory });
    assert.equal(verified.fileCount, 2);
    assert.equal((await readManifestFile(jsonPath)).kind, "velora-sha256-manifest");
    assert.ok((await readFile(textPath, "utf8")).includes("| dist/index.html | 2 |"));

    // Tampered content (same length, so the size check passes) -> hash mismatch.
    await writeFile(path.join(directory, "dist", "index.html"), "vX");
    await assert.rejects(verifyManifest(jsonPath, { cwd: directory }), /SHA-256 mismatch for dist\/index\.html/);

    // Restored, but an extra file appeared -> file set mismatch.
    await writeFile(path.join(directory, "dist", "index.html"), "v1");
    await writeFile(path.join(directory, "dist", "extra.js"), "extra");
    await assert.rejects(verifyManifest(jsonPath, { cwd: directory }), /file set differs/);

    // And a deleted file is caught too.
    await rm(path.join(directory, "dist", "extra.js"));
    await rm(path.join(directory, "dist", "portable", "pkg.zip"));
    await assert.rejects(verifyManifest(jsonPath, { cwd: directory }), /file set differs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("collectFiles never follows symlinks and skips .git/node_modules", async () => {
  const directory = await makeTree();
  try {
    await mkdir(path.join(directory, "dist", ".git"), { recursive: true });
    await mkdir(path.join(directory, "dist", "node_modules", "pkg"), { recursive: true });
    await writeFile(path.join(directory, "dist", ".git", "HEAD"), "ref");
    await writeFile(path.join(directory, "dist", "node_modules", "pkg", "index.js"), "dep");
    await writeFile(path.join(directory, "dist", "real.txt"), "real");
    const { files, excluded } = await collectFiles(["dist"], { cwd: directory });
    assert.deepEqual(files.map((file) => file.path), ["dist/real.txt"]);
    assert.ok(excluded.includes("dist/.git"));
    assert.ok(excluded.includes("dist/node_modules"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI: write then verify succeeds; verify fails on a tampered tree", async () => {
  const directory = await makeTree();
  try {
    await mkdir(path.join(directory, "dist"));
    await writeFile(path.join(directory, "dist", "app.js"), "console.log('cli');");
    const prefix = path.join(directory, "dist", "sha256-manifest");

    const writeResult = spawnSync(
      process.execPath,
      [SCRIPT, "write", "--cwd", directory, "--root", "dist", "--output", prefix],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(writeResult.status, 0, writeResult.stderr);
    assert.match(writeResult.stdout, /sha256-manifest: wrote/);
    const onDisk = await readManifestFile(`${prefix}.json`);
    assert.equal(onDisk.fileCount, 1);
    assert.equal(onDisk.source.commit, null, "temp dir is not a git repo");

    const verifyOk = spawnSync(
      process.execPath,
      [SCRIPT, "verify", "--manifest", `${prefix}.json`, "--cwd", directory],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(verifyOk.status, 0, verifyOk.stderr);
    assert.match(verifyOk.stdout, /verified: 1 files/);

    await writeFile(path.join(directory, "dist", "app.js"), "console.log('clX');");
    const verifyBad = spawnSync(
      process.execPath,
      [SCRIPT, "verify", "--manifest", `${prefix}.json`, "--cwd", directory],
      { encoding: "utf8", windowsHide: true },
    );
    assert.notEqual(verifyBad.status, 0);
    assert.match(verifyBad.stderr, /SHA-256 mismatch/);

    const show = execFileSync(
      process.execPath,
      [SCRIPT, "show", "--manifest", `${prefix}.json`],
      { encoding: "utf8", windowsHide: true },
    );
    assert.match(show, /\| dist\/app\.js \|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI: write with no existing roots warns but still emits an empty manifest", async () => {
  const directory = await makeTree();
  try {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, "write", "--cwd", directory, "--root", "dist", "--output", path.join(directory, "out", "sha256-manifest")],
      { encoding: "utf8", windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /none of the roots exist/);
    const manifest = await readManifestFile(path.join(directory, "out", "sha256-manifest.json"));
    assert.equal(manifest.fileCount, 0);
    assert.equal(manifest.totalBytes, 0);
    assert.deepEqual(manifest.files, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
