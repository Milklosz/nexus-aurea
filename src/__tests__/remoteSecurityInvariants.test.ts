/**
 * SECURITY REGRESSION GUARD (module C).
 *
 * This test does NOT change behaviour. It reads the EXISTING protocol/security
 * source files AS TEXT and asserts that the HMAC / replay / certificate-
 * validation controls STILL HOLD. It FAILS LOUDLY if anyone removes or weakens
 * them. The forbidden tokens below appear ONLY as string literals inside
 * negative assertions (asserting the real sources do NOT contain them) — this
 * file never USES any of those APIs and adds no transport/storage of its own.
 *
 * NOTE: this repo's Vitest 4 test files (vite.config.ts has no vitest block)
 * expose an undefined module-URL base, so deriving a file URL from the module
 * location produces a broken path. Resolve source files from the repository
 * root via `process.cwd()` instead.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const rust = readFileSync(resolve(process.cwd(), "src-tauri/src/remote_access.rs"), "utf8");
const app = readFileSync(resolve(process.cwd(), "public/remote/app.js"), "utf8");
const sw = readFileSync(resolve(process.cwd(), "public/remote/sw.js"), "utf8");

describe("iPhone Remote security regression guard", () => {
  it("keeps HMAC, replay protection, certificate validation and request guards in remote_access.rs", () => {
    const required = [
      "verify_command_signature",
      "remote_command_payload",
      "sequence_is_fresh",
      "last_sequence",
      "RustlsConfig::from_pem",
      "trust_confirmed",
      "prepare_trust_profile",
      "is_allowed_request",
      "no-store",
      "no-referrer",
      "DefaultBodyLimit::max",
      "MAX_REQUEST_BYTES",
    ];
    for (const literal of required) expect(rust).toContain(literal);
  });

  it("keeps the body limit wired to the 4096-byte constant", () => {
    // The source uses DefaultBodyLimit::max(MAX_REQUEST_BYTES) where
    // MAX_REQUEST_BYTES = 4096 — assert the REAL literals, not a weaker guess.
    expect(rust).toContain("DefaultBodyLimit::max(MAX_REQUEST_BYTES)");
    expect(rust).toContain("const MAX_REQUEST_BYTES: usize = 4096;");
  });

  it("acknowledges only an exact already-executed command without a second side effect", () => {
    const reliability = readFileSync(
      resolve(process.cwd(), "src-tauri/src/remote_reliability.rs"),
      "utf8",
    );
    expect(rust).toContain("classify_replay");
    expect(rust).toContain("ReplayDecision::AcknowledgeReplay");
    expect(rust).toContain("command_receipts");
    expect(rust).toContain(".record(");
    expect(reliability).toContain("RejectReplay");
    expect(reliability).toContain("different command into an idempotent success");
    // The client still must not auto-retry side effects.
    expect(app).toContain("Polecenie nie zostało automatycznie ponowione");
  });

  it("never relaxes TLS / certificate validation in remote_access.rs", () => {
    const forbidden = [
      "danger_accept_invalid_certs",
      "no-cors",
      "skip verification",
      "danger_accept_invalid_hostnames",
    ];
    for (const literal of forbidden) expect(rust).not.toContain(literal);
  });

  it("keeps the PWA's signing, secure-storage and fetch discipline in app.js", () => {
    const required = [
      "crypto.subtle.sign",
      'name: "HMAC"',
      'credentials: "omit"',
      'cache: "no-store"',
      "isSecureContext",
      "indexedDB.open",
      "record.sequence + 1",
    ];
    for (const literal of required) expect(app).toContain(literal);
  });

  it("never introduces alternate transports or web storage in app.js", () => {
    const forbidden = [
      "localStorage",
      "sessionStorage",
      "WebSocket",
      "EventSource",
      "XMLHttpRequest",
      "sendBeacon",
      "danger_accept_invalid_certs",
    ];
    for (const literal of forbidden) expect(app).not.toContain(literal);
  });

  it("keeps a bounded request timeout and no automatic side-effect retry", () => {
    expect(app).toContain("requestTimeoutMs = 8000");
    expect(app).toContain("AbortController");
    expect(app).toContain("fetchWithTimeout");
    expect(app).not.toContain("retryCount");
    expect(app).not.toContain("setTimeout(() => void sendCommand");
  });

  it("keeps the offline Service Worker cache name at the confirmed-command revision", () => {
    // P1 intentionally bumped the cache to command-5 so devices drop the shell
    // that could show an unconfirmed pairing record as usable.
    expect(sw).toContain('CACHE_NAME = "nexus-aurea-remote-v0.9.2-velora-offline-command-5"');
  });

  it("keeps the RemoteCommand enum strings present", () => {
    for (const literal of ['"volume-up"', '"home"', '"profile-cinema"']) {
      expect(rust).toContain(literal);
    }
  });
});
