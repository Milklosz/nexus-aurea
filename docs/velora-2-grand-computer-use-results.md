# Grand Living Room Computer Use results

Date: 2026-11-16

## Candidate

- Candidate: VELORA 0.10.0-rc.1 debug executable, built from source commit `f232ea698adf3e15003a167f032543a61f26324e`.
- Candidate manifest: source tree clean; executable SHA-256 `0979e3f5e0c7ecc2bbce8340898f73cbce777673afc2de3264179be90614b71a`.
- Launched and operated the local candidate through the repaired `@oai/sky` Computer Use runtime. The installed application was not installed, replaced, or modified.
- Tests used screenshot-backed UI coordinates and refreshed state after actions. An accessibility-index click once opened Prime Video instead of reordering a favorite; subsequent actions used screenshot coordinates. No browser sign-in, cookie, or security prompt was completed.

## Scenario results

| Scenario | Result | Observed evidence |
| --- | --- | --- |
| CU-01 — Startup | PASS | Launched the exact rc.1 candidate and saw the Home screen. |
| CU-02 — Smart Home | PASS | Launched Netflix and YouTube through their tiles; both appeared in Recent. Home was restored with the expected service card. |
| CU-03 — Favorites | PASS | Reordered YouTube ahead of Prime Video and pinned Steam. Both changes remained after an app exit and direct relaunch. Restored the initial default list: Netflix, Disney+, HBO Max, Prime Video, YouTube. |
| CU-04 — Resume | PASS | Session Manager showed managed Netflix, YouTube, and Prime Video windows. Resuming Netflix returned to its managed window and foreground state. |
| CU-05 — Window switching | PASS | Switched between VELORA and managed streaming windows and returned to VELORA. Unrelated-browser preservation: NOT TESTED; no separate unrelated window was baselined before the run. |
| CU-06 — Control Center | PASS | Opened Control Center and navigated Cinema, Gaming, and Sessions. |
| CU-07 — Volume | PASS | Read volume/mute, deliberately lowered and raised volume, then restored the exact original volume and mute state. |
| CU-08 — Audio | PASS | Read the native default render output without changing the output device. Local device labels are omitted. |
| CU-09 — Remote | BLOCKED | No test client or physical iPhone was used. Enabling remote access or changing firewall/trust settings was outside this run. |
| CU-10 — Gaming Hub | PASS | UI detected Steam and a real installed-game library; Playnite was reported as unavailable. Local game metadata is omitted. No game or launcher was started. |
| CU-11 — Game launch | NOT TESTED | No safe test target was launched. |
| CU-12 — Display | PASS | UI detected native display placement and marked the primary/current VELORA display. Local topology metadata is omitted. Physical TV/HDMI identity was not verified. |
| CU-13 — Fullscreen | PASS | Switched to windowed mode and back to fullscreen; both actions displayed success feedback. Escape closed Control Center while VELORA remained open. Returned to windowed mode. |
| CU-14 — Autostart | PASS | Read “wyłączony”; left autostart and the `--windowed` checkbox unchanged. |
| CU-15 — Recovery | FAIL | In-app “Uruchom ponownie VELORA” exited the candidate but did not start a replacement. After 1.6 seconds, the candidate window and exact executable process were absent. Direct Computer Use relaunch succeeded. Favorites persisted across that exit/relaunch. |
| CU-16 — Claude Usage | PASS | Home widget reported “Nieaktualne” (stale), rather than showing a fresh value. |
| CU-17 — Weather and clock | PASS | Home showed a 24-hour clock and a Zabrze weather reading. |
| CU-18 — Diagnostics | PASS | Diagnostics showed version 0.10.0-rc.1 and the matching source commit. Export generated an inline JSON report and displayed a SHA-256 digest; the UI stated the report excludes credentials and private paths. No report was uploaded or shared. |
| CU-19 — Regression | PASS | Cinema Minimal Home and its service launchers remained visible after navigation and recovery actions. |
| CU-20 — Installer | PASS | Scripted artifact inspection: checked rc.1 installer provenance metadata and its SHA-256 against the local artifact. No installer UI, install, upgrade, or rollback was run; the installed application was left untouched. |

## Session close observations

Managed Netflix Close completed; after refresh the session showed “Zakończona” and its owned browser window was absent. YouTube Close and Prime Video Close both remained “W tle” after confirmation and refresh, with the owned windows still present and a pending-close message. Prime Video had an untouched first-run browser overlay. No external process termination or other fallback was used.

## Deferred acceptance

- Remote authentication, pairing, iPhone behavior, firewall/trust configuration, and session control from a separate client were not tested.
- No DualShock 4 was connected; controller navigation, Home chords, deduplication, reconnect, and repeated-return scenarios remain unverified.
- No physical Panasonic TV or HDMI route was available for confirmation. The detected Windows display is not evidence of TV identity.
- Performance measurements were not captured in this rc.1 round.
- Installer integrity metadata was checked without installation. Upgrade and rollback behavior remain NOT TESTED.
- Keyboard and mouse actions do not establish controller acceptance.

The rc.1 restart failure is tracked separately from later candidate validation. Do not promote these results to physical hardware acceptance.

Detailed local observations are retained only in ignored `outputs/`, not uploaded. This public matrix excludes actual device labels, user volume preferences, local topology and game metadata. The final rc.2 build must identify its own source and restart result; the rc.1 failure remains part of the evidence.
