// Provenance manifest for the portable, no-install VELORA Windows validation build.
//
// Unlike the NSIS provenance script (build-provenance.mjs), this describes a
// standalone ZIP, not an installer. It records:
//   * the exact source commit that was checked out and compiled,
//   * the GitHub Actions run that produced the artifact,
//   * SHA-256 + size of the ZIP and of every file inside it,
//   * the isolation identity compiled into / configured for the candidate,
//   * a bounded CI startup/shutdown result when one was recorded.
//
// A manifest is NOT a digital signature. Hashes prove internal consistency of
// the downloaded bytes with this record; they do not prove who built them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILE_NAME = "velora-portable-manifest.json";
export const EXECUTABLE_NAME = "nexus-aurea.exe";

// These must stay identical to the values in src-tauri/src/portable.rs. The
// node test suite checks them against that source file as well.
export const EXPECTED_ISOLATION = Object.freeze({
  dataRootEnv: "VELORA_PORTABLE_DATA_DIR",
  credentialService: "com.nexus.aurea.remote.portable-validation",
  singleInstanceMutex: "Local\\pl.nexus.aurea.portable-validation.single-instance",
  windowTitle: "VELORA (Portable Validation)",
  redirectedEnvironment: ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "TEMP", "TMP"],
});

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** SHA-256 of a file, streamed so large EXEs/ZIPs do not load into memory. */
export async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function fileRecord(filePath, name) {
  const [digest, stats] = await Promise.all([sha256File(filePath), stat(filePath)]);
  return {
    name,
    sizeBytes: stats.size,
    sha256: digest,
  };
}

/** Read JSON produced by either Node or Windows PowerShell (which adds a BOM). */
async function readJson(filePath) {
  const text = await readFile(filePath, "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

function required(options, key) {
  const value = options[key];
  assert.ok(value !== undefined && value !== "" && value !== null, `--${key} is required`);
  return String(value);
}

function optional(options, key, fallback = null) {
  const value = options[key];
  return value === undefined || value === "" || value === null ? fallback : String(value);
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true";
}

/** Parse `--key value` / `--flag` arguments without pulling in a CLI library. */
export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = "true";
    }
  }
  return options;
}

/** Build the manifest object from files that already exist on disk. */
export async function createPortableManifest(options) {
  const sourceSha = required(options, "sourceSha").toLowerCase();
  const checkoutSha = optional(options, "checkoutSha", sourceSha).toLowerCase();
  const eventSha = optional(options, "eventSha", sourceSha).toLowerCase();
  assert.match(sourceSha, /^[0-9a-f]{40}$/, "--sourceSha must be a full 40-hex commit SHA");
  assert.match(checkoutSha, /^[0-9a-f]{40}$/, "--checkoutSha must be a full 40-hex commit SHA");
  assert.match(eventSha, /^[0-9a-f]{40}$/, "--eventSha must be a full 40-hex commit SHA");

  const stage = path.resolve(required(options, "stage"));
  const executablePath = path.resolve(required(options, "executable"));
  const packagePath = path.resolve(required(options, "package"));
  assert.equal(
    path.basename(executablePath),
    EXECUTABLE_NAME,
    `the executable must be named ${EXECUTABLE_NAME}`,
  );
  assert.ok(path.dirname(executablePath) === stage, "the executable must live at the stage root");

  const supportNames = (await readdir(stage, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== EXECUTABLE_NAME)
    .map((entry) => entry.name)
    .sort();

  const [packageRecord, executableRecord, supportRecords] = await Promise.all([
    fileRecord(packagePath, path.basename(packagePath)),
    fileRecord(executablePath, EXECUTABLE_NAME),
    Promise.all(
      supportNames.map((name) => fileRecord(path.join(stage, name), name)),
    ),
  ]);

  let smoke = { status: "not-recorded" };
  const smokeFile = optional(options, "smokeFile");
  if (smokeFile) {
    smoke = await readJson(path.resolve(smokeFile));
  }

  const pullRequest =
    options.prNumber !== undefined
      ? {
          number: Number(required(options, "prNumber")),
          headSha: required(options, "prHeadSha").toLowerCase(),
          baseSha: required(options, "prBaseSha").toLowerCase(),
          headRef: optional(options, "prHeadRef", ""),
          baseRef: optional(options, "prBaseRef", ""),
        }
      : null;

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: "velora-portable-validation-build",
    generatedAt: new Date().toISOString(),
    app: {
      name: "VELORA",
      version: required(options, "appVersion"),
      product: "portable-validation-candidate",
    },
    source: {
      sourceSha,
      checkoutSha,
      eventSha,
      ref: required(options, "ref"),
      event: required(options, "event"),
      branch: optional(options, "branch", ""),
      dirty: parseBoolean(options.dirty, false),
      pullRequest,
      runId: required(options, "runId"),
      runAttempt: required(options, "runAttempt"),
      runUrl: required(options, "runUrl"),
      workflow: required(options, "workflow"),
      actor: optional(options, "actor", ""),
    },
    build: {
      target: required(options, "target"),
      profile: "release",
      bundle: "none (standalone executable, portable ZIP)",
      runnerOs: required(options, "runnerOs"),
    },
    artifacts: {
      package: packageRecord,
      executable: executableRecord,
      supportFiles: supportRecords,
    },
    isolation: { ...EXPECTED_ISOLATION },
    runtime: {
      requiresInstaller: false,
      installerExecuted: false,
      registryChanges: false,
      requirements: [
        "Windows 10/11 x64",
        "WebView2 Runtime (Evergreen) already installed - no bootstrapper is bundled or run",
        "Microsoft Edge installed for optional Edge Cinema streaming",
      ],
      launch: "Run-VELORA-Portable.cmd (the executable initializes its sibling isolated profile)",
    },
    verification: {
      digitalSignature: false,
      hardwareValidated: false,
      note:
        "Hashes prove byte-for-byte consistency of the downloaded files with this record. " +
        "They are not a digital signature and are not proof of authenticity. " +
        "No physical DS4, iPhone or Panasonic hardware test is claimed.",
    },
    smoke,
  };
}

/** Recompute all hashes and compare them with a manifest on disk. */
export async function verifyPortableManifest(manifestPath, options = {}) {
  const manifest = await readJson(path.resolve(manifestPath));
  const base = options.base ? path.resolve(options.base) : path.dirname(path.resolve(manifestPath));
  const packagePath = options.package ? path.resolve(options.package) : path.join(base, manifest.artifacts.package.name);
  const stage = options.stage ? path.resolve(options.stage) : path.join(base, "stage");

  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION, "unsupported schemaVersion");
  assert.equal(manifest.kind, "velora-portable-validation-build", "unexpected manifest kind");
  assert.match(manifest.source.sourceSha, FULL_SHA, "sourceSha is not a full commit SHA");
  assert.equal(manifest.source.checkoutSha, manifest.source.sourceSha, "checkout SHA differs from source SHA");
  assert.equal(manifest.verification.digitalSignature, false, "manifest must not claim a digital signature");
  assert.equal(manifest.verification.hardwareValidated, false, "manifest must not claim hardware validation");
  assert.deepEqual(manifest.isolation, EXPECTED_ISOLATION, "isolation settings are not the reviewed portable values");

  const packageRecord = await fileRecord(packagePath, path.basename(packagePath));
  assert.deepEqual(packageRecord, manifest.artifacts.package, "ZIP hash/size mismatch");

  const executableRecord = await fileRecord(
    path.join(stage, manifest.artifacts.executable.name),
    manifest.artifacts.executable.name,
  );
  assert.deepEqual(executableRecord, manifest.artifacts.executable, "EXE hash/size mismatch");

  for (const record of manifest.artifacts.supportFiles) {
    assert.match(record.sha256, HEX_SHA256, `bad hash format for ${record.name}`);
    const actual = await fileRecord(path.join(stage, record.name), record.name);
    assert.deepEqual(actual, record, `support file hash/size mismatch: ${record.name}`);
  }

  return manifest;
}

/** Write the SHA256SUMS.txt that ships next to the ZIP. */
export function renderSha256Sums(records) {
  return records
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((record) => `${record.sha256}  ${record.name}\n`)
    .join("");
}

export async function writeManifestFile(filePath, manifest) {
  await mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseArguments(rest);
  if (command === "write") {
    const manifest = await createPortableManifest(options);
    const output = required(options, "manifest");
    await writeManifestFile(output, manifest);
    if (options.sums) {
      await writeFile(
        path.resolve(options.sums),
        renderSha256Sums([manifest.artifacts.package]),
        "utf8",
      );
    }
    process.stdout.write(
      `portable manifest: ${output}\n` +
        `source: ${manifest.source.sourceSha}\n` +
        `package: ${manifest.artifacts.package.sha256}  ${manifest.artifacts.package.name}\n` +
        `executable: ${manifest.artifacts.executable.sha256}  ${manifest.artifacts.executable.name}\n`,
    );
    return;
  }
  if (command === "verify") {
    const manifest = await verifyPortableManifest(required(options, "manifest"), options);
    process.stdout.write(
      `portable manifest verified: ${manifest.source.sourceSha} / ${manifest.artifacts.package.name}\n`,
    );
    return;
  }
  throw new Error(`Unknown command: ${command ?? "(none)"}. Use write or verify.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    process.stderr.write(`portable-manifest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
