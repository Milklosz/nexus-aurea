# VELORA 2.0 — Sprint A status (lifecycle and recovery)

Date: 2026-11-13. Companion to `velora-2.0-audit.md`,
`velora-2.0-integration-plan.md` and `velora-pr22-recommendation.md`.

Hardware checks in this document are NOT RUN. They were not performed on a
physical MSI, DualSense, DualShock 4, HDMI display or TV.

## Draft PRs (all open; none merged or closed)

| PR | Branch | Base | Change |
|---|---|---|---|
| #33 | `fix/velora-2-shortcut-guards` | #32 | Shortcut guards for F11 auto-repeat and Ctrl/Alt/Meta; audit doc |
| #34 | `fix/velora-2-focus-restore-overlays` | `integration/velora-2.0` | Window focus does not move the dock highlight under an open overlay |
| #35 | `feat/velora-2-nav-back-intent` | #34 | Keyboard Backspace uses the shared `back` intent; parity tests |
| #36 | `fix/velora-2-lifecycle-audit` | `integration/velora-2.0` | Startup recovery notice read from the session snapshot |
| #37 | `fix/velora-2-toast-timer` | `integration/velora-2.0` | Toast dismiss timer no longer cleared on every re-render |
| #38 | `fix/velora-2-session-transition-notice` | `integration/velora-2.0` | Toast when a session transition fails, after the retry |
| this | `docs/velora-2-sprint-a-status` | `integration/velora-2.0` | PR #22 recommendation and this status |

`integration/velora-2.0` = #33 + side PRs #25, #26, #27, #29, #30. It has no
PR of its own. Its last CI run (`cdef18d`) passed.

## Confirmed and fixed in this sprint

Each fix was proven first, either by a failing test or by reading the code path.

1. **Toast never cleared** (#37). `useToast` ran its cleanup before every render,
   so the dismiss timer was cleared right after `showToast`. The 4 new tests
   failed on the old code.
2. **Startup recovery notice never reached the user** (#36). The native
   `velora-session-recovery` event is emitted from `setup()`, before the WebView
   exists, so no listener can receive it. The notice was visible only in the
   diagnostics panel. Now the UI reads `recovery` from `get_session_state` on mount.
3. **Failed session transitions were silent** (#38). `recordSession` swallowed the
   final error. The code comment assumed a native error event, but no listener
   exists for `velora-session-error`. Now a toast is shown.
4. **Held F11 toggled fullscreen repeatedly; Ctrl+Escape exited fullscreen** (#33).
5. **Dock highlight moved under an open overlay on window focus** (#34).
6. **Keyboard back was a separate code path** (#35). Now the shared `back` intent.

## Checked and found sound (no change)

- Single-instance guard: named `Local\` mutex, window title checked by unit test,
  handle released on process exit. Fails open if the mutex cannot be created.
- Session state file: atomic write (temp file, then rename), 64 KB size limit,
  version check, corrupt state falls back to Home with a recovery record.
- Restart recovery: a persisted launch context is not trusted after restart;
  orphaned launches are reconciled every 5 s. Covered by tests in
  `session_orchestrator.rs`.
- Production Rust code: no `unwrap`/`expect` on hot paths. The remaining
  `expect`s are at Tauri startup and on constant configuration.
- Frontend timers and listeners: all 36 `useEffect` calls have a dependency list;
  intervals and listeners are paired with cleanup (scan with the TypeScript
  compiler API, not grep).
- Launch guard against double activation: releases in `finally`.

## Risks found but not proven (not changed)

- **Sleep detection relies on `Instant`.** `session_monitor.rs` detects resume by a
  gap in the monotonic clock. On Windows, behavior of `Instant` during sleep depends
  on the hardware clock. If it does not advance during sleep, resume is never
  detected. NOT RUN: needs a real sleep/wake cycle.
- **A hung native launch keeps its tile locked.** `useLaunchGuard` releases only when
  the action settles. A launch that never settles locks the tile until restart.
  Changing this would reopen double activation, so it is a trade-off, not a fix.
- **Watcher thread death.** The launch watcher and session monitor have no panic
  guard. A panic inside a tick would stop the thread, and the `*_STARTED` flag
  would stay set, so the thread would not restart. No panic was found in the
  production paths, but this is not guarded.
- **Child processes survive VELORA exit.** Nothing kills launched games, Steam,
  Playnite or Edge when VELORA closes. This is deliberate (VELORA must not kill
  the user's apps), but it means a game can keep running after VELORA shows Home.
  The next start reports it as "not claimed", which is correct, but there is no
  way to return to it from VELORA.
- **Native DualSense Home failures are not shown on the TV.** The failure is kept
  in the Control Service status only. The `velora-gamepad-home` event has no
  frontend listener.
- **`velora-launch-error` has no frontend listener.** Launch failures reach the UI
  through the invoke result; the extra event is unused. Not proven to lose errors.
- **Temporary session files.** A crash between write and rename can leave
  `velora-session.tmp-<pid>` behind. Harmless, but never cleaned up.

## Not verified (NOT RUN)

- Real sleep and wake on the MSI, including HDMI monitor disconnect and reconnect.
- Window focus and Alt+Tab with an open Control Center on a real TV setup.
- Crash of WebView2, Edge streaming session, or streaming process during a session.
- Two launches of the installed app on Windows (single-instance window activation).
- Restart after Windows reboot and sign-in.
- DualSense, DualShock 4, iPhone remote and TV input with real hardware.
- Installed MSI build. No new build was installed; the rollback folder was not touched.

## Update 2026-11-13 (second pass)

Added since the first status above:

- **#40 (WebView2 and Edge launch)**: `launch_managed_app` and
  `launch_managed_game` now return an error when `track_launch` fails after a
  spawn. Before, the error went to an event nothing listened to, and the UI showed
  "Uruchamiam…" for an untracked app. A failed Steam baseline stops the launch
  before the spawn. Test covers the message helper only; the launch path needs a
  real AppHandle and is NOT RUN.
- **#41 (home zones)**: up and down move between Control Center, music, dock and
  Diagnostics on the shared intent model. This also fixes remote up and down on
  the dock, which used to do nothing.
- **#42 (keyboard model)**: the keyboard logic from PR #22, unchanged, plus
  `applyKeyboardIntent`. No UI yet.
- **Keyboard UI** (`feat/velora-2-virtual-keyboard-ui`): a modal dialog that opens
  only for fields marked `data-velora-text-entry`. No VELORA field is marked yet,
  so the keyboard is not reachable in the shipped UI. Password, read-only and
  external-service fields are never captured.
- **DualSense normalization** (`fix/velora-2-dualsense-input-normalization`): the
  PlayStation D-pad was read from buttons 14 and 15, which is not a documented
  D-pad on the raw Sony layout. Now the Sony hat on axis 9 is decoded when present,
  and buttons 14 and 15 are only a fallback. The hat table is NOT verified on
  hardware.

Still open, not changed:

- Edge window spawned before `track_launch`; if registration fails the browser
  window stays untracked. Needs a decision on whether VELORA may close its own
  spawned Edge process.
- Sleep detection uses `Instant`; behaviour across Windows sleep is NOT RUN.
- Watcher and session-monitor threads have no panic guard; the `*_STARTED` flags
  would stay set if a thread died.
- `useLaunchGuard` releases its lock in `finally`, so a tile stays locked only if
  the invoke never settles. The Rust launch returns after spawn, so this is
  unconfirmed and not changed.
- The PlayStation confirm and back buttons are Circle and Square. The standard
  profile uses A and B. The Cross-confirm convention is a product decision.
- DS4 (matched by the same PlayStation profile) goes through the same Sony hat
  decoder. That is code-path sharing only; it is NOT verified on DS4 hardware. The
  PS+Options chord is not implemented.
- `velora-launch-error`, `velora-session-error` and `velora-gamepad-home` have no
  listener in the UI.
- If WebView2 is missing at runtime, the `.expect` in `lib.rs` exits without a UI.

## How to continue

1. Confirm CI on the new Draft PRs before merging anything.
2. Decide on PR #22 (see `velora-pr22-recommendation.md`).
3. Run the NOT RUN checks above on hardware and update this document.
4. Choose the keyboard's first field and the Edge orphan policy.
