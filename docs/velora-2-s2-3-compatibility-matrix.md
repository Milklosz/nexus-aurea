# S2.3 compatibility matrix

Evidence: Windows Computer Use, 2026-11-17, clean debug source **cc24affd970b3f4fb478f58f1dceb218708f7753**. **I/A** = IMPLEMENTED adapter / AUTOMATED TESTED route, **CU** = actual Computer Use observation, **BLOCKED** = external dependency, **NOT TESTED** = missing live observation, **UNSUPPORTED** = intentionally absent shortcut. No Physical Hardware Verified result exists.

| Service | Open | Catalog / profile / title | Search | Play/pause | Seek | Back / scroll | Fullscreen | Home / switch | Pointer | Spatial | Physical DS4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Netflix | CU public page | BLOCKED account | BLOCKED account | I/A; BLOCKED account | I/A; BLOCKED account | Scroll CU public page; Back NOT TESTED | I/A; BLOCKED account | Local simulator Home / automatic shell recovery on close CU; switching partial | CU move/persistence; empty-area click accepted; click-before-move rejected | I/A; NOT TESTED here | BLOCKED |
| YouTube | CU desktop | PARTIAL; public result/title selected by CUA, not simulator | CU keyboard setup only; controller text bridge absent | CU preroll toggle; main content NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | CU preroll player | Local Home CU; same-window resume CU; full controller workflow partial | CU one bounded move; click/scroll NOT TESTED | LIVE FAILURE: no eligible control within budget; explicit fallback | BLOCKED |
| Disney+ | CU public page | BLOCKED account | BLOCKED account | Shortcut UNSUPPORTED; exposed controls NOT TESTED | Shortcut UNSUPPORTED | I/A; NOT TESTED | Shortcut UNSUPPORTED; controls NOT TESTED | I/A; tile launch CU only | I/A; NOT TESTED here | I/A; NOT TESTED here | BLOCKED |
| Max | CU public page | BLOCKED account / browser modal | BLOCKED | Shortcut UNSUPPORTED; controls NOT TESTED | Shortcut UNSUPPORTED | I/A; NOT TESTED | Shortcut UNSUPPORTED; controls NOT TESTED | I/A; tile launch CU only | I/A; NOT TESTED here | I/A; NOT TESTED here | BLOCKED |
| Prime Video | CU public page | BLOCKED account / membership | Public search control observed; action NOT TESTED | I/A; BLOCKED account | I/A; BLOCKED account | I/A; NOT TESTED | I/A; BLOCKED account | I/A; tile launch CU only | I/A; NOT TESTED here | I/A; NOT TESTED here | BLOCKED |

Five versioned profiles and shared primitives exist. Catalog/search/title navigation is not declared fully implemented or verified merely because keyboard, pointer and UIA routes exist. There is no external text/credential bridge or television-specific browser replacement. Automatic mode uses a stable conservative keyboard strategy; it has no proven per-page adaptive capability detection.

See [actual scenarios](velora-2-s2-3-computer-use-results.md) and [release gates](velora-2-s2-3-release-gate.md). Authenticated service acceptance, successful spatial focus on web controls and physical DS4 acceptance remain required before claiming universal couch operation.
