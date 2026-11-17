# S2.3 Computer Use — actual Windows results

Tested on 2026-11-17 through the bundled `@oai/sky` Windows Computer Use API. Candidate: **0.11.0-rc.1**, clean source **cc24affd970b3f4fb478f58f1dceb218708f7753**, local debug EXE SHA-256 **0024ea2708ad7149e1b1be19b09d413b82c365e1ce88a72a5992f34f83274ba9**. Windows reported 10.0.26200.0; Edge 157.0.4341.60; observed desktop 1920×1080. No connected physical controller. The release installer was not executed; these observations apply to the debug candidate.

## Method and boundaries

Actions in the developer simulator invoked the real native router. Ordinary Computer Use was also used for setup, service tiles, returning to the test UI and public YouTube search/title selection. Those setup actions are **not** controller-only navigation evidence. Initial YouTube cookie rejection happened during dirty-tree preflight. No password, account form, purchase, subscription or browser synchronization choice was submitted.

The dirty preflight (base a7c53b3) found native-select difficulties and simulated-cursor persistence issues. Those observations prompted explicit session/mode buttons and persistent bounded simulator cursor in the clean candidate. They are not counted as clean-build acceptance.

## Scenarios

| Scenario | Actual result | Evidence / remaining boundary |
| --- | --- | --- |
| CU-TV-01 startup | COMPUTER USE VERIFIED | One candidate window; diagnostics show version, full cc24aff source, debug Windows target, zero pads; clock/weather/Claude stale display observed |
| CU-TV-02 YouTube navigation | PARTIAL | Managed desktop site launched; native NextSection accepted; no meaningful page-focus change established. Public search/results/title selection used ordinary CUA |
| CU-TV-03 YouTube playback | PARTIAL | Public video page opened and preroll played; simulator toggled pause/resume on actual player during advertising. Main transmission playback/seek not separately verified |
| CU-TV-04 Netflix | PARTIAL / BLOCKED | Owned public Polish landing page opened; sign-in required for protected catalog, profiles and playback |
| CU-TV-05 Disney+ | PARTIAL / BLOCKED | Owned public Polish landing page opened; sign-in/subscription boundary; no account traversal |
| CU-TV-06 Max | PARTIAL / BLOCKED | Owned HBO Max Polish public page opened; cookie and browser-profile synchronization modal prevented further traversal. No synchronization/privacy choice changed |
| CU-TV-07 Prime Video | PARTIAL / BLOCKED | Owned Polish public landing page opened; account/membership required; no purchase, rental or signup |
| CU-TV-08 pointer | PARTIAL; bounded move, persistence and scroll VERIFIED | YouTube +32 move observed. Additional clean-build session on public Netflix: Confirm before Move rejected (“Move the simulated pointer before clicking”); +32 move observed at center +32; explicit click accepted over inspected noninteractive page text; scrollDown visibly moved page about 100 px; next +32 move reached center +64 despite GUI mouse movement. Empty-area click has no independent page-state effect. Real analog smoothness and other displays not live accepted |
| CU-TV-09 spatial | LIVE FAILURE / SAFE REJECTION | Down on YouTube returned “no eligible controls within query budget; select pointer mode.” No fallback click occurred. This is not spatial compatibility acceptance |
| CU-TV-10 keyboard | PARTIAL | NextSection native receipt accepted in 23 ms; page effect remained unverified. Player shortcut effects are narrower verified observations below |
| CU-TV-11 switching | PARTIAL | Five service tiles opened separate managed windows; YouTube tile resumed same HWND after Home. No complete controller-only Netflix catalog → Home → YouTube playback workflow |
| CU-TV-12 focus recovery | COMPUTER USE VERIFIED, narrow | Simulator restored its explicitly captured YouTube window from local VELORA before NextSection, pointer and media actions |
| CU-TV-13 fullscreen | COMPUTER USE VERIFIED | One simulator fullscreen action changed YouTube control from “Pełny ekran (f)” to “Zamknij pełny ekran (f)”; fullscreen player observed during preroll |
| CU-TV-14 media | PARTIAL, toggle VERIFIED | Explicit session-bound arm; one playPause changed “Wstrzymaj (k)” to “Odtwórz (k)”; next toggle restored “Wstrzymaj (k)”. Observation concerns preroll player; protected content, seek/captions/audio not accepted |
| CU-TV-15 deduplication | PARTIAL | Increasing simulator sequences 1–5 and 7 in export; single fullscreen and pause effect observed. Sequence 6 stopped at frontend focus gate. Physical source coexistence remains untested |
| CU-TV-16 unrelated window | COMPUTER USE VERIFIED, frontend gate | After scheduling pointerMove, focus moved to a new empty Paint window before 600 ms dispatch. UI reported “Fokus zmienił się na inne okno; symulator nie przywróci sesji.” No native receipt was added and Paint remained unchanged. Native race protection additionally has automated/source evidence; live case stopped before native invocation |
| CU-TV-17 restart | COMPUTER USE VERIFIED | Control Center restart replaced candidate PID 14012 with 40992 and one new window. Diagnostics retained cc24aff identity; simulator, native Home session override and arm reset; no second candidate process |
| CU-TV-18 regression | PARTIAL | Home, Cinema tiles, Control Center, session launch/resume, clock/weather, Claude stale indicator and diagnostics observed. Gaming/iPhone/physical TV workflows rely on automated evidence or remain untested |
| CU-TV-19 failure recovery | PARTIAL | Safe spatial rejection, explicit pointer selection, unrelated-focus cancellation and simulator Home observed. Closing the additional owned Netflix window automatically returned to shell and closed diagnostics; consequently no stale-target action receipt was produced. Home closed diagnostics without changing existing fallback gesture. Ctrl+Alt+N with Control Service disabled did not return Home (expected configuration boundary). Native stale-HWND rejection/UIPI not separately forced live |
| CU-TV-20 export | COMPUTER USE VERIFIED | UI-generated JSON read from read-only field; six sanitized receipts, physicalHardwareVerified:false, no raw session IDs, URLs, page text or native errors. Preserved in evidence JSON |

## Receipts versus observed effects

Native receipts retain `effectUnverified` for keyboard/media/pointer sends. External UI observations above supply narrower evidence; they do not turn receipts into playback-state acknowledgments. Accepted native dispatch times were **23, 24, 53, 119 and 115 ms** (n=5, median 53, maximum 119), excluding deliberate 600 ms GUI release delay. Spatial failure returned duration 0 and no query metrics: failure-path diagnostics do not measure actual UIA duration and must not be interpreted as a zero-cost scan.

Exported evidence: [s2-3-live-receipts.json](evidence/s2-3-live-receipts.json). It precedes final Home/restart tests; their evidence is observed UI/process identity, not invented receipts. No raw browser tree or account identifier is committed.

The additional Netflix pointer session was performed on the same unchanged EXE after restart. Its Confirm rejection, click acceptance, page scroll and cumulative position were directly observed, but its local receipt list was not exported before closing the managed target triggered the inherited Home transition and unmounted diagnostics. The six-receipt file is therefore not represented as evidence for those additional actions. No stale-target rejection is claimed from an attempted click after the panel had closed.

## Cleanup and acceptance

Candidate, all five test-created Edge windows and empty Paint window were closed normally. No installed candidate upgrade was run. Installed VELORA 0.9.2 retained SHA-256 **d702baf99b9e640c70d96ea0ed01306dac63482356826dfccdd7958ae1eee51f**. Session-only Home/simulator state was observed reset after restart. No data/profile deletion was used.

**Physical Hardware Verified: none.** USB/Bluetooth DS4 on the MSI, Steam Input coexistence, high DPI/secondary monitor/windowed service operation, real iPhone LAN, authenticated catalogs, protected playback and installer upgrade remain open. These are not converted to passes by green CI. Live spatial failure and incomplete catalog navigation prevent full five-service couch-usage acceptance.
