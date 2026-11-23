# VELORA 3.0 Ascension — Phase 2: streaming session intelligence (Agent B)

- Branch: `ascension-b-sessions` (base `4a43176` = `origin/feat/s2-9-hardware-recovery`, Draft PR #72)
- Scope: one coherent session manager for the Edge Cinema services (Netflix, YouTube, Disney+, Prime Video, Max), Steam Big Picture and Playnite — ownership, lifecycle, duplicate-launch prevention, focus restoration, crash/exit reporting and diagnostics.
- **Evidence disclaimer.** Everything below is derived from source and deterministic tests on macOS. No physical device was operated; all physical hardware checks remain **NOT TESTED** per `docs/velora-2-s2-9-luna-test-procedure.md`. The Windows-target cargo check is CI-only (`aws-lc-sys` needs the Windows SDK) and is not claimed locally.

## 1. What was built

### 1.1 One deterministic lifecycle state machine per session

`idle → launching → active → closing → exited/error` (terminal: `exited`/`error`; only `reset` — crash/restart recovery — leaves them).

- Rust single source: `src-tauri/src/launch_registry.rs` — `SessionLifecycleState`, `LifecycleEvent`, pure `lifecycle_transition` table (aligned 1:1 with the watcher `LaunchPhase` mapping `from_phase`), and a per-launch `LifecycleSidecar` inside `TrackedLaunch` that records bounded (32) `SessionTransitionReceipt { seq, sessionId, from, to, cause, atMs }` on every real phase change (`set_phase`) and on confirmed close requests (`record_lifecycle_event` from `edge_cinema.rs`). The machine is a pure overlay: `session.phase` stays the authoritative watcher state.
- TS mirror: `src/services/veloraSessionManager.ts` — `lifecycleTransition` / `SessionLifecycleMachine`, an exact port of the Rust table (cross-checked by tests on both sides).
- Projections: `velora_session_manager.rs` (`ManagedSession` now carries `launchId`, `managedByVelora`, `lifecycle`, `generation`, `lastTransition`, bounded `transitionReceipts`); `edge_cinema.rs` `phase_state` delegates to the shared `SessionLifecycleState::from_phase`, and `EdgeCinemaSession` carries `launchId`/`generation`/`lastTransition`.

Session identity on the wire: `sessionId` (== the owning `launchId`), `managedByVelora: true` for every registry-tracked session (foreign windows never enter the registry), plus the lifecycle state and generation.

### 1.2 Duplicate-launch prevention (idempotent, keyed by service + generation)

- Native: `LaunchRegistry` keeps `app_generations` per app group; `duplicate_launch_for_app` / pure `duplicate_launch_decision` return `Duplicate { sessionId, generation }` whenever a launch for the same service is in flight or active — callers adopt the existing launch instead of spawning (`active_launch_for_app` adoption path in `edge_cinema.rs`, unchanged).
- Client: `SessionLaunchCoordinator` (`veloraSessionManager.ts`) keys launches as `<service>#<generation>`; while a launch is in flight or closing, a repeated launch event is a `duplicate` and `openStreamingService` throws a truthful error **without a second IPC call**; while active, the decision is `adopt` (same key, same generation — the native adoption path re-selects the existing window, never spawns a duplicate); a stale generation (≤ last issued) is rejected, never replayed. The native layer remains the authoritative guard.

### 1.3 Focus restoration

- On VELORA window focus-regain, `SessionsPanel` restores the session selection via `resolveSessionSelectionOnFocusRegain` (`windowFocusRestore.ts`): keep under a modal overlay; keep the selected session while it is active; move to the most recently active session when the selected one exited; clear when none is active. Selection only — see limitations.
- Native focus restore on session end is unchanged (`window_broker::evaluate_session_end_restore` / `restore_velora_after_session_end`); `restore_outcome_label` now gives truthful labels for every outcome, explicitly including the Windows foreground lock.

### 1.4 Crash/exit reporting and diagnostics

- Exit/crash is detected only through the existing read-only signals (watcher phase changes, per-service marker reconciliation, launch events) — **no process killing, no new window enumeration, no polling added**.
- Every real transition produces a receipt; PID-reuse failures classify as `crashObserved`; `lifecycle_cause_label` gives the truthful Polish diagnostic.
- `SessionsPanel` shows per-session status (+ lifecycle), last error, and a bounded "Diagnostyka" view with the last transition and receipts (strictly normalized from the wire). All panel reads are bounded via the existing `withTimeout` pattern (`STATUS_READ_TIMEOUT_MS`); event-driven refresh via the existing `velora-launch-event` and window `focus` — **no new polling**.
- `session_monitor.rs` resume events carry a truthful `diagnostic` line; `session_orchestrator.rs` orphan recovery is labelled via `recovery_reason_label`.

## 2. Explicit limitations (honest, also pinned in code and tests)

1. **No provider playback-state read/persist/restore.** DRM boundary: VELORA never reads playback state of Netflix/YouTube/Disney+/Prime/Max (no SMTC for these, no accessibility scrape, no DRM/HDCP/browser-security bypass). Media control remains a **blind toggle** (Space/K) — pinned by `PLAYBACK_STATE_READ_SUPPORTED = false` in `streaming_control.rs` and `PLAYBACK_STATE_LIMITATION` in `veloraSessionManager.ts`, shown in the panel diagnostics.
2. **No guarantee of automatic foreground focus.** The Windows foreground lock can deny any foreground request; VELORA never forces it (no `SetForegroundWindow` escalation, no keystrokes). Denials are reported truthfully (`blockedByWindows` + `foregroundLock`), and an unexplained denial / accessibility-API failure is reported as **"unknown"**, never guessed.
3. **Exit/crash detection is observation-only.** Receipts derive from the launch watcher (process/window observation) and markers. A crash is *suspected* (PID reuse, failed start, vanished window) and labelled as such — VELORA does not attach debuggers or read crash dumps.
4. **Receipts are in-memory and bounded** (32 per session, 8 projected to the UI). They are deliberately **not** persisted in `session_store` (crash recovery persists only the session snapshot); pinned by a test.
5. **Client-side coordinator is an early hint, not the authority.** The native `LaunchRegistry` remains the single lifecycle store and the authoritative duplicate guard; if the UI misses an event, native adoption still prevents a duplicate spawn.
6. **Web preview** (`!isTauri()`) has no sessions; the coordinator is not consulted there and no native state is fabricated.
7. Hardware behavior (first-launch focus asymmetry, real Netflix/YouTube transitions on the MSI, sleep/resume with live sessions) remains **NOT TESTED** — Luna's procedure in `docs/velora-2-s2-9-luna-test-procedure.md`.

## 3. Files changed (ownership-respecting)

TS: `src/services/{veloraSessionManager, windowFocusRestore, sessionTransitionNotice, sessionRecovery, edgeCinemaLifecycle, openStreamingService}.ts`, `src/components/SessionsPanel.tsx`.
Rust: `src-tauri/src/{launch_registry, velora_session_manager, edge_cinema, window_broker, session_monitor, session_orchestrator, session_store, streaming_control}.rs` (unit tests in-module).
New tests: `src/__tests__/ascensionB{SessionLifecycle,SessionSoak,FocusRestore,OpenStreaming}.test.{ts,tsx}`.
Doc: this file. No changes to `package.json`, locks, `tauri.conf.json`, capabilities, CSP, workflows, or any file outside the ownership list.

## 4. Verification (local, macOS)

- `pnpm test` — 116 files / 1084 tests PASS (base 112/1046 + 38 new).
- `pnpm build` (tsc -b + vite build) — PASS.
- `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` — 448 passed / 0 failed / 1 ignored (base 432 + 16 new; Windows-only modules cfg'd out on macOS).
- `pnpm test:soak` — PASS (3 tests, unchanged CrossSourceGate soak); the new seeded session soak (5000 transitions) runs inside `pnpm test`.
- `pnpm test:provenance`, `pnpm test:portable-manifest`, `pnpm test:claude-usage` — PASS.
- Not run locally: Windows MSVC cargo target, NSIS/portable builds — CI-only (PR #72 pipeline), not claimed here.
