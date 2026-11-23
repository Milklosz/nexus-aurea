/**
 * Phase 3 (Ascension D) — SECURITY REGRESSION GUARD (extends the
 * remoteSecurityInvariants pattern as ascensionD* tests).
 *
 * Reads the owned remote sources AS TEXT and fails loudly if any security
 * control is weakened or any alternate transport/secret storage appears:
 *   - no danger_accept_invalid_certs / accept_invalid* / no-cors anywhere;
 *   - no plain http:// in the PWA or the remote TS services;
 *   - no WebSocket / EventSource / XMLHttpRequest / sendBeacon in the PWA;
 *   - no localStorage / sessionStorage (secrets stay in IndexedDB WebCrypto);
 *   - the HMAC payload format NEXUS-AUREA-REMOTE-V1 + HMAC-SHA256 + monotonic
 *     sequence + replay guard stay byte-identical in app.js and Rust;
 *   - the ambiguous-timeout path in app.js does NOT auto-retry (the retry
 *     branch is gated on a provably never-reached failure and a bounded
 *     attempt counter; the timeout/abort path marks the command "unknown");
 *   - the LAN route allowlist in remote_access.rs is EXACTLY the existing 11
 *     routes (no new endpoint, no recovery/revocation route on the LAN);
 *   - CSP, body limit, TLS rustls + trust_confirmed gate, Host/Origin checks
 *     are unchanged;
 *   - the service worker cache name / shell are unchanged.
 *
 * The forbidden tokens below appear ONLY inside negative assertions.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { VELORA_EVENTS } from "../contracts";

const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");

const pwaFiles = [
  "public/remote/app.js",
  "public/remote/sw.js",
  "public/remote/index.html",
  "public/remote/style.css",
  "public/remote/manifest.webmanifest",
];
const tsFiles = [
  "src/services/remoteAccess.ts",
  "src/services/remoteCommand.ts",
  "src/services/remoteReliability.ts",
  "src/services/remotePermissions.ts",
  "src/contracts/events.ts",
];
const rustFiles = [
  "src-tauri/src/remote_access.rs",
  "src-tauri/src/remote_reliability.rs",
  "src-tauri/src/remote_state_lock.rs",
  "src-tauri/src/credential_store.rs",
];

const app = read("public/remote/app.js");
const sw = read("public/remote/sw.js");
const html = read("public/remote/index.html");
const rust = read("src-tauri/src/remote_access.rs");
const reliability = read("src-tauri/src/remote_reliability.rs");
const allPwa = pwaFiles.map(read).join("\n");
const allTs = tsFiles.map(read).join("\n");
const allRust = rustFiles.map(read).join("\n");

describe("ascension D: no weakened TLS / alternate transports / web-storage secrets in remote code", () => {
  it("forbids certificate-validation bypasses and no-cors in every owned remote file", () => {
    for (const file of [...pwaFiles, ...tsFiles, ...rustFiles]) {
      const source = read(file);
      for (const forbidden of [
        "danger_accept_invalid_certs",
        "danger_accept_invalid_hostnames",
        "accept_invalid",
        "no-cors",
        "skip verification",
      ]) {
        expect(source, `${file} must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("forbids plain http:// in the PWA and the remote TS services (https only)", () => {
    for (const file of [...pwaFiles, ...tsFiles]) {
      expect(read(file), `${file} must not contain plain http://`).not.toContain("http://");
    }
    // The PWA hard-requires a secure context + https protocol.
    expect(app).toContain('window.isSecureContext && window.location.protocol === "https:"');
  });

  it("forbids alternate transports and web storage in the PWA (fetch + IndexedDB only)", () => {
    for (const forbidden of [
      "localStorage",
      "sessionStorage",
      "WebSocket",
      "EventSource",
      "XMLHttpRequest",
      "sendBeacon",
      "navigator.sendBeacon",
    ]) {
      expect(allPwa, `PWA must not contain ${forbidden}`).not.toContain(forbidden);
      expect(allTs, `remote services must not contain ${forbidden}`).not.toContain(forbidden);
    }
    // Secrets stay in the non-exportable WebCrypto key in IndexedDB.
    expect(app).toContain("indexedDB.open");
    expect(app).toContain('name: "HMAC"');
    expect(app).toContain("crypto.subtle.sign");
    expect(app).toContain('["sign"]');
  });

  it("keeps every PWA request on credentials:omit / no-store / no-referrer", () => {
    for (const literal of ['credentials: "omit"', 'cache: "no-store"', 'referrerPolicy: "no-referrer"']) {
      expect(app).toContain(literal);
    }
    // Exactly the four API endpoints exist, all same-origin relative paths.
    const apiTargets = [...app.matchAll(/fetchWithTimeout\("(\.\/api\/[a-z]+)"/g)].map((match) => match[1]);
    expect([...new Set(apiTargets)].sort()).toEqual(["./api/command", "./api/hello", "./api/pair", "./api/status"]);
    // Only /api/status is a GET; the other three are POSTs (checked below).
    expect(app).toContain('fetchWithTimeout("./api/status", {\n        method: "GET"');
  });

  it("keeps the service worker offline shell and cache name unchanged", () => {
    expect(sw).toContain('CACHE_NAME = "nexus-aurea-remote-v0.10.0-velora-offline-command-9"');
    expect(sw).toContain('key.startsWith("nexus-aurea-remote-")');
    // The SW never serves /api/* from cache and only handles GET.
    expect(sw).toContain('event.request.method !== "GET"');
    expect(sw).toContain('/\\/api(?:\\/|$)/.test(requestUrl.pathname)');
  });

  it("keeps the HTML shell free of inline scripts and external origins", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toContain("http://");
    expect(html).toContain('<script src="./app.js" defer></script>');
  });
});

describe("ascension D: signed payload format and replay guard stay byte-identical", () => {
  it("keeps the NEXUS-AUREA-REMOTE-V1 HMAC-SHA256 payload format in app.js and Rust", () => {
    expect(app).toContain('["NEXUS-AUREA-REMOTE-V1", record.deviceId, String(sequence), command].join("\\n")');
    expect(app).toContain('["NEXUS-AUREA-REMOTE-V1", record.deviceId, "hello", nonce].join("\\n")');
    expect(rust).toContain('"NEXUS-AUREA-REMOTE-V1\\n{device_id}\\n{sequence}\\n{}"');
    expect(rust).toContain("fn verify_command_signature(");
    expect(rust).toContain("Hmac::<Sha256>");
  });

  it("keeps the monotonic sequence reservation and the replay classification in Rust", () => {
    for (const literal of [
      "fn sequence_is_fresh(",
      "last_sequence",
      "classify_replay",
      "ReplayDecision::AcknowledgeReplay",
      "ReplayDecision::Ambiguous",
      "ReplayDecision::RejectReplay",
      "command_receipts",
      ".record(",
      "fn rollback_command_reservation(",
      "fn record_command_receipt(",
    ]) {
      expect(rust).toContain(literal);
    }
    // The receipt log never contains secrets and the classifier never promotes
    // a different command into an idempotent success.
    expect(reliability).toContain("RejectReplay");
    expect(reliability).toContain("never a signature, token or request body");
    expect(reliability).toContain("different command into an idempotent success");
  });

  it("keeps the LAN route allowlist EXACTLY the existing 11 routes — no new endpoint", () => {
    const routes = [...rust.matchAll(/\.route\("([^"]+)"/g)].map((match) => match[1]);
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
    // No recovery / revocation / admin route is reachable on the LAN server.
    for (const route of routes) {
      expect(route).not.toMatch(/recovery|revoke|admin|trust|credential/i);
    }
    // Recovery stays local-Tauri-only and is never referenced from the PWA.
    for (const name of ["inspect_remote_recovery", "run_remote_recovery", "recovery", "reset-trust"]) {
      expect(app).not.toContain(name);
      expect(sw).not.toContain(name);
      expect(html).not.toContain(name);
    }
  });

  it("keeps Host/Origin exact-match, CSP, body limit and the TLS trust gate in remote_access.rs", () => {
    for (const literal of [
      "fn is_allowed_request(",
      "host != Some(expected_host)",
      "path.starts_with(\"/api/\") && method != \"GET\"",
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
      "DefaultBodyLimit::max(MAX_REQUEST_BYTES)",
      "const MAX_REQUEST_BYTES: usize = 4096;",
      "RustlsConfig::from_pem",
      "trust_confirmed",
      "prepare_trust_profile",
    ]) {
      expect(rust).toContain(literal);
    }
  });

  it("keeps the contract event surface unchanged (additive types only)", () => {
    expect(Object.values(VELORA_EVENTS)).toHaveLength(8);
    expect(VELORA_EVENTS.remoteCommandEnvelope).toBe("velora://remote-command-envelope");
    expect(VELORA_EVENTS.remoteCommandAck).toBe("velora://remote-command-ack");
    expect(VELORA_EVENTS.remoteStateChanged).toBe("velora://remote-state-changed");
  });
});

describe("ascension D: fail-closed retry policy is wired, not just documented", () => {
  it("gates every automatic retry on a provably never-reached failure and a bounded counter", () => {
    // The single send site — retries reuse it, never a second fetch literal.
    expect(app.match(/fetchWithTimeout\("\.\/api\/command"/g)).toHaveLength(1);
    expect(app).toContain("const OUTBOUND_MAX_AUTO_RETRIES = 3;");
    expect(app).toContain("if (neverReached && entry.attempts < OUTBOUND_MAX_AUTO_RETRIES)");
    // The proof requires offline or a DNS/connect-refused network error, and an
    // abort/timeout is explicitly excluded from "never reached".
    expect(app).toContain("!/abort|timeout|timed.?out/i.test(label)");
    expect(app).toContain("/network|failed to fetch|fetch failed|econnreset|econnrefused|enotfound|dns/i.test(label)");
    // No retry counter named retryCount, no direct re-invocation of sendCommand.
    expect(app).not.toContain("retryCount");
    expect(app).not.toContain("setTimeout(() => void sendCommand");
    expect(app).not.toMatch(/queueCommand|pendingCommands|resendCommand/i);
  });

  it("marks an ambiguous timeout after send as unknown and never blindly retries it", () => {
    // The ambiguous branch exists and is distinct from the retry branch.
    expect(app).toContain("markEntryUnknown(entry);");
    expect(app).toContain("Polecenie nie zostało automatycznie ponowione");
    // The catch that handles a post-send failure comes AFTER the bounded
    // never-reached retry branch (source order proves the gating).
    const retryAt = app.indexOf("if (neverReached && entry.attempts < OUTBOUND_MAX_AUTO_RETRIES)");
    const unknownAt = app.indexOf("markEntryUnknown(entry);\n          if (requestId === commandRequestId)");
    expect(retryAt).toBeGreaterThan(-1);
    expect(unknownAt).toBeGreaterThan(retryAt);
    // Re-confirmation re-sends the stored entry — the sequence is never
    // incremented and the signature is never recomputed on a retry.
    expect(app).toContain("signature: entry.signature,");
    expect(app).toContain("sequence: entry.sequence,");
    expect(app).toContain("await reconfirmEntry(unknown);");
    expect(app).toContain("record.sequence + 1"); // reservation happens exactly once per command
    // 409 (ambiguous on the server side) also lands in the unknown list.
    expect(app).toContain("if (response.status === 409)");
    // 401 replay-rejected unpairs with a clear state.
    expect(app).toContain("if (response.status === 401)");
    expect(app).toContain("state.authorizationRejected = true");
    expect(app).toContain("await rejectStoredRecord(record)");
  });

  it("keeps the bounded request timeout and the 8-attempt reconnect backoff", () => {
    expect(app).toContain("const requestTimeoutMs = 8000;");
    expect(app).toContain("const RECONNECT_MAX_ATTEMPTS = 8;");
    expect(app).toContain("const OUTBOUND_MAX_AUTO_RETRIES = 3;");
    expect(app).toContain("function reconnectDelayMs(attempt)");
    expect(app).toContain("function outboundRetryDelayMs(attempt)");
    expect(app).toContain("AbortController");
    expect(app).toContain("fetchWithTimeout");
    // Wi-Fi loss sweeps in-flight entries to unknown; reconnect drains only
    // never-sent intents.
    expect(app).toContain('if (entry.state === "sending") markEntryUnknown(entry);');
    expect(app).toContain("void drainPendingIntents();");
  });

  it("keeps the stale-read guards on status and command responses", () => {
    expect(app).toContain("if (requestId !== statusRequestId) return;");
    expect(app).toContain("if (requestId !== commandRequestId) return;");
    expect(app).toContain("let statusRequestId = 0;");
    expect(app).toContain("let commandRequestId = 0;");
  });
});
