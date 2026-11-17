# S2.3 compatibility matrix

This matrix separates adapter implementation from observed service behavior. **I** = IMPLEMENTED adapter; **A** = AUTOMATED TESTED routing; **CU** = COMPUTER USE VERIFIED on a real candidate; **HW** = PHYSICAL HARDWARE VERIFIED. PARTIAL means a route exists without complete workflow acceptance. BLOCKED identifies an actual external gate, UNSUPPORTED an intentionally absent mapping, and NOT TESTED a missing observation. No HW pass is claimed.

The following conservative matrix records the preflight boundary. Candidate-specific updates follow in delivery evidence and the Computer Use report.

| Service | Open | Catalog | Select content | Search | Play/pause | Seek | Back | Scroll | Fullscreen | Home | Switch | Pointer | Spatial | Physical DS4 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Netflix | I; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | BLOCKED |
| YouTube | CU preflight launch | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | BLOCKED |
| Disney+ | I; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL: explicit controls; shortcut UNSUPPORTED | Shortcut UNSUPPORTED | I/A; NOT TESTED | I/A; NOT TESTED | PARTIAL: explicit controls; shortcut UNSUPPORTED | I/A; NOT TESTED | I; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | BLOCKED |
| Max | I; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL: explicit controls; shortcut UNSUPPORTED | Shortcut UNSUPPORTED | I/A; NOT TESTED | I/A; NOT TESTED | PARTIAL: explicit controls; shortcut UNSUPPORTED | I/A; NOT TESTED | I; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | BLOCKED |
| Prime Video | I; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | PARTIAL; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | I; NOT TESTED | I/A; NOT TESTED | I/A; NOT TESTED | BLOCKED |

Catalog/search/title selection are not declared implemented end-to-end merely because keyboard, UIA and pointer primitives exist. Text entry into external search/login fields has no new native credential/text bridge. User-authenticated protected catalogs may remain BLOCKED if no legitimate session is available. Payment, rental, subscription and account changes are restricted test targets.
