# VELORA 2.0 — S2.9 changelog

Branch `feat/s2-9-hardware-recovery` (Draft PR against `feat/portable-validation-build`).
Base: PR #71 `d50ed79`. No change to `main`, PR #65 or PR #71.

## S2.9-A — streaming session continuity

- `fix(streaming)` `ba6ef7d`: `invalidate_controller_streaming` is now a full quiesce — media
  arming and simulator target cleared, input engine reset to neutral, controller epoch and
  generation advanced exactly once; generation is returned for receipts.
- `media_disarm_for_transition` fires once per real transition; deduplicated, replayed and stale
  commands do not quiesce.
- One sanitized `velora-streaming-quiesced` receipt (allowlisted enums/numbers,
  `physicalHardwareVerified: false`), plus a content-free `streamingQuiesceCount` in diagnostics.
- First Edge Cinema launch now performs the same identity-checked, bounded foreground request as
  adoption paths; on identity mismatch or denial no foreign window is activated and the launch is
  not failed (best effort, single attempt, no keystrokes).
- New deterministic `streamingSessionContinuity.test.ts` models first vs repeated
  Home -> Netflix -> Home -> YouTube with a seeded generator.

## S2.9-B — Windows state feedback

- `fix(cinema)` `489dd61`: `ControlCenter`, `App` and `ControlServicePanel` now use a bounded
  8 s status read and a typed `unknown` state. A failed read keeps the last known status and shows
  the real reason instead of claiming the backend is unavailable.
- `SessionControllerControls` releases its single-flight reservation when the bounded race settles,
  so retry after a timeout actually works; stale IPC cannot clobber newer state (epoch guard).
- Event-driven recovery from existing `control-service-status` events; no new polling.
- Tests added for unavailable provider, startup race with a late stale reply, and recovery.

## S2.9-C — iPhone Remote portable validation

- `feat(remote)` `3409d8c`: portable trust profiles are written only to
  `<VELORA-Portable-Data>\trust`; installed mode keeps Downloads. The `start()` bypass of the
  portable guard is closed with an authoritative `is_portable()` + `starts_with(root)` check.
- One-time 120 s local approval token for profile generation and cleanup; UI requires an explicit
  unchecked-by-default consent checkbox and shows the resolved path and CA fingerprint first.
- Portable-only, approval-gated cleanup: stop server, remove only the generated portable file,
  revoke all devices, report each step truthfully; iOS-side removal stays manual.
- New local IPC commands `begin_remote_trust_approval`, `inspect_remote_trust_profile`,
  `prepare_remote_trust_profile(approvalToken)`, `cleanup_remote_trust_artifacts(approvalToken)`.
- Docs: portable setup/cleanup in `docs/iphone-remote-v0.9.2.md` and
  `scripts/portable/README-PORTABLE.md`.
- Tests: portable path/approval invariants (Rust + TS), and behavioral pairing/revocation/Wi-Fi
  interruption/recovery cases in `remotePortablePairing.test.ts`.

## S2.9-D — integration and release protection

- Three isolated worktrees integrated sequentially; review-driven adjustment made first-launch
  focus non-fatal; full frontend, Rust, provenance, portable-manifest and Windows MSVC checks run.
- New portable validation candidate built by CI with a SHA-256 manifest and exact source commit.
- Luna handoff procedure: `docs/velora-2-s2-9-luna-test-procedure.md`.
- iPhone pairing is recorded as a hardware gate, **not** a PASS.
