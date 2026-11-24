// Genesis S3.5 CI-wiring guards (source-text, CRLF-normalized).
//
// Run with: pnpm test:genesis-ci  (or node --test this file)
//
// Asserts that .github/workflows/ci.yml still runs EVERY proof suite on BOTH
// OSes of the matrix (macos-latest + windows-latest) — including the new
// genesis suites — and that no existing step was weakened or removed, and
// that the portable Windows workflow still builds the no-install candidate.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) =>
  readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const ci = read(".github/workflows/ci.yml");
const portable = read(".github/workflows/portable-windows.yml");
const pkg = JSON.parse(read("package.json"));

test("ci.yml keeps the two-OS matrix (macos-latest + windows-latest) with fail-fast disabled", () => {
  assert.ok(ci.includes("os: [macos-latest, windows-latest]"));
  assert.ok(ci.includes("fail-fast: false"));
});

test("ci.yml runs every frontend/proof suite as its own step (both OSes via the matrix)", () => {
  const steps = [
    "pnpm test",
    "pnpm test:soak",
    "pnpm test:genesis",
    "pnpm test:genesis-soak",
    "pnpm test:claude-usage",
    "pnpm test:provenance",
    "pnpm test:portable-manifest",
    "pnpm test:portable-isolation",
    "pnpm test:genesis-ci",
    "pnpm test:manifest",
    "pnpm test:ipc-contract",
    "pnpm build",
    "pnpm manifest:sha256",
    "node scripts/sha256-manifest.mjs verify --manifest dist/sha256-manifest.json",
    "cargo test --locked --manifest-path src-tauri/Cargo.toml --lib",
    "git diff --check",
  ];
  for (const step of steps) {
    assert.ok(ci.includes(step), `ci.yml must run: ${step}`);
  }
  // The Windows-only and macOS-only Rust target checks stay.
  assert.ok(ci.includes("if: runner.os == 'Windows'"));
  assert.ok(ci.includes("if: runner.os == 'macOS'"));
  assert.ok(ci.includes("cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc"));
});

test("package.json declares the genesis + isolation scripts the CI runs", () => {
  assert.equal(pkg.scripts["test:genesis-soak"], "vitest run src/__tests__/genesisESoak.test.ts");
  assert.ok(pkg.scripts["test:genesis"].startsWith("vitest run"));
  assert.ok(pkg.scripts["test:genesis"].includes("genesisEIntegration.test.ts"));
  assert.ok(pkg.scripts["test:genesis"].includes("genesisELanSecurity.test.ts"));
  assert.ok(pkg.scripts["test:genesis"].includes("genesisEControllerSim.test.ts"));
  assert.ok(pkg.scripts["test:genesis"].includes("genesisEUiRegression.test.tsx"));
  assert.equal(pkg.scripts["test:portable-isolation"], "node --test scripts/portable-isolation-node-check.mjs");
  assert.equal(pkg.scripts["test:genesis-ci"], "node --test scripts/genesis-ci-node-check.mjs");
  // Pre-existing suites are untouched.
  assert.equal(pkg.scripts["test"], "vitest run");
  assert.equal(pkg.scripts["test:soak"], "vitest run src/__tests__/soakTransitions.test.ts");
  assert.equal(pkg.scripts["test:provenance"], "node --test scripts/build-provenance-node-check.mjs");
  assert.equal(pkg.scripts["test:portable-manifest"], "node --test scripts/portable-manifest-node-check.mjs");
  assert.equal(pkg.scripts["test:manifest"], "node --test scripts/sha256-manifest-node-check.mjs");
  assert.equal(pkg.scripts["test:claude-usage"], "node --test scripts/claude-usage-node-check.mjs");
  assert.equal(pkg.scripts["test:ipc-contract"], "node --test scripts/ipc-contract-node-check.mjs");
});

test("the genesis vitest files named in CI exist", () => {
  for (const file of [
    "src/__tests__/genesisEIntegration.test.ts",
    "src/__tests__/genesisELanSecurity.test.ts",
    "src/__tests__/genesisEControllerSim.test.ts",
    "src/__tests__/genesisESoak.test.ts",
    "src/__tests__/genesisEUiRegression.test.tsx",
    "scripts/portable-isolation-node-check.mjs",
    "scripts/genesis-ci-node-check.mjs",
  ]) {
    assert.ok(read(file).length > 0, `${file} must exist and be non-empty`);
  }
});

test("portable-windows.yml still builds the no-install candidate with its manifest checks", () => {
  assert.ok(portable.includes("pull_request:"));
  assert.ok(portable.includes("runs-on: windows-latest"));
  assert.ok(portable.includes("pnpm test:portable-manifest"));
  assert.ok(portable.includes("pnpm test:manifest"));
  assert.ok(portable.includes("pnpm test:portable-isolation"));
  assert.ok(portable.includes("pnpm test:genesis-ci"));
  assert.ok(portable.includes("pnpm test:ipc-contract"), "portable workflow must run the IPC contract drift check");
  assert.ok(portable.includes("'feat/velora-3-singularity*'"), "portable workflow must build push candidates for singularity branches");
  assert.ok(portable.includes("--no-bundle"), "the portable workflow must never produce an installer");
  assert.ok(portable.includes("VELORA-Portable-Windows-x64"));
});
