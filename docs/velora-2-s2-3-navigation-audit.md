# S2.3 navigation audit

Audit date: 2026-11-16. This is an engineering candidate, not controller acceptance.

## Verified starting point

The requested workspace is a separate Git repository at `work/grand`. It was clean on `docs/velora-grand-rc2-evidence`, `ec8d185`, whose only change after the integrated source is acceptance documentation. `a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea` exists and is the source of candidate 0.10.0-rc.2. S2.3 branches directly from that source as `feature/velora-2-s2-3-native-tv-experience`.

GitHub connector metadata independently confirms the unchanged open Draft stack:

| PR | Head | Source |
| --- | --- | --- |
| [58](https://github.com/Milklosz/nexus-aurea/pull/58) | S2.0 | `05f7235` |
| [59](https://github.com/Milklosz/nexus-aurea/pull/59) | S2.1 | `89886f0` |
| [60](https://github.com/Milklosz/nexus-aurea/pull/60) | S2.2 | `f232ea6` |
| [61](https://github.com/Milklosz/nexus-aurea/pull/61) | integration fixes | `a7c53b3` |

The outer workspace is on older independent source `ec28205` and has pre-existing untracked `.codex/` and `target-int/`; S2.3 does not modify it. No `AGENTS.md` was found in the development repository.

## Input and duplication

`PadHub` owns one hidden Windows Raw Input message window, decodes DS4 HID reports, and supplies both the native frontend snapshot and the streaming worker. `controller_supervisor` owns the deliberately enabled L1+R1+Options fallback; PS+Options is suppressed when that fallback is selected. Both use the existing bounded Home transaction. Home configuration must remain unchanged.

`useNativeController` and `useGamepad` share the frontend `ControllerEngine` and `crossSourceGate`. Foreground/visibility and Control Service ownership checks suspend local navigation outside VELORA. External website actions are native, not sent from both React and Raw Input. A new simulator must enter the existing native route and must not emit a duplicate React event after native handling.

`StreamingControl` already has an eight-report nonblocking queue, 33 ms sampling, 200 ms stale limit, controller/config epochs and neutral rearm on source/target changes. Overflow revokes the controller generation. The initial repeat is 160 ms without separate first-repeat delay or acceleration. Left analog catalog navigation and standalone media commands are absent. Square currently means Tab; this changes explicitly to requested play/pause in S2.3, with section navigation exposed separately.

## Window ownership and sessions

`LaunchRegistry`, `WindowBroker`, Edge Cinema and `velora_session_manager` already provide tracked service launches and exact owned resume. Streaming target identity includes launch ID, HWND, PID and process creation time. Both the authoritative registry and current foreground must match. Broad `msedge.exe` matching is not ownership. The native sender checks foreground and generation immediately before `SendInput`.

Clicks/scroll additionally require cursor bounds and an unobscured owned hit target. Held keyboard modifiers or a physical mouse drag suspend generated input. Pointer movement uses virtual-desktop absolute coordinates and clamps to the owned client rectangle; real high-DPI and secondary-screen behavior still needs live evidence. Global input synthesis retains the documented final-check/insertion foreground race and UIPI limits. There is no permission to weaken those checks for simulator convenience.

## Browser and profiles

The supported managed target is a distinct Edge Cinema window, not arbitrary browser tabs. Existing allowlisted services are Netflix, desktop YouTube, Disney+, Max and Prime Video. No versioned navigation capability registry exists. Arrow keys can change playback position/volume instead of selecting catalog items. Alt+Left is browser history, not universally a service dialog Back. There is no verified desktop YouTube TV endpoint; use ordinary desktop YouTube unless real evidence establishes another supported experience.

Existing official keyboard references in the S2.0 document guide investigation but are not live compatibility evidence. Account-protected catalog/playback may be unavailable without a pre-existing legitimate authenticated session.

## Missing capabilities

- A source-independent, recorded action contract and common routing decision.
- Explicit automatic/keyboard/spatial/pointer selection and conservative service profiles.
- Play/pause/seek/fullscreen routing with accepted versus effect-unverified results.
- A supported Windows UI Automation provider and geometric candidate selection.
- Developer-only simulator using the real native dispatch path, bounded scenarios, cancellation and sanitized diagnostics.

## Preserved integrations and security

Control Center owns controller settings, sessions, audio/display and local recovery. The iPhone PWA uses existing HTTPS/HMAC/replay authorization and a small semantic allowlist; it must not acquire simulator, arbitrary key, HWND or pointer injection endpoints. Gaming Hub/TV Mode, Smart Home, clock/weather, Claude Usage and single-instance/restart behavior are inherited and receive regression coverage.

Tauri's main capability has no remote URL grants. Simulator commands must additionally check a local `main` WebView and native development build gating; a hidden frontend button alone is insufficient. Do not log element names, URL/title, passwords, controller device paths or account content. No DRM, browser extensions, process injection, package changes, hooks, elevation or machine settings are needed.

## Testability and environment

Windows Computer Use was initialized using the bundled `@oai/sky` entry point; `list_apps` succeeded. No VELORA window was running in that inventory. A separate candidate may be launched for testing without installing it. This is access evidence only, not a passed navigation test.

Shell network DNS currently fails for GitHub and local `gh` authentication reports invalid; the authenticated GitHub connector can read the four PRs. The installed dependency tree is in the outer workspace, while `work/grand/node_modules` contains only Vite caches. Bare `pnpm test` attempted an unauthorized package-store symlink and failed before tests. Direct installed tool entry points are available for tests/builds without changing system/package-manager settings. Baseline/native and final results are recorded in the release gate as they finish.
