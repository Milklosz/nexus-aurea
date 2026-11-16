# S1.4 - Couch Freedom recovery candidate

**INCOMPLETE: physical controller acceptance is BLOCKED.** Tests and CI do not prove hardware behavior. This public report excludes host paths, device instance identifiers, installation fingerprints and private diagnostic payloads.

## Root causes and implementation

- The original native Home gate depended on keyboard Control Service, despite native DS4 navigation working independently. Add explicit process-lifetime Home opt-in, neutral rearming, and an explicit-disable override.
- A single Edge Cinema identity/group prevented another streaming service from opening. Use independent allowlisted service identities, profiles and markers; resume a validated owned window without creating a duplicate.
- Physical controller Home shared the conservative remote-device focus policy. Distinguish native local intent; retain conservative paired-remote behavior.
- Timing-based native/browser arbitration admitted delayed virtual echoes. A healthy native DS4 now exclusively owns controller navigation; re-prime held input on handoff. Physical Steam behavior remains unverified.
- Reuse the existing single hidden Raw Input sink and bounded Home worker. No helper executable, driver, global hook or elevation.
- Report native button/chord timestamps, bounded counters, queue rejection and actual activation results. No raw HID packets, device paths, credentials or window titles.
- Keep sessions tracked when Windows refuses focus. Validate HWND, PID and process creation time before one activation or confirmed close request. Never kill browser processes.
- Guard both dock and direct App Manager/Gaming Hub/Playnite launch paths. Missing native Home keeps an observed controller in VELORA; never silently arm Home.
- Cancel, Home and timeout invalidate pending launches. Status requests remain single-flight while uncancellable IPC is pending; a permanently hung request requires restarting VELORA.
- Preserve Claude Usage configuration and the base Cinema Minimal design. New dialogs reuse the existing overlay.

New service profiles require one-time login. The legacy profile is untouched; cookies and credentials are not copied or migrated.

## Architecture

The existing PadHub hidden window/message loop is the selected supervisor. Coupling Home to keyboard hotkey registration is removed. A separate helper process is deferred because no evidence justifies its startup, crash-recovery and authenticated-IPC complexity.

## Automated validation

| Check | Local result |
|---|---|
| Full Vitest | 851 passed, 90 files |
| Full Rust | 355 passed, 31 failed, 2 ignored fixture helpers |
| Rust failure cause | Credential Manager unavailable in the sandbox; the same dependency failures occurred in the baseline |
| Build provenance tests | 31 passed |
| Claude status-line adapter | 6 passed; no user configuration changes |
| TypeScript and production frontend | Passed |
| Clippy, all targets | Passed with warnings |
| Rustfmt, eight modified Rust modules | Passed |
| Whole-crate formatting | Fails in untouched legacy modules: 203 diff sections; baseline 336 |
| Patch whitespace | Passed |

Coverage includes HID parsing, chord timing/release/rearm, session override, background semantic recognition, reconnection and device isolation, delayed virtual input, Options release, cancellation and late replies, bounded status requests, direct-launch guards, service coexistence, process/marker reuse, window ownership and focus denial. Focused-run counts overlap full suites and must not be added to them.

## Hardware matrix

All rows concern the candidate and physical input. No mocked action is hardware PASS.

| Case | Status |
|---|---|
| DS4 Bluetooth / USB button validation | BLOCKED |
| D-pad / analog / Cross | BLOCKED |
| Circle / Options / Control Center | BLOCKED |
| Background / minimized report delivery | BLOCKED |
| PS + Options and actual Home foreground | BLOCKED |
| Fallback controller chord | BLOCKED: no physically validated mapping selected |
| Netflix to Home | BLOCKED |
| Netflix to YouTube to Home | BLOCKED |
| Disney+ to Home | BLOCKED |
| Max to Home | BLOCKED |
| Prime Video to Home | BLOCKED |
| Steam running / closed and duplicate input | BLOCKED |
| Playnite to Home | BLOCKED |
| Fullscreen / windowed streaming | BLOCKED |
| Ten return cycles | BLOCKED |
| Disconnect / reconnect / focus loss | BLOCKED |
| Candidate live Claude Usage and visual verification | NOT TESTED |

Steam desktop keyboard emulation is unverified. Source arbitration is not a claim of complete Steam Input compatibility. Third-party website navigation, pointer mode and a fallback controller chord are not implemented/validated here. Launching a service is not complete couch navigation inside it.

## Delivery and rollback

Branch: `feature/velora-2-s1-4-couch-control`, based on [S1.2 Draft PR](https://github.com/Milklosz/nexus-aurea/pull/56). Check actual delivery-commit CI in the Draft PR. No changes to that PR, its dependencies, main or the stable installation. No merge, stable release, driver installation or global Windows/Steam changes.

Close the installed launcher before a separate candidate run and confirm BuildInfo; the shared single-instance guard can otherwise activate the old launcher. Application state is shared, so copying an EXE is not full isolation. Rollback: exit the candidate and launch the unchanged installation. Replacing the installed application requires separate approval.

Required user-assisted test: connect the DS4 to the Windows target, verify PS/Options counters, then perform Netflix-to-Home-to-YouTube, Steam, ten returns and reconnection without keyboard/mouse during the workflow. Record actual foreground outcomes and failures. Keep the PR in draft until these gates pass.
