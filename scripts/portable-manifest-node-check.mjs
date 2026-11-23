// Tests for the portable-build manifest writer/verifier.
// Run with: pnpm test:portable-manifest  (or node --test this file)
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPortableManifest,
  EXECUTABLE_NAME,
  EXPECTED_ISOLATION,
  parseArguments,
  renderSha256Sums,
  sha256File,
  verifyPortableManifest,
  writeManifestFile,
} from "./portable-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_SHA = "a".repeat(40);

function baseOptions(stage, packagePath) {
  return {
    stage,
    executable: path.join(stage, EXECUTABLE_NAME),
    package: packagePath,
    sourceSha: SOURCE_SHA,
    appVersion: "0.12.0-rc.1",
    ref: "refs/heads/feat/portable-validation-build",
    event: "pull_request",
    branch: "feat/portable-validation-build",
    runId: "123456789",
    runAttempt: "1",
    runUrl: "https://github.com/Milklosz/nexus-aurea/actions/runs/123456789",
    workflow: "Portable Windows validation build",
    actor: "Milklosz",
    target: "x86_64-pc-windows-msvc",
    runnerOs: "Windows",
  };
}

test("parseArguments accepts values and bare flags", () => {
  assert.deepEqual(parseArguments(["--sourceSha", "abc", "--dirty"]), {
    sourceSha: "abc",
    dirty: "true",
  });
});

test("sha256File hashes an exact byte string", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "velora-portable-hash-"));
  try {
    const file = path.join(directory, "sample.bin");
    await writeFile(file, "velora");
    assert.equal(
      await sha256File(file),
      createHash("sha256").update("velora").digest("hex"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("write and verify roundtrip, including support files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "velora-portable-roundtrip-"));
  try {
    const stage = path.join(directory, "stage");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(stage);
    await writeFile(path.join(stage, EXECUTABLE_NAME), "fake-exe-bytes");
    await writeFile(path.join(stage, "Run-VELORA-Portable.cmd"), "launch");
    const packagePath = path.join(directory, "VELORA-Portable.zip");
    await writeFile(packagePath, "fake-zip-bytes");

    const manifest = await createPortableManifest(baseOptions(stage, packagePath));
    assert.equal(manifest.source.sourceSha, SOURCE_SHA);
    assert.equal(manifest.artifacts.executable.name, EXECUTABLE_NAME);
    assert.equal(manifest.artifacts.supportFiles.length, 1);
    assert.equal(manifest.verification.hardwareValidated, false);
    assert.equal(manifest.verification.digitalSignature, false);
    assert.deepEqual(manifest.isolation, EXPECTED_ISOLATION);

    const manifestPath = path.join(directory, "velora-portable-manifest.json");
    await writeManifestFile(manifestPath, manifest);
    const verified = await verifyPortableManifest(manifestPath, {
      base: directory,
      stage,
      package: packagePath,
    });
    assert.equal(verified.artifacts.package.sha256, manifest.artifacts.package.sha256);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification accepts a BOM-prefixed manifest from Windows PowerShell", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "velora-portable-bom-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const stage = path.join(directory, "stage");
    await mkdir(stage);
    await writeFile(path.join(stage, EXECUTABLE_NAME), "exe");
    const packagePath = path.join(directory, "portable.zip");
    await writeFile(packagePath, "zip");
    const manifest = await createPortableManifest(baseOptions(stage, packagePath));
    const manifestPath = path.join(directory, "manifest.json");
    await writeFile(manifestPath, `\uFEFF${JSON.stringify(manifest)}`, "utf8");
    await verifyPortableManifest(manifestPath, { base: directory, stage, package: packagePath });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification rejects a tampered package", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "velora-portable-tamper-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const stage = path.join(directory, "stage");
    await mkdir(stage);
    await writeFile(path.join(stage, EXECUTABLE_NAME), "fake-exe-bytes");
    const packagePath = path.join(directory, "VELORA-Portable.zip");
    await writeFile(packagePath, "original");
    const manifest = await createPortableManifest(baseOptions(stage, packagePath));
    const manifestPath = path.join(directory, "manifest.json");
    await writeManifestFile(manifestPath, manifest);

    await writeFile(packagePath, "tampered");
    await assert.rejects(
      verifyPortableManifest(manifestPath, { base: directory, stage, package: packagePath }),
      /ZIP hash\/size mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("verification rejects a tampered executable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "velora-portable-exe-tamper-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const stage = path.join(directory, "stage");
    await mkdir(stage);
    await writeFile(path.join(stage, EXECUTABLE_NAME), "original-exe");
    const packagePath = path.join(directory, "VELORA-Portable.zip");
    await writeFile(packagePath, "zip");
    const manifest = await createPortableManifest(baseOptions(stage, packagePath));
    const manifestPath = path.join(directory, "manifest.json");
    await writeManifestFile(manifestPath, manifest);

    await writeFile(path.join(stage, EXECUTABLE_NAME), "tampered-exe");
    await assert.rejects(
      verifyPortableManifest(manifestPath, { base: directory, stage, package: packagePath }),
      /EXE hash\/size mismatch/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("SHA256SUMS lines use the standard two-space format", () => {
  const sums = renderSha256Sums([
    { name: "b.txt", sha256: "b".repeat(64), sizeBytes: 1 },
    { name: "a.txt", sha256: "a".repeat(64), sizeBytes: 1 },
  ]);
  assert.equal(sums, `${"a".repeat(64)}  a.txt\n${"b".repeat(64)}  b.txt\n`);
});

test("the portable manifest JSON records the SHA-256 of the packaged ZIP and EXE", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "velora-portable-zipsha-"));
  try {
    const { mkdir } = await import("node:fs/promises");
    const stage = path.join(directory, "stage");
    await mkdir(stage);
    // Known inputs: the ZIP and the EXE bytes are fixed, so their digests are known.
    const zipBytes = "PK-zip-payload-for-hash-check";
    const exeBytes = "MZ-fake-exe-payload-for-hash-check";
    await writeFile(path.join(stage, EXECUTABLE_NAME), exeBytes);
    const packagePath = path.join(directory, "VELORA-Portable-Windows-x64.zip");
    await writeFile(packagePath, zipBytes);

    const manifest = await createPortableManifest(baseOptions(stage, packagePath));
    assert.equal(
      manifest.artifacts.package.sha256,
      createHash("sha256").update(zipBytes).digest("hex"),
      "artifacts.package.sha256 must be the SHA-256 of the packaged ZIP",
    );
    assert.equal(manifest.artifacts.package.sizeBytes, Buffer.byteLength(zipBytes));
    assert.equal(
      manifest.artifacts.executable.sha256,
      createHash("sha256").update(exeBytes).digest("hex"),
      "artifacts.executable.sha256 must be the SHA-256 of the packaged EXE",
    );
    assert.equal(manifest.artifacts.executable.sizeBytes, Buffer.byteLength(exeBytes));
    // The same ZIP digest is what ships in SHA256SUMS.txt next to the package.
    assert.equal(
      renderSha256Sums([manifest.artifacts.package]),
      `${manifest.artifacts.package.sha256}  ${manifest.artifacts.package.name}\n`,
    );
    // And the no-install guarantees stay recorded in the same JSON.
    assert.equal(manifest.runtime.requiresInstaller, false);
    assert.equal(manifest.runtime.installerExecuted, false);
    assert.equal(manifest.runtime.registryChanges, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("manifest isolation constants match the Rust source of truth", async () => {
  const source = await readFile(path.join(ROOT, "src-tauri", "src", "portable.rs"), "utf8");
  assert.ok(source.includes(`pub(crate) const DATA_DIR_ENV: &str = "${EXPECTED_ISOLATION.dataRootEnv}"`));
  assert.ok(source.includes(`= "${EXPECTED_ISOLATION.credentialService}"`));
  assert.ok(source.includes(`= "${EXPECTED_ISOLATION.singleInstanceMutex.replace(/\\/g, "\\\\")}"`));
  assert.ok(source.includes(`= "${EXPECTED_ISOLATION.windowTitle}"`));
  assert.ok(
    EXPECTED_ISOLATION.credentialService !== "com.nexus.aurea.remote",
    "the portable credential namespace must differ from the installed one",
  );
});
