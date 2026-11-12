# VELORA — Windows hardware fix (Steam, foreground, auto-return)

Follow-up to `fix/velora-v1-final-hardening` (PR #20). Scope is the three
hardware problems seen on the MSI GP76 Leopard 11UG with the Panasonic
TX-49EX610E. No redesign, no new features, no new dependencies.

## Status — read first

- **Hardware: NOT TESTED.** This work ran in a Linux container. It had no
  access to the MSI, no Windows desktop and no Computer Use. Every MSI row stays
  `NOT RUN` in `docs/velora-v1-msi-acceptance.md`. CI proves compilation and
  automated behaviour only.
- **Verified here:** Rust unit tests (Linux host), a Windows-target type-check
  of the Win32 code (`x86_64-pc-windows-gnu`), frontend tests and production
  build. Windows CI results are recorded in the Draft PR, not claimed here.
- **Base:** `fix/velora-v1-final-hardening` at `ebd0c86`.

## Root causes (static analysis)

### Bug 1 — the PlayStation button opens Steam Big Picture

- Steam Input consumes the PlayStation/Guide button. With "Guide button focuses
  Steam" enabled it brings the Steam client or Big Picture to the front.
- VELORA reads the DualSense through Raw Input with `RIDEV_INPUTSINK`
  (`gamepad_home.rs`). That path does not depend on window focus. Whether the
  PS+Options chord still reaches VELORA while Steam Input is active depends on
  whether Steam hides the device. That was not verified on hardware.
- VELORA had no Steam-specific diagnostics. The only signal was the generic
  "raw reports missing" warning after 8 s.

### Bug 2 — launched applications appear behind the fullscreen VELORA

- The launch paths never granted a foreground hand-off: Edge Cinema
  (`msedge.exe` spawn), App Manager (Steam Big Picture, Playnite, browsers),
  `steam.exe -applaunch` for Gaming Hub games, `steam://` and `playnite://`
  URIs, and `launch_platform`.
- Windows lets a background process take focus only under specific conditions.
  Examples: it is started by the foreground process, it received the last input,
  or it was granted the right with `AllowSetForegroundWindow`. Steam and Playnite
  are single-instance: the process
  VELORA starts forwards the request to a client that is already running, and
  VELORA did not start that client. Its window has no grant, so it appears behind
  the launcher.
- Native fullscreen does not change these rules. Borderless windowed mode was
  not adopted: nothing in the code shows it is the cause, and it cannot be
  verified without the MSI.

### Bug 3 — VELORA does not return after a managed application closes

- After a managed launch ended, `restore_velora(SessionEnded)` allowed focus only
  for VELORA, the desktop shell, Playnite, or VELORA's own process
  (`window_broker.rs`, `evaluate_restore`).
- When the Steam client or Big Picture stayed in front after a game exited, the
  decision was `blockedUnsafeForeground`. The launch's own processes had already
  been released from the tracked set before the restore ran
  (`launch_registry.rs`, `apply_observation`).
- The UI fallback `returnToNexus` retried focus with Tauri's `setFocus`. In tao
  that call falls back to an injected Alt keypress
  (`tao::platform_impl::windows::window::force_window_active`). That is a
  foreground-lock workaround, and the spec forbids it.

## Fixes implemented

| Area | File | Change |
|---|---|---|
| Foreground hand-off | `window_broker.rs` | `grant_foreground_handoff(pids)` calls `AllowSetForegroundWindow` for the spawned child and any already-running client. It runs only while VELORA holds the foreground, never grants PID 0 or VELORA itself, and de-duplicates targets. |
| Hand-off call sites | `edge_cinema.rs`, `app_manager.rs`, `playnite_library.rs`, `platform_launchers.rs` | Called right after each spawn or adoption, inside the user's launch gesture. Playnite uses `ASFW_ANY` for one call only when Playnite is not running yet, because the shell then creates a process with no PID to name. |
| Hand-off diagnostics | `window_broker.rs` | The last attempt (`attempted`, `granted`, `notForeground`) is returned in `get_window_broker_status` as `lastHandoff`. |
| Auto-return ownership | `launch_registry.rs` | Each launch records the creation time of its own root and, for descendant-scoped watches, its descendant processes, while they are observed. The ended launch passes that map to the restore. Image-name matches across the machine are never recorded. |
| Auto-return policy | `window_broker.rs` | `evaluate_session_end_restore` keeps every existing rule. It adds one case: the foreground process belongs to the ended launch, matched by PID **and** creation time. A recycled PID never inherits the grant. Unrelated applications are still not focused. |
| Stale watchers | `session_orchestrator.rs` | `context_owned_by_launch` is the pure ownership rule used by launch completion. A stale launch id never finishes a newer session. |
| UI focus retry | `App.tsx` | The Home fallback no longer calls `setFocus`. It shows an honest message instead. The native restore result still reports denials. |
| Steam diagnostics | `control_service.rs` | While the isolation warning is active and `steam.exe` runs, the warning adds a checklist for the Steam setting. It does not state a root cause. |
| Windowed recovery | `control_service.rs` | The emergency shortcut Ctrl+Alt+F12 still stops the Control Service. It now also leaves fullscreen and restores the window frame, so the taskbar and Alt+Tab work while a managed app holds the foreground. |

## Deliberately not implemented

- **Alt-key injection, `AttachThreadInput`, `SystemParametersInfo` foreground
  lock timeout.** These bypass the foreground lock. The spec forbids it, and
  they can also send keys into a game.
- **Deferred or background retries of the automatic return.** A later visit to
  the desktop, for example to open another app, would be overridden. That
  breaks explicit user navigation.
- **Z-order raises or always-on-top.** They would cover other applications.
- **Changing Steam settings or disabling Steam Input globally.** Requires user
  approval. Section "Steam setting" documents the narrowest option.
- **Borderless window mode.** No evidence it fixes foreground rights, and it
  cannot be tested here.

## Known limits (hardware-dependent)

1. **DualSense Home while a third-party app is in front.** Windows may still
   refuse `SetForegroundWindow` for a background process whose only input is
   Raw Input from a gamepad. The result is `blockedByWindows`. Use Ctrl+Alt+N
   (`RegisterHotKey`, keyboard input) or Alt+Tab. Verify on the MSI (rows J1, J5).
2. **Auto-return after a close.** When the managed window closes, Windows
   activates some other window. The policy now allows VELORA's restore attempt
   in more cases, but Windows still decides whether `SetForegroundWindow`
   succeeds. A refusal is reported as `blockedByWindows`, never hidden.
3. **`ASFW_ANY` for Playnite when it is not running.** The grant lasts until
   Windows resets it, which is not documented in detail. Check that nothing else
   steals focus during the session.
4. **Pre-existing startup behaviour of tao.** The main window is created with
   `fullscreen: true`. Tao then calls `force_window_active` at creation, which
   can inject an Alt keypress when `SetForegroundWindow` fails at startup. This
   was not changed: removing it means creating the window windowed and entering
   fullscreen afterwards. That changes startup visuals and needs the MSI to
   verify. Recommended follow-up.
5. **Steam option label.** The label "Guide button focuses Steam" is the English
   UI name. Check the exact text in your Steam language and version.

## Steam setting (Bug 1)

VELORA does not change Steam settings.

1. Open the Steam client → Settings → Controller (general controller settings).
2. Turn off **Guide button focuses Steam** (English UI name). The option applies
   to the Steam client, not to individual games.
3. Restart VELORA and test PS+Options from the VELORA Home screen.

Broader option, only with your explicit approval: turn off **PlayStation
Configuration Support**. Steam then stops mapping the DualSense completely, and
that affects games too.

## Tests added

Rust (Linux host, `cargo test --locked --lib`): 237 existing tests plus 18 new (255 total).
Frontend: 443 existing tests plus 3 new in `src/__tests__/foregroundPolicy.test.ts` (446 total).

| Requirement | Test |
|---|---|
| Foreground hand-off | `window_broker::handoff_and_session_end_tests::*handoff*`, `a_handoff_without_real_targets_is_a_silent_no_op_on_every_platform`, `the_handoff_diagnostic_keeps_camel_case_keys_for_the_status_snapshot` |
| Managed application exit | `steam_client_left_in_front_after_a_game_ends_lets_velora_return`, `unrelated_processes_stay_untouched_even_when_another_launch_tracks_them` |
| Stale watcher protection and recycled PIDs | `a_recycled_pid_with_another_creation_time_never_inherits_the_grant`, `session_owner_tests::a_recycled_root_pid_is_never_recorded_as_an_owner_of_the_ended_launch`, `stale_watcher_tests::*` |
| Session lifecycle | `stale_watcher_tests::a_stale_watcher_cannot_finish_a_session_after_home_or_a_newer_launch` (alongside the existing `session_orchestrator` transition tests) |
| Foreign processes never owned | `session_owner_tests::an_image_name_match_across_the_machine_is_never_recorded_as_owned` |
| Steam / VELORA input coexistence | `control_service::steam_input_tests::*` (the chord and raw-input tests already existed) |
| Home during application startup | existing `session_orchestrator::a_home_request_queued_behind_a_launch_is_superseded` |
| Fullscreen-to-application transitions | existing `session_orchestrator` hand-off plan tests |
| No WebView focus retry, no bypass APIs | `src/__tests__/foregroundPolicy.test.ts` (source invariants) |

## MSI acceptance checklist (short)

All rows are `NOT RUN` until someone runs them on the MSI with the Draft PR
installer. Record the installer SHA-256, the commit and the Windows build.

- [ ] **M1** Steam Big Picture from VELORA, VELORA fullscreen → Steam window in front.
- [ ] **M2** Netflix in Edge Cinema → Edge window in front; VELORA alive behind it.
- [ ] **M3** Playnite Fullscreen from VELORA → Playnite in front.
- [ ] **M4** Close the Edge Cinema window → VELORA returns once, no duplicate toast.
- [ ] **M5** Exit a Steam game → VELORA returns, or a clear `blockedByWindows` message appears. Record which.
- [ ] **M6** Exit Edge while Chrome is in front → VELORA does not take focus from Chrome.
- [ ] **M7** PS+Options while a managed app is in front → one Home attempt, honest result, no retry loop.
- [ ] **M8** Ctrl+Alt+N from Steam or Edge → VELORA in front.
- [ ] **M9** Ctrl+Alt+F12 → Control Service stops, window gets a frame and leaves fullscreen.
- [ ] **M10** With the Steam option from this document applied, PS button → Big Picture no longer opens and PS+Options still works.
- [ ] **M11** Check `lastHandoff` in the broker status after each launch. Record attempted/granted/notForeground.

## Verification commands (reproduce locally)

```bash
cd src-tauri && cargo test --locked --lib
cd src-tauri && cargo check --locked --target x86_64-pc-windows-gnu --lib --tests
pnpm test
pnpm build
git diff --check
```
