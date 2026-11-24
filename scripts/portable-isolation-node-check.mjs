// Portable data-root isolation invariants, asserted as SOURCE TEXT.
//
// Run with: pnpm test:portable-isolation  (or node --test this file)
//
// The portable validation candidate must stay fully isolated from the
// installed VELORA build: the launcher sets VELORA_PORTABLE_DATA_DIR, lib.rs
// redirects the Tauri app directories (which includes the WebView2 user-data
// directory on Windows) into that root, and portable.rs keeps a disjoint
// credential-service / mutex / window-title identity. These guards fail
// loudly if any of that is weakened. Sources are read with CRLF normalized so
// the suite passes on Windows checkouts too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXPECTED_ISOLATION } from "./portable-manifest.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) =>
  readFileSync(path.join(ROOT, relative), "utf8").replace(/\r\n/g, "\n");

const portableRs = read("src-tauri/src/portable.rs");
const cargo = read("src-tauri/Cargo.toml");
const workflow = read(".github/workflows/portable-windows.yml");
const libRs = read("src-tauri/src/lib.rs");
const launcherPs1 = read("scripts/portable/Start-VELORA-Portable.ps1");
const launcherCmd = read("scripts/portable/Run-VELORA-Portable.cmd");
const preflight = read("scripts/portable/Preflight-WebView2.ps1");
const manifestMjs = read("scripts/portable-manifest.mjs");

test("portable.rs consumes VELORA_PORTABLE_DATA_DIR and treats empty as not portable", () => {
  assert.ok(portableRs.includes('pub(crate) const DATA_DIR_ENV: &str = "VELORA_PORTABLE_DATA_DIR";'));
  assert.ok(portableRs.includes("std::env::var_os(DATA_DIR_ENV)"));
  assert.ok(portableRs.includes(".filter(|value| !value.is_empty())"));
  assert.ok(portableRs.includes("pub(crate) fn data_dir() -> Option<PathBuf> {"));
  assert.ok(portableRs.includes("pub(crate) fn is_portable() -> bool {"));
});

test("portable identity stays disjoint from the installed identity (service, mutex, title)", () => {
  // Installed values are pinned and must never change.
  assert.ok(portableRs.includes('pub(crate) const INSTALLED_CREDENTIAL_SERVICE: &str = "com.nexus.aurea.remote";'));
  assert.ok(portableRs.includes('pub(crate) const INSTALLED_MUTEX_NAME: &str = "Local\\\\pl.nexus.aurea.single-instance";'));
  assert.ok(portableRs.includes('pub(crate) const INSTALLED_WINDOW_TITLE: &str = "VELORA";'));
  // Portable values carry the portable-validation suffix.
  assert.ok(portableRs.includes('"com.nexus.aurea.remote.portable-validation"'));
  assert.ok(portableRs.includes('"Local\\\\pl.nexus.aurea.portable-validation.single-instance"'));
  assert.ok(portableRs.includes('"VELORA (Portable Validation)"'));
  // The portable credential service keeps the installed name as a prefix and
  // stays session-local (Local\ mutex).
  assert.ok(portableRs.includes("assert!(credential_service_for(true).starts_with(INSTALLED_CREDENTIAL_SERVICE));"));
  assert.ok(portableRs.includes('assert!(mutex_name_for(true).starts_with("Local\\\\"));'));
});

test("lib.rs redirects the Tauri app directories (incl. the WebView2 user-data dir) into the portable root", () => {
  assert.ok(libRs.includes("fn startup_context(windowed: bool) -> tauri::Context<tauri::Wry> {"));
  assert.ok(libRs.includes("if let Some(root) = portable::data_dir() {"));
  assert.ok(libRs.includes("use tauri::utils::config::AppDirectoriesOverride;"));
  assert.ok(libRs.includes("context.config_mut().app.app_directories_override ="));
  assert.ok(libRs.includes("Some(AppDirectoriesOverride::Root(root));"));
  // The doc comment pins the WebView2 user-data redirect.
  assert.ok(libRs.includes("`appDirectoriesOverride` also redirects Tauri's default WebView2 user-data"));
  assert.ok(libRs.includes("window.title = portable::window_title_for(portable).to_string();"));
  // The application builds the context before entering Tauri.
  assert.ok(libRs.includes(".build(context)"));
});

test("the portable feature guarantees a sibling profile on direct EXE launch", () => {
  assert.ok(cargo.includes("portable-validation = []"));
  assert.ok(workflow.includes("--features portable-validation"));
  assert.ok(portableRs.includes("env::current_exe()?"));
  assert.ok(portableRs.includes("directory.join(DATA_DIR_NAME)"));
  assert.ok(portableRs.includes('const DATA_DIR_NAME: &str = "VELORA-Portable-Data";'));
  assert.ok(libRs.indexOf("initialize_portable_startup()") < libRs.indexOf("claim_or_activate_existing()"));
  assert.ok(launcherCmd.includes('"%~dp0nexus-aurea.exe" %*'));
  assert.ok(launcherCmd.includes("setlocal DisableDelayedExpansion"));
  assert.doesNotMatch(launcherCmd, /powershell|ExecutionPolicy/i);
});

test("CI verifies a visible window, React readiness and clean exit without archiving the profile", () => {
  assert.ok(workflow.includes("Join-Path $smokeDir 'nexus-aurea.exe'"));
  assert.ok(workflow.includes("MainWindowHandle -ne 0"));
  assert.ok(workflow.includes("^window-visible"));
  assert.ok(workflow.includes("^frontend-ready"));
  assert.ok(workflow.includes("^exit-orderly"));
  assert.ok(workflow.includes("Require passing Windows startup evidence"));
});

test("the portable scripts never run an installer and never write the registry", () => {
  const writers = ["New-ItemProperty", "Set-ItemProperty", "reg add", "regedit", "msiexec", "Start-Process -FilePath 'msiexec"];
  for (const script of [launcherPs1, launcherCmd, preflight]) {
    for (const writer of writers) {
      assert.ok(!script.includes(writer), `portable script must not contain ${writer}`);
    }
  }
  // The preflight may only READ the WebView2 registry key.
  assert.ok(preflight.includes("HKCU:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\"));
  assert.ok(preflight.includes("never installs, downloads or changes"));
  assert.ok(launcherPs1.includes("Never runs an installer and never changes the registry."));
});

test("the portable manifest tooling pins the same isolation identity as portable.rs", () => {
  assert.equal(EXPECTED_ISOLATION.dataRootEnv, "VELORA_PORTABLE_DATA_DIR");
  assert.ok(portableRs.includes(`"${EXPECTED_ISOLATION.dataRootEnv}"`));
  assert.ok(portableRs.includes(`"${EXPECTED_ISOLATION.credentialService}"`));
  // Rust source escapes backslashes, so compare against the doubled form.
  const rustLiteral = (value) => value.replace(/\\/g, "\\\\");
  assert.ok(portableRs.includes(`"${rustLiteral(EXPECTED_ISOLATION.singleInstanceMutex)}"`));
  assert.ok(portableRs.includes(`"${EXPECTED_ISOLATION.windowTitle}"`));
  for (const variable of EXPECTED_ISOLATION.redirectedEnvironment) {
    assert.ok(portableRs.includes(`env::set_var("${variable}",`), `manifest lists ${variable} but native startup does not set it`);
  }
  // The manifest records the no-install runtime contract.
  assert.ok(manifestMjs.includes("requiresInstaller: false"));
  assert.ok(manifestMjs.includes("installerExecuted: false"));
  assert.ok(manifestMjs.includes("registryChanges: false"));
  assert.ok(manifestMjs.includes('launch: "Run-VELORA-Portable.cmd (the executable initializes its sibling isolated profile)"'));
});
