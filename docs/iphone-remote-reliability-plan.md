# iPhone Remote 2.0 — reliability integration PLAN (partially applied)

> **Status integracji (VELORA 1.0 final hardening):** serwerowa idempotencja
> **WDROŻONA** jako bounded in-memory receipt log + rezerwacja sekwencji przed
> skutkiem, serializowana bramką komend. Dokładny duplikat otrzymuje 204 bez
> drugiego skutku; duplikat równoległy czeka, a nie jest klasyfikowany jako
> atak; przerwane/wykonane-nieudanie polecenie zwraca 409 (bez rozparowania)
> albo wraca do puli retry. Retry po stronie PWA pozostaje **WYŁĄCZONY**.
> Aktualny stan: [docs/velora-v1-integration.md](./velora-v1-integration.md).
>
> **Status pierwotny: PLAN + tested prototypes only.** This PR delivers pure, unit-tested
> reliability primitives, a security regression guard, and the two docs (this
> plan + the certificate audit). It does **NOT** wire any of it into the PWA or
> the axum HTTPS server, and it does **NOT** change any existing protocol or
> security code. Stable contract references: `docs/ipc-contract.md` (commands +
events table) and `src/contracts/events.ts` (`VELORA_EVENTS`,
`RemoteCommandEnvelope`, `RemoteCommandAckPayload`, `RemoteState`).

## PREREQUISITE (hard blocker — BEFORE any client retry)
The final hardening changed the server order deliberately: the sequence is
still reserved **before** the side effect (so two parallel requests cannot
execute the same signed command), but the whole reservation + execution +
receipt transaction is serialized by `command_gate`. An exact duplicate waits
for the first result and then receives 204 from the receipt, without a second
side effect. A failed execution rolls the reservation back (retry allowed); an
interrupted attempt without a receipt returns 409 Ambiguous, which keeps the
iPhone paired instead of triggering the PWA's 401 unpair path. HTTP response
loss remains safe for an exact retry.

**Blind auto-replay on reconnect is still UNSAFE** because a client retry that
increments the sequence is a genuinely different command. `shouldReplayOnReconnect()`
returns `false` for every state and `RemoteCommandQueue` has no reconnect hook —
by design. Client retry remains out of scope until an ack-aware transport is
implemented.

## Dependency graph

```
server-side IdempotencyStore (1)
   ├──> typed v2 event (2)        [KEEP legacy bare "nexus-remote-command"]
   ├──> JSON ack on /api/command (3)   [client tolerates both 204 + JSON]
   │        └──> PWA queue + AbortController timeout + same-(seq,sig) retry (4)
   └──> GET /api/status serverEpoch + revokedDeviceIds (5)
              └──> heartbeat + backoff (6)
                     └──> pairing re-verification / signed hello (7)
```

Step (4) is gated on (1) + (3); steps (5)–(7) assume an ack-aware transport.

## Ordered steps

### (1) In-memory bounded `IdempotencyStore` keyed `(deviceId, sequence)` + `commandId`
- **Prototype already delivered:** `src-tauri/src/remote_reliability.rs`
  (`IdempotencyStore`, `IdempotencyEntry`, `command_id` FNV-1a) and
  `src/services/remoteReliability.ts` (`commandIdFor`, `RemoteCommandQueue`).
- **Files that would change:** `src-tauri/src/remote_access.rs` — in
  `send_command`, consult the store **before** `authenticate_command`; on a
  cache hit return the SAME ack **without re-emitting**; on a miss, record the
  result after a successful emit.
- **Tests that must be updated:** the `#[cfg(test)]` unit tests in
  `remote_reliability.rs` already exist; add `remote_access.rs` integration
  tests for the "burned sequence then duplicate" case.
- **Security invariant that must remain:** `verify_command_signature`,
  `sequence_is_fresh`, the command rate limit and the `save_vault` order stay;
  the store is a **lookup**, never a bypass of authentication.

### (2) Typed `RemoteCommandEvent` emitted as a SECOND event `nexus-remote-command-v2`
- **Files that would change:** `src-tauri/src/remote_access.rs` (emit a second,
  typed payload carrying `commandId`), `src/services/remoteAccess.ts` (optional
  listener for the v2 name). `src/contracts/events.ts` stays the stable
  contract.
- **KEEP** `nexus-remote-command` as a bare string for backward compatibility —
  **do not remove it**.
- **Tests that must be updated:** `remoteCommand.test.ts` / a new
  `remoteAccess` event test add a v2 listener case; `controlCenter.test.tsx`
  unchanged.
- **Security invariant that must remain:** exact Host+Origin and the 12-command
  `RemoteCommand` allowlist unchanged; the v2 event is **additive only**.

### (3) HTTP `/api/command` returns a JSON ack `{commandId, executed, result}` instead of bare 204
- **Files that would change:** `src-tauri/src/remote_access.rs` `send_command`
  (`axum::Json` instead of `StatusCode::NO_CONTENT`), `public/remote/app.js`
  (tolerate **both** 204 and a JSON ack — feature-detect),
  `src/services/remoteReliability.ts` ack parsing (prototype).
- **Tests that must be updated:** `remotePwa.test.ts` — the `node:vm` sandbox
  must accept a JSON-ack response while the existing 204 path stays green; add
  the relevant sandbox globals/literals.
- **Security invariant that must remain:** `credentials: "omit"`,
  `cache: "no-store"`, CSP, `DefaultBodyLimit::max` unchanged; no new response
  headers that relax referrer or CORS policy.

### (4) PWA queue + feature-detected `AbortController` timeout + same-`(sequence,signature)` retry ONLY
- **Files that would change:** `public/remote/app.js` (queue, AbortController
  feature detection, retry the **EXACT same** sequence + signature — **NEVER
  increment sequence on retry**), `src/services/remoteReliability.ts`
  (prototype: `RemoteCommandQueue`, `reconnectDelayMs`, `AbortSignalLike`,
  `AckTracker`).
- **Why never increment:** incrementing creates a new command (double action);
  the retry must reuse the same signed bytes so the server idempotency store
  (1) can dedupe it.
- **Tests that must be updated:** `remotePwa.test.ts` — `CACHE_NAME` bump +
  literals for the new code + `node:vm` sandbox globals (AbortController,
  TextEncoder, queueMicrotask); assert offline **suspends** commands rather than
  auto-replaying.
- **Security invariant that must remain:** the HMAC signature is computed once
  and reused; the `NEXUS-AUREA-REMOTE-V1` payload format is unchanged;
  `isSecureContext`, `indexedDB`, `crypto.subtle.sign` unchanged.

### (5) `GET /api/status` gains `serverEpoch` + `revokedDeviceIds`
- **Files that would change:** `src-tauri/src/remote_access.rs`
  (`remote_status` / `StatusResponse`), `public/remote/app.js` `refreshStatus`.
- **Tests that must be updated:** `remotePwa.test.ts` status JSON shape;
  `remoteAccess.test.ts`.
- **Security invariant that must remain:** status stays an unauthenticated
  read-only view; **no secrets** (device tokens, CA key) ever in the payload.

### (6) Heartbeat / backoff
- **Files that would change:** `public/remote/app.js` (heartbeat +
  `reconnectDelayMs`), `src/services/remoteReliability.ts` (prototype
  `reconnectDelayMs` / `reduceRemoteState`).
- **Tests that must be updated:** `remoteReliability.test.ts` already covers
  deterministic backoff; `remotePwa.test.ts` sandbox for the heartbeat timer.
- **Security invariant that must remain:** Wi-Fi loss → `offline` suspends
  commands; reconnect **NEVER** auto-replays (`shouldReplayOnReconnect === false`).

### (7) Pairing re-verification (signed hello)
- **Files that would change:** `src-tauri/src/remote_access.rs` (verify a
  signed hello on (re)connect before trusting `paired`),
  `public/remote/app.js`, `src/services/remoteReliability.ts`
  `safePairingReset` (prototype), Control Center UX.
- **Tests that must be updated:** `remotePwa.test.ts`; new Rust tests.
- **Security invariant that must remain:** pairing-code TTL / attempt limits,
  HMAC token, `MAX_PAIRED_DEVICES` unchanged; `trust_confirmed` still required
  to start TLS.

## Files that would change (summary) / OFF-LIMITS for this PR
- Would change (later): `src-tauri/src/remote_access.rs`,
  `public/remote/app.js`, `public/remote/sw.js` (CACHE_NAME),
  `src/services/remoteAccess.ts`, `src/__tests__/remotePwa.test.ts`,
  `src/__tests__/remoteCommand.test.ts`,
  `src/__tests__/controlCenter.test.tsx`, `src/contracts/*`.
- **OFF-LIMITS / unchanged in this PR:** all of the above are existing
  protocol/security code and tests — this module touches **none** of them.
  Also unchanged: `lib.rs` `generate_handler!`, capabilities, Cargo.toml,
  pnpm-lock.yaml (no new dependencies).

## What IS delivered in this PR
- `src-tauri/src/remote_reliability.rs` — pure, std-only, **NOT**
  `cfg(windows)`-gated prototypes + `#[cfg(test)]` unit tests (**NOT wired**).
  The lead must add **only** `mod remote_reliability;` (or
  `#[allow(dead_code)] mod remote_reliability;`) to `src-tauri/src/lib.rs` so
  its tests compile/run — **NO** `generate_handler!` entry, **NO** Tauri command.
- `src/services/remoteReliability.ts` — PURE, injectable, node-safe primitives
  + a `RemoteTransportAdapter` prototype (**NOT wired**).
- `src/__tests__/remoteReliability.test.ts` — unit tests for every primitive.
- `src/__tests__/remoteSecurityInvariants.test.ts` — regression guard that
  **fails loudly** if HMAC / replay / certificate-validation literals are
  removed.
- `docs/iphone-remote-cert-audit.md` — independent certificate-risk audit +
  PLAN.
- `docs/iphone-remote-reliability-plan.md` — this plan.

## Explicit statements
- **NONE** of steps (1)–(7) are applied in this PR. **No provisional
  workaround.** **No new Tauri commands.** The only `lib.rs` change required for
  this module is the single `mod` line (no handler registration).
- HMAC-SHA256, monotonic sequence / replay protection,
  `RustlsConfig::from_pem` / `trust_confirmed` / `prepare_trust_profile`
  certificate validation, exact Host+Origin, CSP, body limit and
  `credentials: "omit"` are **UNCHANGED**.
- Stable contract references: `docs/ipc-contract.md` and
  `src/contracts/events.ts`.
- macOS environment only: **NO MSI / physical-iPhone / hardware validation**
  and **no final release announcement**.
