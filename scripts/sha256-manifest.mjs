// Local SHA-256 manifest for built artifacts (frontend dist/ and, when present,
// the portable bundle directory).
//
// Purpose: after `pnpm build` (and after a portable packaging run) a developer can
// produce a tamper-evident record of exactly which bytes were produced, from which
// source commit, in which tree state:
//
//   node scripts/sha256-manifest.mjs write                 # writes dist/sha256-manifest.json + .md
//   node scripts/sha256-manifest.mjs write --root dist --root dist/portable --output dist/sha256-manifest
//   node scripts/sha256-manifest.mjs verify --manifest dist/sha256-manifest.json
//   node scripts/sha256-manifest.mjs show   --manifest dist/sha256-manifest.json
//
// What this manifest is and is not:
//   * It records file path, byte size and SHA-256 for every walked file, the source
//     commit (`git rev-parse HEAD`), the dirty-tree flag and a UTC timestamp.
//   * It NEVER embeds file contents, so a manifest can be published safely.
//   * Secret-looking files (.env, keys, credential stores, ...) are excluded from
//     the walk and listed by path only under `excluded`.
//   * Like every hash manifest it proves internal consistency of the bytes with
//     this record; it is NOT a digital signature and NOT proof of who built them.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_KIND = "velora-sha256-manifest";
export const DEFAULT_ROOTS = ["dist", "dist/portable"];
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Directory names that are never walked (VCS internals, dependencies).
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules"]);

// File names that must never be hashed into a publishable manifest. Matching is
// case-insensitive on the basename; only the path is recorded, never the content.
const EXCLUDED_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,
  /^\.npmrc$/i,
  /^\.yarnrc(\.yml)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|kdbx|crt|cer)$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\..+)?$/i,
  /^(credentials?|secrets?|\.secrets?|.*\.secret|.*\.token|.*-token)(\..+)?$/i,
  /^wallet\.dat$/i,
  /^\.aws\//i,
];

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

function runGit(directory, args) {
  const result = spawnSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * Source provenance of the checkout that produced the artifacts:
 * the commit from `git rev-parse HEAD`, the branch, and whether the tree is
 * dirty (`git status --porcelain --untracked-files=all`). Outside a git
 * repository all three are null and the manifest says so explicitly.
 */
export function inspectGit(directory) {
  const root = runGit(directory, ["rev-parse", "--show-toplevel"]);
  if (!root) {
    return { repositoryRoot: null, commit: null, branch: null, dirty: null };
  }
  const commit = runGit(root, ["rev-parse", "HEAD"]);
  const branch = runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const status = spawnSync(
    "git",
    ["-C", root, "status", "--porcelain", "--untracked-files=all"],
    { encoding: "utf8", windowsHide: true },
  );
  const dirty = status.error || status.status !== 0 ? null : status.stdout.length > 0;
  return {
    repositoryRoot: root,
    commit: commit && FULL_SHA.test(commit) ? commit.toLowerCase() : null,
    branch: branch || null,
    dirty,
  };
}

/** True when the basename looks like it may hold credentials or key material. */
export function isExcludedFileName(name) {
  return EXCLUDED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

/** Deterministic, locale-independent ordering: plain code-unit comparison. */
export function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

/**
 * Recursively walk the given roots. Returns repo-relative POSIX paths sorted
 * deterministically. Symbolic links are never followed (no cycles, no escape
 * from the walked tree); the manifest's own output files are skipped as well.
 */
export async function collectFiles(rootPaths, { cwd, excludeAbsolutePaths = [] } = {}) {
  const exclude = new Set(excludeAbsolutePaths.map((entry) => path.resolve(entry)));
  const files = new Map(); // absolute path -> relative posix path
  const excluded = [];

  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    // Sort directory entries too, so traversal order itself is deterministic.
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) {
          excluded.push(toPosix(path.relative(cwd, absolute)));
          continue;
        }
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) {
        // Symlinks, sockets, fifos: never followed, never hashed.
        excluded.push(toPosix(path.relative(cwd, absolute)));
        continue;
      }
      if (isExcludedFileName(entry.name) || exclude.has(path.resolve(absolute))) {
        excluded.push(toPosix(path.relative(cwd, absolute)));
        continue;
      }
      files.set(path.resolve(absolute), toPosix(path.relative(cwd, absolute)));
    }
  }

  for (const root of rootPaths) {
    const absoluteRoot = path.resolve(cwd, root);
    const stats = await stat(absoluteRoot).catch(() => null);
    if (!stats || !stats.isDirectory()) continue; // missing roots are simply skipped
    await walk(absoluteRoot);
  }

  const list = [...files.entries()]
    .map(([absolute, relative]) => ({ absolute, path: relative }))
    .sort((left, right) => comparePaths(left.path, right.path));
  return { files: list, excluded: excluded.sort(comparePaths) };
}

/**
 * Build the manifest object. `now` is injectable so tests can make the output
 * byte-identical across runs; the CLI passes the real UTC time.
 */
export async function buildManifest(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const roots = (options.roots?.length ? options.roots : DEFAULT_ROOTS)
    .map((root) => toPosix(path.relative(cwd, path.resolve(cwd, root))) || ".");
  const now = options.now ? new Date(options.now) : new Date();
  assert.ok(!Number.isNaN(now.getTime()), "invalid timestamp");

  const git = inspectGit(cwd);
  const { files, excluded } = await collectFiles(roots, {
    cwd,
    excludeAbsolutePaths: options.excludeAbsolutePaths ?? [],
  });

  const records = [];
  let totalBytes = 0;
  for (const file of files) {
    const [digest, stats] = await Promise.all([sha256File(file.absolute), stat(file.absolute)]);
    records.push({ path: file.path, bytes: stats.size, sha256: digest });
    totalBytes += stats.size;
  }
  records.sort((left, right) => comparePaths(left.path, right.path));

  let app = null;
  try {
    const packageJson = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
    app = { name: packageJson.name ?? null, version: packageJson.version ?? null };
  } catch {
    app = null;
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    generatedAtUtc: now.toISOString(),
    app,
    source: {
      commit: git.commit,
      branch: git.branch,
      dirty: git.dirty,
      note:
        git.commit === null
          ? "not a git checkout: commit/branch/dirty are unknown"
          : "commit from `git rev-parse HEAD`; dirty from `git status --porcelain --untracked-files=all`",
    },
    roots,
    fileCount: records.length,
    totalBytes,
    files: records,
    excluded,
    verification: {
      digitalSignature: false,
      note:
        "SHA-256 records prove byte-for-byte consistency of the walked files with this record. " +
        "They are not a digital signature and do not prove who produced the files. " +
        "File contents are never embedded; secret-looking files are excluded by name.",
    },
  };
}

/** Human-readable rendering: a Markdown table with file, bytes and SHA-256. */
export function renderTextManifest(manifest) {
  const lines = [
    `# SHA-256 manifest — ${manifest.app ? `${manifest.app.name} ${manifest.app.version}` : "artifacts"}`,
    "",
    `- Generated (UTC): ${manifest.generatedAtUtc}`,
    `- Kind: ${manifest.kind} (schema ${manifest.schemaVersion})`,
    `- Source commit: ${manifest.source.commit ?? "unknown"} (branch: ${manifest.source.branch ?? "unknown"}, dirty: ${manifest.source.dirty ?? "unknown"})`,
    `- Roots walked: ${manifest.roots.join(", ") || "(none present)"}`,
    `- Files: ${manifest.fileCount} (${manifest.totalBytes} bytes total)`,
    `- Excluded by name/policy: ${manifest.excluded.length ? manifest.excluded.join(", ") : "none"}`,
    `- Not a digital signature; hashes prove consistency with this record only.`,
    "",
    "| file | bytes | sha256 |",
    "| --- | ---: | --- |",
  ];
  for (const record of manifest.files) {
    lines.push(`| ${record.path} | ${record.bytes} | ${record.sha256} |`);
  }
  lines.push("");
  return lines.join("\n");
}

/** Write `<outputPrefix>.json` and `<outputPrefix>.md`; returns both paths. */
export async function writeManifestFiles(manifest, outputPrefix) {
  const base = path.resolve(outputPrefix);
  await mkdir(path.dirname(base), { recursive: true });
  const jsonPath = `${base}.json`;
  const textPath = `${base}.md`;
  await writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(textPath, renderTextManifest(manifest), "utf8");
  return { jsonPath, textPath };
}

/** Read a manifest JSON (tolerates a BOM written by PowerShell tooling). */
export async function readManifestFile(manifestPath) {
  const text = await readFile(path.resolve(manifestPath), "utf8");
  return JSON.parse(text.replace(/^\uFEFF/, ""));
}

/**
 * Verify a manifest against the current tree: the walked file set must be
 * identical, every hash/size must match, and the file list must be in the
 * deterministic sorted order. Throws on the first problem.
 */
export async function verifyManifest(manifestPath, options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const manifest = await readManifestFile(manifestPath);
  assert.equal(manifest.schemaVersion, MANIFEST_SCHEMA_VERSION, "unsupported schemaVersion");
  assert.equal(manifest.kind, MANIFEST_KIND, "unexpected manifest kind");

  // The manifest's own output files are excluded from the walk; they may not
  // have existed when the manifest was written, so ignore them in the
  // excluded-list comparison as well.
  const resolvedManifest = path.resolve(manifestPath);
  const selfOutputs = new Set([
    resolvedManifest,
    `${resolvedManifest.replace(/\.json$/i, "")}.md`,
  ]);
  const { files, excluded } = await collectFiles(manifest.roots, {
    cwd,
    excludeAbsolutePaths: [...selfOutputs],
  });
  const comparableExcluded = excluded.filter(
    (entry) => !selfOutputs.has(path.resolve(cwd, entry)),
  );

  const actualPaths = files.map((file) => file.path);
  const expectedPaths = manifest.files.map((record) => record.path);
  assert.deepEqual(actualPaths, expectedPaths, "walked file set differs from the manifest (added/missing/renamed files)");
  assert.deepEqual(
    [...expectedPaths].sort(comparePaths),
    expectedPaths,
    "manifest file list is not in deterministic sorted order",
  );
  assert.deepEqual(comparableExcluded.sort(comparePaths), manifest.excluded, "excluded list differs");

  let totalBytes = 0;
  for (const record of manifest.files) {
    assert.match(record.sha256, HEX_SHA256, `bad sha256 format for ${record.path}`);
    const absolute = path.resolve(cwd, record.path);
    const [digest, stats] = await Promise.all([sha256File(absolute), stat(absolute)]);
    assert.equal(stats.size, record.bytes, `size mismatch for ${record.path}`);
    assert.equal(digest, record.sha256, `SHA-256 mismatch for ${record.path}`);
    totalBytes += stats.size;
  }
  assert.equal(manifest.fileCount, manifest.files.length, "fileCount disagrees with files[]");
  assert.equal(manifest.totalBytes, totalBytes, "totalBytes disagrees with files[]");
  return manifest;
}

/**
 * Parse `--key value`, repeated `--root value` and bare `--flag` arguments.
 * Repeated keys collect into arrays (`roots`); everything else keeps the last
 * value, exactly like the other scripts in this directory.
 */
export function parseArguments(argv) {
  const options = { roots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      if (key === "root") options.roots.push(next);
      else options[key] = next;
      index += 1;
    } else if (key === "root") {
      throw new Error("--root requires a directory value");
    } else {
      options[key] = "true";
    }
  }
  if (options.roots.length === 0) delete options.roots;
  return options;
}

function defaultOutputPrefix(cwd, roots) {
  const first = roots.find((root) => root !== ".") ?? "dist";
  return path.join(cwd, first, "sha256-manifest");
}

async function main() {
  const [command = "write", ...rest] = process.argv.slice(2);
  const options = parseArguments(rest);
  const cwd = path.resolve(options.cwd ?? process.cwd());

  if (command === "write") {
    const roots = options.roots ?? DEFAULT_ROOTS;
    const existingRoots = [];
    for (const root of roots) {
      const stats = await stat(path.resolve(cwd, root)).catch(() => null);
      if (stats?.isDirectory()) existingRoots.push(root);
    }
    if (existingRoots.length === 0) {
      process.stderr.write(
        `sha256-manifest: none of the roots exist under ${cwd}: ${roots.join(", ")}. ` +
          "Nothing to walk; pass --root <dir> or run `pnpm build` first.\n",
      );
    }
    const outputPrefix = path.resolve(cwd, options.output ?? defaultOutputPrefix(cwd, existingRoots.length ? existingRoots : roots));
    const manifest = await buildManifest({
      cwd,
      roots,
      now: options.now,
      excludeAbsolutePaths: [`${outputPrefix}.json`, `${outputPrefix}.md`],
    });
    const { jsonPath, textPath } = await writeManifestFiles(manifest, outputPrefix);
    process.stdout.write(
      `sha256-manifest: wrote ${jsonPath} and ${textPath}\n` +
        `source commit: ${manifest.source.commit ?? "unknown"} (dirty: ${manifest.source.dirty ?? "unknown"})\n` +
        `files: ${manifest.fileCount} (${manifest.totalBytes} bytes) from roots: ${manifest.roots.join(", ")}\n` +
        `excluded by policy: ${manifest.excluded.length}\n`,
    );
    return;
  }
  if (command === "verify") {
    if (!options.manifest) throw new Error("verify requires --manifest <path-to-sha256-manifest.json>");
    const manifest = await verifyManifest(options.manifest, { cwd });
    process.stdout.write(
      `sha256-manifest verified: ${manifest.fileCount} files, ${manifest.totalBytes} bytes, ` +
        `commit ${manifest.source.commit ?? "unknown"}\n`,
    );
    return;
  }
  if (command === "show") {
    if (!options.manifest) throw new Error("show requires --manifest <path-to-sha256-manifest.json>");
    const manifest = await readManifestFile(options.manifest);
    process.stdout.write(renderTextManifest(manifest));
    return;
  }
  throw new Error(`Unknown command: ${command}. Use write, verify or show.`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    process.stderr.write(`sha256-manifest: ${error.message}\n`);
    process.exitCode = 1;
  });
}
