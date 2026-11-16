# S2.0 physical hardware acceptance

**INCOMPLETE — no physical acceptance PASS is claimed.** Date: 2026-11-16. A mocked HID report, keyboard/mouse click, successful registration, build or unit test is not a physical controller test.

## Observed environment

The installed executable's read-only file/product version metadata reports `0.9.2`. This audit did not replace or launch that binary as the S2 candidate. Matching process queries returned no relevant processes in the restricted tool context; the interactive desktop state is not established. CIM access to HID/monitor inventory was denied. DS4 Bluetooth connectivity, current TV attachment and Steam/Playnite availability remain unverified. No iPhone trust/profile or remote configuration was changed.

## Mandatory scenario matrix

| # | Physical scenario | Status | Evidence required |
|---|---|---|---|
| 1 | VELORA → Netflix → Home → YouTube → Home, no keyboard/mouse | BLOCKED | Run identified S2 binary; user presses actual pad; record recognized Home and actual foreground each time |
| 2 | VELORA → Steam → Home, no keyboard/mouse | BLOCKED | Steam available/running; actual controller Home from Steam foreground |
| 3 | VELORA → Playnite → Home, no keyboard/mouse | BLOCKED | Playnite installed/configured; actual controller Home from its foreground window |
| 4 | Open provider, navigate interface, return Home | BLOCKED | Site login available; verify D-pad/Cross/Back and opted-in pointer/scroll on real site; do not infer from browser launch |
| 5 | Disconnect/reconnect DS4 and resume navigation | BLOCKED | Actual Bluetooth disconnect/reconnect, neutral rearm then one action per press |
| 6 | Repeat Home restoration ten times | BLOCKED | Ten separate physical gestures with foreground outcomes; no synthetic reports |
| 7 | Steam running: verify no severe double input | BLOCKED | D-pad, held input, Cross, Options, primary/fallback Home; compare Steam closed/running |
| 8 | Claude Usage valid or correctly stale/unavailable | NOT TESTED | Candidate live widget and source timestamp/status; no invented usage values |
| 9 | Cinema Minimal, 24 h clock and Zabrze weather | NOT TESTED | Candidate visual inspection and actual weather-fetch status; tests alone establish no live weather |
| 10 | iPhone remote Home/navigation when configured | BLOCKED | Existing authenticated pairing/trust and same LAN; actual phone commands plus network interruption/reconnect |

`BLOCKED` means a required physical interaction or runtime/environment prerequisite is unavailable to this audit. It does not mean a failing implementation has passed. Live widget/layout scenarios remain `NOT TESTED` until observed. Record failures as FAIL with a minimal reproducible trace, not by leaving a previously blocked row unchanged after a real failure.

## Smallest user-assisted first gate

1. Close installed VELORA, run the separate candidate and confirm its displayed source commit. Keep the installed binary untouched. Use a setup keyboard only before the couch workflow, if login/opt-in is required; record it as setup, not couch acceptance.
2. Connect DS4, enable session Home with fallback disabled, release every button, then press PS and Options separately. Confirm native last-button timestamps advance. With Netflix foreground, test PS+Options and record report count, recognition, dispatch and actual restoration. If it fails, mark FAIL and recover using an alternate configured remote or a setup keyboard; do not call that attempt couch-only PASS. Locally enable the deliberate fallback, release all gesture buttons, reopen the provider and test its hold separately. Enabling fallback suppresses primary PS+Options, so never test the primary while fallback is selected.
3. Using only the pad, run Netflix → Home → YouTube → Home. In one service verify actual navigation/selection/back or pointer mode. If either Home route fails, stop claiming couch acceptance and capture the exact failing stage.
4. Continue with Steam, Playnite (if present), ten Home returns and a physical reconnect. Check Steam running versus closed for duplicate inputs. Check Claude, visual clock/weather and the existing paired iPhone if available.

Report only sanitized stages/counters/provider identifiers. Public logs must not include raw HID bytes, device paths, private browser titles, tokens, pairing codes or viewing history. Keep physical observations distinct from automated simulations.

## Performance capture during acceptance

Measure candidate startup time, idle CPU/memory over a stated interval, event/report rate, ten Home latencies and reconnect time with stated clock/measurement method. Configured polling intervals are not these measurements. No trustworthy runtime numbers were obtained during this restricted source audit.

## Rollback

Exit the candidate, then reopen installed VELORA 0.9.2. Candidate and installation share a single-instance identity and existing state, so verify BuildInfo before testing and do not run both simultaneously. Session-only controller settings reset at process exit. Do not delete browser profiles, Credential Manager data or application state as a rollback shortcut. Autostart/display/audio/firewall settings remain unchanged unless a later explicitly approved operation changes them.
