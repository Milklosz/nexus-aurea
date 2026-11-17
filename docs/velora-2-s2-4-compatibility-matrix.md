# S2.4 streaming compatibility matrix

Initial matrix, 2026-11-17 (Europe/Warsaw), candidate **0.12.0-rc.1**. A short Computer Use pass was run against the isolated, uncommitted S2.4 debug candidate; its bounded results are recorded below. This file does not promote S2.3 observations to new acceptance. Retain the distinction between public surfaces, protected catalogs and player behavior.

Statuses: **VERIFIED / PARTIAL / FAILED / BLOCKED / UNSUPPORTED / NOT TESTED**. VERIFIED requires observed behavior in the stated scope. PARTIAL must identify completed substeps or a source-only implementation with missing runtime acceptance. UNSUPPORTED applies only to an intentionally absent route, not every possible way to operate the service.

Evidence keys:

- **R0** — no S2.4 runtime evidence yet; use the [validation protocol](velora-2-s2-4-validation-protocol.md) and update with a concrete Computer Use result/build SHA.
- **S1** — source inspection: five service profiles and semantic action/media allowlists in `src-tauri/src/tv_navigation.rs`; native dispatch/ownership in `src-tauri/src/streaming_control.rs`. This is implementation evidence only.
- **S2** — source/automated frontend evidence: bounded recording/replay, imports, checkpoints and diagnostic export described in [Simulator 2.0](velora-2-s2-4-controller-simulator.md). This does not establish service effects.
- **H0** — physical DS4 acceptance explicitly deferred; no physical controller result.

## Required capability matrix

Every service/capability cell below carries its own status/evidence key. The evidence column identifies the intended validating scenario, not an already completed test.

| Capability | Netflix | YouTube | Disney+ | Max | Prime Video | Evidence / acceptance scope |
| --- | --- | --- | --- | --- | --- | --- |
| Launch | PARTIAL · CU-WT-01 | PARTIAL · CU-WT-01 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-21/24–27; observe trusted VELORA launch and exact managed session. S1 exists. |
| Catalog navigation | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-21/24–27; identify public/authenticated scope. Public scrolling is insufficient. |
| Search | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-22/24–27; distinguish finding Search, text entry and result navigation. No arbitrary simulator text bridge. |
| Selection | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-21/24–27; reviewed semantic activation and observed target result. No payment/account actions. |
| Play/pause | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-23–27; observe player effect; distinguish native shortcut from exposed-control route. |
| Seek | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-23–27; observe timeline change on allowed content; no ad bypass. |
| Scroll | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-24–30; observe intended owned surface/container scrolling. |
| Back | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-21/23–27/30; document browser history versus service modal Back. |
| Fullscreen | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-23–27/31; observe player geometry and safe exit, not only F dispatch. |
| Home | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-31; completed existing Home worker, native readiness and visible usable VELORA. |
| Switching | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-32; exact source/destination sessions and Home readiness before recapture. |
| Keyboard mode | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-30; observe focus/action effect; S1 alone is insufficient. |
| Spatial mode | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-TV-29; bounded UIA diagnostics plus visible focus/effect; safe failure is not navigation success. |
| Pointer mode | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | CU-4K-03/04, CU-TV-28; movement, bounds and actual click/hit testing. |
| Simulator validation | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 | Workflows A–I, CU-TV-39/40; exact semantic steps and declared interventions. S2 exists. |
| Physical DS4 validation | BLOCKED · H0 | BLOCKED · H0 | BLOCKED · H0 | BLOCKED · H0 | BLOCKED · H0 | Workflow J; physical acceptance intentionally deferred. Simulated PS/Home is insufficient. |

## Source-only implementation inventory

All rows below are **PARTIAL · S1/S2 (source/automated route only; runtime pending)**. They describe available candidate mechanisms, not service compatibility.

| Service | Candidate route / profile ID | Native player shortcut boundary | Remaining acceptance |
| --- | --- | --- | --- |
| Netflix | `netflix`, profile version 1; keyboard/spatial/pointer and automatic hybrid | Explicitly armed allowlisted player commands; editable-focus/session guard | Profile selection, protected catalog/search/title/player effects and TV geometry require real available session. |
| YouTube | `youtube`, profile version 1; keyboard/spatial/pointer and automatic hybrid | Explicitly armed player controls; no ad bypass | Reproduce prior no-eligible-control case with diagnostics; verify useful fallback, real selection/search/playback/Home. |
| Disney+ | `disney`, profile version 1; keyboard/spatial/pointer and automatic hybrid | Generic service-specific media shortcuts **UNSUPPORTED · S1**; exposed UI control paths remain NOT TESTED | Protected catalog and actual exposed player controls require legitimate available session. |
| Max | `max`, profile version 1; keyboard/spatial/pointer and automatic hybrid | Generic service-specific media shortcuts **UNSUPPORTED · S1**; exposed UI control paths remain NOT TESTED | Modal/dynamic catalog behavior and actual player controls need runtime evidence. |
| Prime Video | `prime`, profile version 1; keyboard/spatial/pointer and automatic hybrid | Explicitly armed allowlisted player commands | Safe catalog/search and already entitled player need evidence; buy/rent/subscribe/account actions excluded. |

Authentication availability must be inspected, never assumed. If absent, update protected substeps to BLOCKED with the actual observed reason while retaining public-surface subresults separately. A simulator command acceptance, unit test, visible Search button or marketing-page scroll cannot establish catalog/search/player compatibility.

Source limitation: Home closes diagnostics and ends the current replay segment. Bounded sanitized process memory retains recording/receipts/remaining steps; native Home readiness and an explicit local Resume are required after reopening. There is no background input runner. Automatic multi-service simulator workflows remain **PARTIAL · S2** even if their separately resumed segments later gain runtime evidence.

Use a cell update such as `PARTIAL · CU-TV-24 · <build SHA> · public scroll only; protected catalog BLOCKED` rather than replacing a broad capability with VERIFIED after one isolated action. Actual results must identify SOURCE, AUTOMATED, COMPUTER USE or PHYSICAL HARDWARE as appropriate.

## Computer Use sample — 2026-11-17

`CU-WT-01` is a debug candidate built from the dirty S2.4 working tree above
base `740f5964df4e2dc843f436b0e5e7a61af9cafc13`, launched with an isolated
Tauri identifier and data directory. It was displayed fullscreen on the active
Panasonic-TV screen. The public YouTube page was observed after the simulator
opened YouTube. The public Netflix landing page was then observed after the
simulator opened Netflix; its cookie banner was left untouched. No service login,
search, protected title or playback was attempted. Native Home after either
service, visible Home readiness, target switching, directional-effect
observation and pointer hit-testing remain NOT TESTED. The user stopped
Computer Use with Escape before further interaction. Do not treat the two
public-page launches as service compatibility.

| Capability | Netflix | YouTube | Disney+ | Max | Prime Video |
| --- | --- | --- | --- | --- | --- |
| Public launch page | PARTIAL · CU-WT-01 | PARTIAL · CU-WT-01 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 |
| Protected catalog / entitled playback | BLOCKED · no authenticated session used | BLOCKED · no authenticated session used | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 |
| Navigation effect / Home / switching | NOT TESTED · CU-WT-01 | NOT TESTED · CU-WT-01 | NOT TESTED · R0 | NOT TESTED · R0 | NOT TESTED · R0 |
