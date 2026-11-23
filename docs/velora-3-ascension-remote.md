# VELORA 3.0 — Operation Ascension: Phase 3 (Agent D) — iPhone Remote 4.0, fail-closed on real Wi-Fi

- Branch: `ascension-d-remote` (base `4a431768f85d4ba81161b331ebcce93b4684dd2e` = tip of `origin/feat/s2-9-hardware-recovery`, Draft PR #72)
- Scope: `public/remote/**`, `src/services/remote{Access,Command,Reliability,Permissions}.ts`, additive-only `src/contracts/**`, Rust `remote_access.rs` / `remote_reliability.rs` / `remote_state_lock.rs` / `credential_store.rs`, new `src/__tests__/ascensionD*.test.ts`, this doc.
- Status: engineering branch. **No merge to `main`, no push, no release, no installer run. Physical hardware (MSI + physical iPhone) remains NOT TESTED** — everything below is source + deterministic-test evidence only.

## 1. What Phase 3 wires (and what it deliberately does not)

The base already contained tested-but-unwired reliability primitives
(`src/services/remoteReliability.ts`, `src-tauri/src/remote_reliability.rs`) and a
server whose command transaction is already idempotency-safe
(`classify_replay` + bounded `CommandReceiptLog`, sequence reserved — persisted —
**before** `emit`, receipt recorded after success). Phase 3 wires the **client
side** fail-closed, with **zero protocol change**:

| Control | State after Phase 3 |
| --- | --- |
| Signed payload format | **Byte-identical**: `NEXUS-AUREA-REMOTE-V1\n{deviceId}\n{sequence}\n{command}` + HMAC-SHA256, monotonic `sequence` |
| LAN routes | **Unchanged** — exactly the existing 11 (guarded by test): `/`, static shell, `/api/status`, `/api/hello`, `/api/pair`, `/api/command` |
| HTTP semantics of `/api/command` | **Unchanged**: 2xx executed/deduped, 401 replay-rejected/revoked, 409 ambiguous, 429 rate-limited, 5xx unavailable |
| TLS | **Unchanged**: rustls from the vault CA, `trust_confirmed` gate, no `danger_accept_invalid_*` anywhere (guarded) |
| Host/Origin, CSP, 4096-byte body limit, `credentials:"omit"`, `cache:"no-store"`, `referrerPolicy:"no-referrer"` | **Unchanged** (guarded) |
| Secret storage | **Unchanged**: non-exportable WebCrypto HMAC key in IndexedDB; no `localStorage`/`sessionStorage` (guarded) |
| New Tauri commands | **None**. Pairing lifecycle uses only the existing commands (`get_remote_access_status`, `begin_remote_pairing`, `revoke_remote_device`, `revoke_all_remote_devices`, recovery, trust-profile commands) |
| New npm/cargo dependencies | **None** |

## 2. The fail-closed command path (PWA)

`public/remote/app.js` now runs every user command through an outbound pipeline:

1. **Queue + dedup by commandId.** Each tap reserves the next persisted sequence
   (exactly once, `record.sequence + 1` in one IndexedDB readwrite transaction),
   signs the payload **once**, and derives a local correlation id
   (`commandIdFor(deviceId, sequence)`, FNV-1a — correlation only, never sent,
   never a signature). An entry whose commandId is already queued/known is a
   duplicate and is not queued twice.
2. **Single in-flight.** At most one `/api/command` request is outstanding;
   further taps queue behind it (`pendingIntents`) and drain sequentially.
3. **Bounded automatic retries — only when provably never reached.** A retry is
   allowed only if the failure proves the request never reached the server:
   the browser reports offline, or a DNS/connect-refused network error occurred
   before send. The abort/timeout case is explicitly **excluded**. Retries are
   bounded (`OUTBOUND_MAX_AUTO_RETRIES = 3`) with exponential backoff
   (`outboundRetryDelayMs`, ≤ 1600 ms) and **always reuse the exact same
   `sequence` + `signature` — the payload is never re-signed and the sequence is
   never incremented on a retry**.
4. **Ambiguous timeout after send → "unknown", never auto-retried.** The server
   persists `last_sequence` before `emit`, so a blind retry with a fresh sequence
   would be a *new* command (double action) and a blind retry with the old
   sequence burns the replay slot. Instead the entry is moved to the `unknown`
   list, surfaced in a dedicated UI panel, and **requires explicit user
   re-confirmation**: re-tapping the same command (or the panel's confirm
   button) re-sends the *identical signed body*. The server then answers from its
   receipt log — 2xx (already executed, deduped), 409 (still ambiguous), or 401
   (rejected) — so **a second side effect is impossible** by construction.
5. **Replay-rejected (401) surfaces a clear state**: the existing unpair path —
   tombstoned record, pairing form shown, "wymagane ponowne parowanie". 409
   marks the command unknown with the existing "check the device state" message.
6. **Wi-Fi loss → queue + bounded reconnect.** The `offline` event invalidates
   in-flight responses (stale-read `requestId` guards kept) and sweeps the
   in-flight entry to `unknown`; new taps while offline are queued, not sent.
   On `online`/foreground the existing bounded backoff (`RECONNECT_MAX_ATTEMPTS
   = 8`, `reconnectDelayMs`) re-syncs `/api/status` (stale-read protection kept)
   and re-verifies pairing with a fresh signed `/api/hello`, then sends **only
   never-sent queued intents** — `unknown` entries are never auto-replayed
   (`shouldReplayOnReconnect` stays `false`).

The same policy exists as a tested, injectable reference implementation in
`src/services/remoteReliability.ts` (`RemoteOutboundPipeline` +
`classifyOutboundFailure` / `outcomeForStatus` / `shouldAutoRetry` /
`autoRetryDelayMs`), composed from the pre-existing `RemoteCommandQueue` (dedup
by commandId), `AckTracker` (ack correlation) and `reconnectDelayMs` (backoff).

## 3. Pairing lifecycle UX (existing Tauri commands only)

- **Device identity**: the PWA status list shows this device's `deviceId` once
  paired (`#device-id`); desktop revocation list already renders
  `pairedDevices` from `get_remote_access_status` (ControlCenter). Pure helpers
  added in `remoteAccess.ts`: `remotePairingPhase`, `listPairedRemoteDevices`,
  `findPairedRemoteDevice`, `isRemoteDevicePaired`, `qrOnboardingPhase`.
- **Revocation**: a revoked device learns it authoritatively via 401 on
  `/api/command` / `/api/hello` (clear unpair state); the desktop revokes through
  the existing `revoke_remote_device` / `revoke_all_remote_devices` commands.
  No LAN route exists for revocation/recovery (guarded by test).
- **QR onboarding states**: `#qr-onboarding-state` shows `idle` / `kod z QR
  aktywny` / `kod z QR wygasł` from the URL fragment; the fragment is still
  cleared immediately and carries only origin + one-time code + `exp` hint.

## 4. Security regression guards (ascensionD* tests)

`src/__tests__/ascensionDSecurity.test.ts` (15 tests) extends the
`remoteSecurityInvariants` pattern over **every owned remote file** (PWA, remote
TS services, contracts, all 4 Rust modules) and fails loudly on: any
`danger_accept_invalid_*` / `accept_invalid*` / `no-cors`; plain `http://` in
PWA/TS; `WebSocket` / `EventSource` / `XMLHttpRequest` / `sendBeacon`;
`localStorage` / `sessionStorage`; any but the 4 existing same-origin `/api`
endpoints; any change to the LAN route allowlist, CSP, body limit, Host/Origin
checks, rustls + `trust_confirmed`; any auto-retry that is not gated on
`neverReached` + the bounded counter; any re-signing or sequence increment on a
retry. `ascensionDPwa.test.ts` (7 vm tests) proves behaviourally that the
ambiguous-timeout path issues **no** second request and that re-confirmation
re-sends a byte-identical body.

## 5. Files changed

- `public/remote/app.js` — fail-closed outbound pipeline (above); `index.html`,
  `style.css` — additive UX elements; `sw.js` — untouched (cache name/shell
  pinned by existing tests).
- `src/services/remoteReliability.ts` — Phase-3 policy primitives + pipeline.
- `src/services/remoteAccess.ts`, `remoteCommand.ts` — additive helpers/guard.
- `src/contracts/events.ts` — additive types only (`RemoteCommandOutcome`,
  `RemoteOutboundStatusPayload`); event surface unchanged (8 names).
- `src-tauri/src/remote_reliability.rs`, `remote_access.rs` — **tests only**
  (7 new): Phase-3 fail-closed contract pins + LAN route allowlist /
  decision→status mapping / reserve-before-emit source guards.
  `remote_state_lock.rs`, `credential_store.rs` — unchanged (reviewed, no gap
  found for this phase).
- New tests: `ascensionDReliability.test.ts` (14), `ascensionDRemoteAccess.test.ts`
  (5), `ascensionDPwa.test.ts` (7), `ascensionDSecurity.test.ts` (15).

## 6. Verification (local, macOS)

- `pnpm test` — 112 files / **1046 + 41 = 1087 tests PASS** (all pre-existing
  suites incl. `remotePwa` / `remoteSecurityInvariants` stay green).
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` — **439 passed,
  0 failed** (432 baseline + 7 new).
- `pnpm build`, `pnpm test:soak`, `pnpm test:provenance`, `pnpm test:portable-manifest`,
  `pnpm test:claude-usage` — all PASS.
- Windows-target cargo check is CI-only (`aws-lc-sys` needs the Windows SDK) —
  **not run locally, not claimed**.

## 7. Known limitations

- A network error while *online* that is actually a post-send response loss is
  classified `never-reached` only if it looks like DNS/connect-refused; it is
  still safe to auto-retry because the retry reuses the identical signed bytes
  (server receipts make it idempotent), but the *label* may be optimistic. The
  hard rule — no blind retry of an ambiguous timeout, no new sequence on retry —
  holds regardless.
- `commandId` correlation is client-side only; the server does not echo it (no
  protocol change). Single in-flight makes the correlation unambiguous.
- The unknown-outcome panel re-confirms the oldest entry via its button; re-tap
  of the same command button is equivalent.
- Physical Wi-Fi-loss behaviour on the MSI + iPhone remains a Luna hardware gate
  (NOT TESTED here).
