/**
 * Workstream S3.5 (Agent E, genesis) — DETERMINISTIC INTEGRATION GUARD.
 *
 * 1. IPC contract consistency: every command documented in
 *    `src/contracts/ipc.ts` (`IPC_COMMANDS`) must be registered in the
 *    `generate_handler![...]` list of `src-tauri/src/lib.rs`, every command
 *    that existed at the verified base commit ded73f4 must still be
 *    registered (nothing from Ascension may be removed), and every handler
 *    that is not part of the base set must be documented in the contract
 *    (new commands are additive and documented at integration).
 * 2. Fail-closed remote invariants and window-ownership invariants asserted
 *    as SOURCE-TEXT guards (same pattern as ascensionDSecurity.test.ts):
 *    HMAC prefix, 4096-byte body limit, trust_confirmed gate, rustls TLS,
 *    replay persist-before-emit, the exact 11-route LAN allowlist, no global
 *    input hooks, no process killing (observation-only), and
 *    PLAYBACK_STATE_READ_SUPPORTED stays false.
 *
 * Sources are read as text with CRLF normalized to LF so the guards pass on
 * Windows checkouts too (the lesson recorded in PR #73).
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { IPC_COMMANDS, isIpcCommandName, ipcDescriptor } from "../contracts/ipc";

// Normalize CRLF: CI checks out with Windows line endings on windows-latest.
const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");

const libRs = read("src-tauri/src/lib.rs");
const rustDir = resolve(process.cwd(), "src-tauri/src");
const rustSources = new Map(
  readdirSync(rustDir)
    .filter((name) => name.endsWith(".rs"))
    .map((name) => [name, read(`src-tauri/src/${name}`)] as const),
);
const allRust = [...rustSources.values()].join("\n");

// --- Parsers ---------------------------------------------------------------

/** Command names registered in lib.rs's generate_handler![...] block. */
function registeredHandlers(source: string): string[] {
  const block = source.match(/generate_handler!\[([\s\S]*?)\]\)/);
  expect(block, "lib.rs must contain generate_handler![...]").not.toBeNull();
  return [...block![1].matchAll(/([a-z_][a-z_0-9]*)::([a-z_][a-z_0-9]*)/g)].map((match) => match[2]);
}

/**
 * The exact command set registered at the verified base commit ded73f4
 * (feat/velora-3-genesis tip). Ascension functionality must never shrink:
 * every entry here has to stay registered.
 */
const BASE_HANDLERS: readonly string[] = [
  "get_system_audio", "set_system_audio_volume", "set_system_audio_mute",
  "get_managed_sessions", "resume_managed_session", "close_managed_session",
  "exit_velora", "restart_velora",
  "get_tv_mode_status", "set_tv_mode",
  "get_platform_launcher_status", "get_claude_usage", "launch_platform",
  "get_native_controller_status", "set_controller_home_enabled",
  "get_controller_fallback_status", "configure_controller_fallback",
  "get_streaming_control_status", "configure_streaming_control",
  "get_tv_navigation_status", "configure_tv_navigation", "set_tv_navigation_mode",
  "set_tv_navigation_media_controls", "capture_tv_navigation_target",
  "simulate_tv_navigation_action", "cancel_tv_navigation_simulation",
  "get_control_service_status", "start_control_service", "set_control_game_mode",
  "stop_control_service", "get_fallback_hotkey_options", "set_fallback_hotkey",
  "get_display_audio_status", "get_diagnostics_snapshot", "export_diagnostics_report",
  "get_remote_access_status", "begin_remote_trust_approval", "inspect_remote_trust_profile",
  "prepare_remote_trust_profile", "cleanup_remote_trust_artifacts", "start_remote_access",
  "begin_remote_pairing", "stop_remote_access", "revoke_all_remote_devices",
  "revoke_remote_device", "inspect_remote_recovery", "run_remote_recovery",
  "get_app_manager_status", "get_gaming_diagnostics", "launch_managed_app", "launch_managed_game",
  "get_apple_music_status", "control_apple_music", "adjust_system_volume",
  "get_session_state", "get_session_operations", "cancel_session_operation",
  "request_session_transition", "return_velora_home",
  "get_window_broker_status", "restore_velora_window",
  "get_launch_registry_status", "cancel_launch_session",
  "launch_edge_cinema", "get_edge_cinema_status", "get_edge_cinema_session",
  "request_edge_cinema_close", "report_edge_cinema_exit", "reset_edge_cinema_session",
  "get_autostart_status", "set_autostart_enabled", "get_startup_mode",
  "get_autostart_diagnostics", "get_autostart_recovery",
  "get_playnite_library", "launch_playnite_game", "get_playnite_manifest",
];

const handlers = registeredHandlers(libRs);
const contractNames = Object.keys(IPC_COMMANDS);

describe("genesis E: IPC contract registry is consistent with the Tauri handler list", () => {
  it("registers exactly the base command set or more — no Ascension command was removed", () => {
    expect(handlers.length).toBeGreaterThanOrEqual(BASE_HANDLERS.length);
    for (const base of BASE_HANDLERS) {
      expect(handlers, `base command ${base} must stay registered in lib.rs`).toContain(base);
    }
    // No duplicates in the handler list.
    expect(new Set(handlers).size).toBe(handlers.length);
  });

  it("documents every contract command and registers every documented command", () => {
    for (const name of contractNames) {
      expect(isIpcCommandName(name)).toBe(true);
      expect(ipcDescriptor(name)?.name).toBe(name);
      expect(handlers, `contract command ${name} must be registered in lib.rs`).toContain(name);
    }
  });

  it("registers no undocumented command beyond the base set (new commands are documented at integration)", () => {
    const base = new Set(BASE_HANDLERS);
    for (const handler of handlers) {
      if (!base.has(handler)) {
        expect(contractNames, `handler ${handler} is new since ded73f4 and must be documented in contracts/ipc.ts`).toContain(handler);
      }
    }
  });

  it("keeps every contract descriptor structurally valid (args/sideEffect/since)", () => {
    const sideEffects = new Set(["read-only", "write", "launch", "close-request", "event"]);
    for (const [key, descriptor] of Object.entries(IPC_COMMANDS)) {
      expect(descriptor.name).toBe(key);
      expect(Array.isArray(descriptor.args)).toBe(true);
      expect(typeof descriptor.returns).toBe("string");
      expect(descriptor.returns.length).toBeGreaterThan(0);
      expect(sideEffects.has(descriptor.sideEffect)).toBe(true);
      expect(typeof descriptor.since).toBe("string");
      expect(descriptor.since.length).toBeGreaterThan(0);
    }
    expect(ipcDescriptor("definitely_not_a_command")).toBeNull();
    expect(isIpcCommandName("definitely_not_a_command")).toBe(false);
  });

  it("keeps command names valid snake_case Tauri identifiers in both sources", () => {
    for (const name of [...handlers, ...contractNames]) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});

describe("genesis E: fail-closed remote invariants (source-text guards, CRLF-normalized)", () => {
  const remote = rustSources.get("remote_access.rs")!;
  const reliability = rustSources.get("remote_reliability.rs")!;

  it("keeps the HMAC-SHA256 NEXUS-AUREA-REMOTE-V1 payload format and signature verifier", () => {
    expect(remote).toContain('"NEXUS-AUREA-REMOTE-V1\\n{device_id}\\n{sequence}\\n{}"');
    expect(remote).toContain("fn verify_command_signature(");
    expect(remote).toContain("Hmac::<Sha256>");
    expect(reliability).toContain("fn command_id(");
  });

  it("keeps the 4096-byte request body limit and the rustls TLS server with the trust_confirmed gate", () => {
    expect(remote).toContain("const MAX_REQUEST_BYTES: usize = 4096;");
    expect(remote).toContain("DefaultBodyLimit::max(MAX_REQUEST_BYTES)");
    expect(remote).toContain("use axum_server::tls_rustls::RustlsConfig;");
    expect(remote).toContain("RustlsConfig::from_pem");
    expect(remote).toContain("if !trust_confirmed {");
    // Fail-closed: an unconfirmed trust profile can never start the LAN server.
    expect(remote).toContain("Zainstaluj profil zaufania na iPhonie i włącz jego pełne zaufanie przed startem serwera.");
  });

  it("keeps the replay guard with the monotonic sequence persisted BEFORE the command is emitted", () => {
    for (const literal of [
      "fn sequence_is_fresh(",
      "classify_replay",
      "ReplayDecision::RejectReplay",
      "ReplayDecision::AcknowledgeReplay",
      "ReplayDecision::Ambiguous",
      "fn rollback_command_reservation(",
      "fn record_command_receipt(",
    ]) {
      expect(remote).toContain(literal);
    }
    // Source order proves persist-before-emit (the same invariant the Rust
    // unit test asserts with find() offsets).
    const reserveAt = remote.indexOf("vault.devices[index].last_sequence = sequence;");
    const emitAt = remote.indexOf('.emit("nexus-remote-command"');
    expect(reserveAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(reserveAt).toBeLessThan(emitAt);
  });

  it("keeps the LAN route allowlist EXACTLY the existing 11 routes", () => {
    const routes = [...remote.matchAll(/\.route\("([^"]+)"/g)].map((match) => match[1]);
    expect(routes).toEqual([
      "/",
      "/index.html",
      "/app.js",
      "/style.css",
      "/manifest.webmanifest",
      "/sw.js",
      "/icon.svg",
      "/api/status",
      "/api/hello",
      "/api/pair",
      "/api/command",
    ]);
  });

  it("keeps Host/Origin exact-match, CSP and the non-GET /api guard", () => {
    for (const literal of [
      "fn is_allowed_request(",
      "host != Some(expected_host)",
      'path.starts_with("/api/") && method != "GET"',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    ]) {
      expect(remote).toContain(literal);
    }
  });

  it("never weakens TLS or auth anywhere in the Rust backend", () => {
    for (const forbidden of [
      "danger_accept_invalid_certs",
      "danger_accept_invalid_hostnames",
      "accept_invalid",
      "no-cors",
      "skip verification",
    ]) {
      expect(allRust, `src-tauri must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("genesis E: no global input hooks and no process killing (observation-only)", () => {
  it("registers no global Windows input hooks in any Rust source", () => {
    for (const forbidden of ["SetWindowsHookEx", "WH_KEYBOARD_LL", "WH_MOUSE_LL", "WH_KEYBOARD", "WH_MOUSE"]) {
      expect(allRust, `src-tauri must not contain global hook ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("never terminates any process: no TerminateProcess / PROCESS_TERMINATE anywhere", () => {
    expect(allRust).not.toContain("TerminateProcess");
    expect(allRust).not.toContain("PROCESS_TERMINATE");
    // Process inspection stays read-only (query limited information only).
    expect(rustSources.get("process_table.rs")).toContain("PROCESS_QUERY_LIMITED_INFORMATION");
  });

  it("keeps PLAYBACK_STATE_READ_SUPPORTED false (no fabricated playback progress)", () => {
    expect(rustSources.get("streaming_control.rs")).toContain(
      "pub(crate) const PLAYBACK_STATE_READ_SUPPORTED: bool = false;",
    );
  });
});

describe("genesis E: window-ownership invariants (source-text guards)", () => {
  const broker = rustSources.get("window_broker.rs")!;

  it("attaches exactly the one VELORA main window as the ownership anchor", () => {
    expect(libRs).toContain('app.get_webview_window("main")');
    expect(libRs).toContain("window_broker::attach_main_window(");
    expect(broker).toContain("pub(crate) fn attach_main_window(");
  });

  it("keeps own_window / own_window_valid gating so only VELORA's own window is ever focused", () => {
    for (const literal of ["own_window", "own_window_valid", "own_process_id", "fn classify_foreground_denial("]) {
      expect(broker).toContain(literal);
    }
    // A denied foreground request is reported truthfully as unknown, never forced.
    expect(broker).toContain("ForegroundDenial::Unknown");
    expect(broker).toContain("Windows zablokował automatyczny fokus");
  });

  it("keeps the close path a request, never a kill (Edge Cinema contract)", () => {
    const cinema = rustSources.get("edge_cinema.rs")!;
    expect(cinema).not.toContain("TerminateProcess");
    expect(cinema).not.toContain("PROCESS_TERMINATE");
    expect(IPC_COMMANDS.request_edge_cinema_close.returns).toContain("NIE zabija procesu");
  });
});
