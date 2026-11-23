/**
 * Workstream S3.5 (Agent E, genesis) — LAN SECURITY SOURCE-TEXT GUARDS.
 *
 * Extends the ascensionDSecurity pattern for the genesis integration branch:
 * reads `src-tauri/src/remote_access.rs`, `remote_reliability.rs`,
 * `remote_state_lock.rs` and `credential_store.rs` AS TEXT (CRLF normalized,
 * so the guards pass on Windows checkouts) and fails loudly if any LAN
 * security control is weakened:
 *   - TLS stays rustls (`RustlsConfig::from_pem`) behind the `trust_confirmed`
 *     gate — the server cannot start without a fully trusted profile;
 *   - every command is HMAC-SHA256 signed over the
 *     `NEXUS-AUREA-REMOTE-V1\n{device_id}\n{sequence}\n{command}` payload;
 *   - the monotonic sequence is reserved/persisted BEFORE the side effect is
 *     emitted (replay persist-before-emit) and replay classification is
 *     fail-closed (RejectReplay / Ambiguous, never auto-executed);
 *   - the LAN route allowlist is EXACTLY the 11 existing routes;
 *   - request size stays capped at 4096 bytes, Host/Origin are exact-matched,
 *     non-GET /api is gated, CSP is unchanged;
 *   - no alternate transport / cert-validation bypass anywhere;
 *   - the credential store keeps its size cap and cross-process fail-closed
 *     state lock — secrets never weaken or bypass the vault.
 *
 * The forbidden tokens below appear ONLY inside negative assertions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Normalize CRLF: CI checks out with Windows line endings on windows-latest.
const read = (path: string): string =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");

const remote = read("src-tauri/src/remote_access.rs");
const reliability = read("src-tauri/src/remote_reliability.rs");
const stateLock = read("src-tauri/src/remote_state_lock.rs");
const credentials = read("src-tauri/src/credential_store.rs");
const lanSources = [remote, reliability, stateLock, credentials].join("\n");

describe("genesis E: LAN remote keeps rustls TLS behind the trust_confirmed fail-closed gate", () => {
  it("serves HTTPS only through axum-server rustls from the vault CA material", () => {
    expect(remote).toContain("use axum_server::tls_rustls::RustlsConfig;");
    expect(remote).toContain("RustlsConfig::from_pem(cert_pem.into_bytes(), key_pem.into_bytes())");
    expect(remote).toContain("axum_server::from_tcp_rustls(listener, tls)");
    // The CA-signed leaf is generated per start, never from a static key.
    expect(remote).toContain("KeyPair::generate()");
  });

  it("refuses to start the LAN server when the trust profile is not fully confirmed", () => {
    expect(remote).toContain("trust_confirmed: bool,");
    expect(remote).toContain("if !trust_confirmed {");
    expect(remote).toContain(
      "Zainstaluj profil zaufania na iPhonie i włącz jego pełne zaufanie przed startem serwera.",
    );
    // The gate is source-order first: before any listener bind or route setup.
    const gateAt = remote.indexOf("if !trust_confirmed {");
    const bindAt = remote.indexOf("TcpListener::bind(address)");
    expect(gateAt).toBeGreaterThan(-1);
    expect(bindAt).toBeGreaterThan(gateAt);
  });

  it("never accepts invalid certificates or downgrades anywhere in the LAN stack", () => {
    for (const forbidden of [
      "danger_accept_invalid_certs",
      "danger_accept_invalid_hostnames",
      "accept_invalid",
      "no-cors",
      "skip verification",
      "plaintext",
      "http_only",
    ]) {
      expect(lanSources, `LAN sources must not contain ${forbidden}`).not.toContain(forbidden);
    }
  });
});

describe("genesis E: LAN commands stay HMAC-SHA256 authenticated with the pinned payload prefix", () => {
  it("keeps the NEXUS-AUREA-REMOTE-V1 payload format byte-identical in Rust", () => {
    expect(remote).toContain('"NEXUS-AUREA-REMOTE-V1\\n{device_id}\\n{sequence}\\n{}"');
    expect(remote).toContain("fn verify_command_signature(");
    expect(remote).toContain("Hmac::<Sha256>");
    // The pairing hello uses the same pinned prefix with a nonce.
    expect(remote).toContain("NEXUS-AUREA-REMOTE-V1");
  });

  it("keeps the deterministic command id and the fail-closed replay classifier", () => {
    expect(reliability).toContain("pub fn command_id(device_id: &str, sequence: u64) -> String {");
    expect(reliability).toContain('format!("{}\\u{1f}{}", device_id, sequence)');
    expect(reliability).toContain("pub fn sequence_is_fresh(last: u64, next: u64) -> bool {");
    expect(reliability).toContain("pub fn classify_replay(");
    expect(reliability).toContain("ReplayDecision::Execute");
    expect(reliability).toContain("ReplayDecision::AcknowledgeReplay");
    expect(reliability).toContain("ReplayDecision::Ambiguous");
    expect(reliability).toContain("ReplayDecision::RejectReplay");
    // A replay of the same sequence with a DIFFERENT command is rejected,
    // and an ambiguous reservation is never silently executed.
    expect(reliability).toContain("Some(_) => ReplayDecision::RejectReplay,");
    expect(reliability).toContain("None if observed_sequence == last_sequence => ReplayDecision::Ambiguous,");
    expect(reliability).toContain("None => ReplayDecision::RejectReplay,");
  });

  it("persists the monotonic sequence BEFORE emitting the command (persist-before-emit)", () => {
    const reserveAt = remote.indexOf("vault.devices[index].last_sequence = sequence;");
    const emitAt = remote.indexOf('.emit("nexus-remote-command"');
    const rollbackAt = remote.indexOf("fn rollback_command_reservation(");
    expect(reserveAt).toBeGreaterThan(-1);
    expect(emitAt).toBeGreaterThan(-1);
    expect(reserveAt).toBeLessThan(emitAt);
    expect(rollbackAt).toBeGreaterThan(-1);
    // The receipt log records only non-secret fields.
    expect(reliability).toContain("never a signature, token or request body");
  });

  it("keeps the idempotency/receipt log bounded and never re-executes an acknowledged replay", () => {
    expect(reliability).toContain("pub struct CommandReceiptLog");
    expect(reliability).toContain("pub fn record(&mut self, device_id: &str, sequence: u64, command: &str) -> CommandReceipt {");
    expect(reliability).toContain("A repeated (device, sequence) never");
    expect(reliability).toContain("MAX_PENDING_ACKS");
    expect(reliability).toContain("AckCorrelator");
    // Commands are NEVER auto-replayed on reconnect (fail-closed reconnect).
    expect(reliability).toContain("Commands are NEVER auto-replayed on reconnect.");
  });
});

describe("genesis E: LAN surface stays exactly the 11-route allowlist with host/origin/CSP/limit guards", () => {
  it("keeps the route allowlist EXACTLY the existing 11 routes — no new endpoint", () => {
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
    for (const route of routes) {
      expect(route).not.toMatch(/recovery|revoke|admin|trust|credential|secret/i);
    }
  });

  it("keeps Host/Origin exact-match, the non-GET /api guard, the 4096-byte limit and the strict CSP", () => {
    for (const literal of [
      "fn is_allowed_request(",
      "host != Some(expected_host)",
      'path.starts_with("/api/") && method != "GET"',
      "const MAX_REQUEST_BYTES: usize = 4096;",
      "DefaultBodyLimit::max(MAX_REQUEST_BYTES)",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
    ]) {
      expect(remote).toContain(literal);
    }
  });

  it("binds only the private-network address on the fixed remote port", () => {
    expect(remote).toContain("SocketAddr::new(IpAddr::V4(ip), REMOTE_PORT)");
    expect(remote).toContain("fn local_remote_address()");
  });
});

describe("genesis E: credential vault keeps its size cap and fail-closed cross-process lock", () => {
  it("caps stored secrets below the Credential Manager limit", () => {
    expect(credentials).toContain("pub fn validate_credential_password_size(value: &str)");
    expect(credentials).toContain("CredentialStoreError::TooLarge");
    expect(credentials).toContain("2560");
  });

  it("serializes vault writes through the fail-closed state lock (LockFileEx, never silently skipped)", () => {
    expect(stateLock).toContain("fail-closed: if the lock cannot be created or acquired in time");
    expect(stateLock).toContain("StateLockError::Unavailable");
    expect(stateLock).toContain("StateLockError::Timeout");
    expect(credentials).toContain("fn native_store_guard()");
    expect(credentials).toContain("crate::remote_state_lock::StateLockGuard");
    // A lock failure is an error, never a silent pass-through.
    expect(credentials).toContain(".ok_or(CredentialStoreError::Unavailable)?");
  });

  it("never logs, persists or echoes secret material", () => {
    for (const forbidden of ["println!(\"{password}", "dbg!(&password", "log::info!(\"{password}"]) {
      expect(lanSources, `LAN sources must not contain ${forbidden}`).not.toContain(forbidden);
    }
    expect(reliability).toContain("never a signature, token or request body");
  });
});
