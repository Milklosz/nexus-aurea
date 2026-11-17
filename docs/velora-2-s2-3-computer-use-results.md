# S2.3 Computer Use results

Actual Windows access is available through the bundled `@oai/sky` Computer Use API. No physical controller is connected or required for this validation. These results distinguish preliminary dirty-tree preflight observations from final committed-candidate acceptance.

Preflight on 2026-11-17: launched a separate debug EXE, observed one VELORA window, version 0.11.0-rc.1, 24-hour clock, weather, Claude Usage stale indicator, native controller status with zero pads, Control Center, session-only Home enable and the development simulator. The preflight embeds base SHA `a7c53b3` with a dirty source tree; it is not the final source artifact. The simulator opened an owned desktop YouTube window. Cookie rejection used ordinary Computer Use, not the simulator. No credentials or account settings were touched.

The preflight found practical native-select difficulties; explicit mode/session buttons were added. Source review also corrected simulated pointer position persistence, because clicking a GUI simulator button moves the real mouse. These fixes require a rebuilt candidate; earlier UI observations do not verify the fixed code.

| Scenario | Status before final rebuilt validation | Evidence / boundary |
| --- | --- | --- |
| CU-TV-01 startup | PARTIAL | Preflight version and UI observed; clean committed source still required |
| CU-TV-02 YouTube navigation | PARTIAL | Managed desktop site launched; simulator actions pending |
| CU-TV-03 YouTube playback | NOT TESTED | No playback claim from launch |
| CU-TV-04 Netflix | NOT TESTED | Authentication may restrict catalog |
| CU-TV-05 Disney+ | NOT TESTED | No account traversal |
| CU-TV-06 Max | NOT TESTED | No catalog claim |
| CU-TV-07 Prime Video | NOT TESTED | No purchases/rentals/subscriptions tested |
| CU-TV-08 pointer | NOT TESTED | Preflight revealed simulator position issue; corrected source needs validation |
| CU-TV-09 spatial | NOT TESTED | Windows compilation/geometry tests are not live provider verification |
| CU-TV-10 keyboard | NOT TESTED | Router tests alone do not prove page response |
| CU-TV-11 switching | NOT TESTED | No full Netflix → Home → YouTube sequence yet |
| CU-TV-12 focus recovery | NOT TESTED | Exact owned recovery implemented; live check pending |
| CU-TV-13 fullscreen | NOT TESTED | VELORA fullscreen startup observed; service fullscreen not yet verified |
| CU-TV-14 media | NOT TESTED | Explicit arm and typed receipts implemented |
| CU-TV-15 deduplication | NOT TESTED | Automated debounce/one-dispatch checks pass; live result pending |
| CU-TV-16 unrelated window | NOT TESTED | Source guard is not a live negative test |
| CU-TV-17 restart | NOT TESTED | Existing rc.2 evidence is not a candidate-specific pass |
| CU-TV-18 regression | PARTIAL | Home, weather, clock, Claude stale display and Control Center observed |
| CU-TV-19 failure recovery | NOT TESTED | No forced stale HWND/focus-denial live result yet |
| CU-TV-20 export | NOT TESTED | Sanitized UI export implemented and unit-tested |

Final observations, exact build identity and remaining blockers are added as separate delivery evidence. A service is never classified as fully controller compatible from one successful screen. Physical USB/Bluetooth DS4, iPhone LAN, secondary monitor/high-DPI and protected playback remain separate acceptance items.
