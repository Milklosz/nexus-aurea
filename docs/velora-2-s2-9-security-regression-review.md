# VELORA 2.0 — S2.9 security and regression review

## Security review

| Area | Change | Verdict |
|---|---|---|
| DRM / protected media | No provider playback state is read, persisted or restored; no "restore pause" key is injected. Media control remains an explicit, guarded user/control action. | Safe. DRM untouched. |
| Streaming receipts | `velora-streaming-quiesced` carries only allowlisted enum labels, numbers and a constant `false`. No URL, page text, window title, token or free-form error string. `diagnostics` adds a content-free counter. | Safe. |
| Streaming input | Existing generation, exact `launch_id`, foreground-identity and arming guards remain. Quiesce advances generation/epoch and resets the input engine; a stale packet is rejected at queue, dispatch, target and send. | Hardened. |
| First-launch focus | Identity gate compares PID **and** process creation time; no foreign window activation, no loop, one bounded request, no keystroke. A denial is non-fatal to preserve launch success. | Safe. |
| Windows status | Typed error uses existing `VeloraError`; rejection text is truncated to 160 chars and stored as `cause` (not rendered from stack traces). No new polling, no indefinite retry. | Safe. |
| Portable trust path | Single resolver; `download_dir()` exists only in the installed branch. Write path rejects any portable directory outside the portable root with `starts_with`. The `start()` bypass is closed. | Hardened. |
| Explicit approval | One-time 120 s local token, single use (any attempt consumes it), Tauri IPC only — never a LAN route. UI consent checkbox is unchecked by default. `trust_confirmed` at server start is unchanged. | Safe. |
| TLS/auth/replay | rustls validation, private-IP-only leaf SAN, HMAC-SHA256 over `NEXUS-AUREA-REMOTE-V1`, monotonic sequence, `classify_replay`, persisted `last_sequence`, exact Host/Origin, rate limits, non-exportable WebCrypto key, local-only recovery, route allowlist — all unchanged. | Preserved. |
| Cleanup | Portable-only, approval-gated, no LAN route. Stops server, removes only the generated portable file, revokes devices; failure of file removal never blocks revocation. Reports only steps that succeeded. iOS-side profile/full-trust removal remains manual and documented. | Safe. |
| System trust stores | No code installs a certificate or modifies Windows/iOS trust stores. The `.mobileconfig` is a passive file the operator transfers and installs manually. | Safe. |
| Installed VELORA 0.9.2 | Launcher env redirection, `AppDirectoriesOverride::Root`, disjoint credential service/mutex/window title, refused autostart and out-of-root writes, CI smoke `installedProfileCreated: false`. | Preserved. |

Known residual risks (accepted, documented, not hidden):

- The approval token is a freshness guard, not a cryptographic authorization factor; the human
  consent is the UI checkbox. This is stated honestly in code and docs.
- The read-only profile preview derives the CA fingerprint via `ensure_trust_material`, which may
  create CA material in the *portable credential store* if absent. It does not write a file or
  touch a system trust store.
- `streamingQuiesceCount` counts all full quiesces (also device removal/reconnect), not only session
  transitions; it is a content-free diagnostic, not an acceptance assertion.
- Resetting the input engine means the first deliberate Play/Pause press immediately after a
  transition may need a fresh neutral pad report. This is intentional safety and is covered by
  deterministic tests.
- Windows may deny the first-launch foreground request; the request is best-effort and the existing
  window watcher can still restore focus. No hardware claim is made.

## Regression review

- Regression-critical behaviors from section 1 of the mission (portable launch, startup/shutdown/
  restart/windowed, 4K fullscreen, public YouTube, DS4 pointer and Cross, PS+Options Home, pointer
  fallback on Netflix, portable isolation) were not modified directly. The only behavioral
  additions touching them are the session-boundary quiesce, best-effort focus and bounded status
  reads; each has deterministic coverage.
- UI wording changed where a failed read was previously mislabelled; stable substrings were kept
  and existing tests were updated deliberately, not deleted.
- No test was weakened or skipped to obtain a pass. No existing PR was force-pushed or modified.
