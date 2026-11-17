# S2.3 Controller Simulator

## Purpose and entry point

The simulator exercises the native TV action route without a connected DualShock 4. It is a diagnostic client, not a second navigation implementation. Browser preview does not invoke native input.

In the Windows diagnostic candidate, open VELORA and press **F2**, or open **Control Center → Diagnostyka**. `GamepadDiagnostics` renders `ControllerSimulator` below the native controller status. The backend must advertise `simulatorAvailable`; otherwise simulator controls are absent. This check does not use Vite's `DEV` flag, so a packaged debug candidate can expose the panel while a release build cannot.

Computer Use can operate these visible controls. This document does not establish a successful live run. Scenario evidence belongs in `velora-2-s2-3-computer-use-results.md`.

## Local authorization and setup

1. Enable the existing native Home return for the current session. The simulator uses the existing streaming router enable operation and does not silently change the Home configuration.
2. Select **Włącz symulator diagnostyczny**. The native status, rather than a frontend preference, determines whether actions are enabled.
3. Choose one of the five service identities and use **Otwórz usługę testową**. This calls the existing trusted service launcher; it does not accept an arbitrary URL.
4. Return to diagnostics and choose **Odśwież sesje symulatora**. Only resumable Cinema sessions from the existing Session Manager are listed.
5. Select the intended session. `capture_tv_navigation_target` must resolve that session against native LaunchRegistry ownership; the UI never supplies an HWND or process ID.
6. Choose Automatic, Keyboard, Spatial or Pointer mode. An action deliberately restores the selected owned session and must still pass the native final identity and foreground checks.

The entire simulator subtree has `data-remote-admin`. The existing iPhone Remote selection policy rejects its buttons and selectors. Native debug and local-main-webview authorization remain necessary: hiding a button is not an IPC security boundary. No simulator action is added to the public LAN command vocabulary.

## Controls and dispatch

The UI supplies D-pad directions, equivalent left-stick directions, Cross, Circle, Square, Triangle, L1/R1 section requests, Options/Control Center, Home, scroll, right-stick pointer steps, click, seek, fullscreen, player mute and Windows volume/mute. Unsupported requests must return an explicit native result; displaying a button is not proof that a service supports that command.

Physical L1/R1 remain reserved for the unchanged fallback Home chord. Their simulator section requests are compatibility probes and do not establish a new hardware mapping. Physical Options opens Control Center only on a clean release without a PS/L1/R1 Home constituent; it does not replace the fallback gesture.

Pointer direction buttons supply a single bounded delta of 32 physical pixels. They do not run a continuous autonomous pointer loop. The real analog dead zone and acceleration are native responsibilities.

Each action waits **600 ms** after the UI activation before its one native invocation. This allows the initiating mouse button to be released. A synchronous frontend busy guard prevents double clicks from starting duplicate runs. Native generation, replay and ownership validation remain authoritative.

Playback shortcuts are disabled until **Uzbrój skróty odtwarzania** is selected. The warning explains that those keys can have another meaning on a catalog or form. The user must inspect the player before arming them. There is no automatic credential entry, title selection, purchase or rental action.

The bounded built-in scenario is **Down → Right → Back → Home**. It contains no Confirm or click. It stops after a rejected result or exception, does not retry, and never expands into a discovery or autonomous clicking routine.

## Native command contract

All names below are Tauri command names used by the frontend. They are not LAN endpoints.

| Command | Input | Expected result |
| --- | --- | --- |
| `get_tv_navigation_status` | none | Status including `simulatorAvailable`, `enabled`, `mode`, `activeStrategy`, `generation`, `mediaControlsArmed`, `lastSimulatorSequence`, captured target and last result |
| `configure_tv_navigation` | `enabled`, `mode` | Updated status; diagnostic enable remains an explicit operation |
| `capture_tv_navigation_target` | `sessionId` | Updated status after native owned-session resolution |
| `simulate_tv_navigation_action` | `action`, `sequence`, `generation`, `targetSession`, optional `deltaX`, `deltaY` | One native action receipt |
| `cancel_tv_navigation_simulation` | none | Updated status after native generation revocation |
| `set_tv_navigation_mode` | `mode` | Production local preference update; no simulator enable |
| `set_tv_navigation_media_controls` | `armed`, explicit owned `sessionId` when arming | Playback-shortcut arm bound to one owned session |

Simulator actions use a closed lower-camel-case enum. Inputs do not contain script, raw key code, arbitrary process name, URL or window handle. On refresh, configure, capture, arm and cancel, the frontend advances its sequence reference to at least the backend's `lastSimulatorSequence`. Reopening diagnostics therefore does not restart at a replayed sequence 1.

A receipt reports `accepted`, `effect`, `sequence`, `generation`, requested mode, active strategy, target presence, result text, ownership where reported and available dispatch/UI Automation timing. The action name is retained by the caller; source is known to be the simulator. The UI does not interpret `accepted` as paused, playing, title selected or purchase completed. A key accepted by Windows normally leaves the effect **unverified**.

Successful receipts update the displayed mode, active strategy and generation. A subsequent step uses the returned generation rather than continuing from a stale mode snapshot.

## Cancellation and uncertainty

Cancel clears the pending delay and revokes the remaining local sequence immediately. It also requests native generation revocation. Controls remain busy until that cancellation request settles. Closing diagnostics during an active simulator run requests the same native cancellation; closing an idle panel does not revoke real-controller input.

A command already accepted by Windows cannot be undone. The UI states this explicitly. A late native receipt can still be recorded, but it cannot start the next sequence action. A failed cancellation reply is reported as an unconfirmed native cancellation; future local sequence steps remain stopped. No input is retried after an unknown outcome.

## Diagnostics and export

The panel shows the action, selected target presence, strategy, ownership result where available, accepted/rejected dispatch and the separately reported effect. It displays native errors for local diagnosis, without treating them as proof of page behavior.

**Eksportuj zgodność TV · JSON** prepares a read-only JSON report in the panel. It retains at most 64 receipts. Export uses fixed field and code allowlists, preserves the public service identity only when it matches one of the five registry IDs, omits raw native errors, session IDs, titles, page content and URLs, and records `physicalHardwareVerified: false`. Unknown free-text values become `redacted`. It does not upload a report or create a file automatically.

Production `TvNavigationSettings` is separate from the simulator. It exposes local mode selection, active strategy and explicit playback-shortcut arming beside the existing streaming controls, including when `simulatorAvailable` is false. Arming requires choosing one resumable owned Cinema session; no latest-session guess is made. A currently armed session must be disarmed before selecting another. Non-Windows status disables these controls. Its controls are also denied to generic LAN selection.

## Automated verification and remaining acceptance

Frontend tests cover backend availability gating, explicit enable, LAN denial, one delayed dispatch, current generation and captured target, cancellation/unmount, rejection stopping a scenario, explicit media arming, sequence continuity, browser-preview denial, native argument shape and bounded diagnostic redaction. Production-setting tests cover release-visible preferences and failed status reads.

These are automated frontend tests. They do not prove native input acceptance, actual service navigation, playback effects, real Windows focus recovery or physical DS4 behavior. Those results must be recorded separately with the exact tested build and source commit.
