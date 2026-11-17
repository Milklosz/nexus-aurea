# S2.3 engineering release gate

Candidate: **0.11.0-rc.1**. Base source: `a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea`; branch `feature/velora-2-s2-3-native-tv-experience`. Preserve Draft status. No merge, stable release or replacement installation is authorized.

Final implementation source: **cc24affd970b3f4fb478f58f1dceb218708f7753**. [Draft PR #62](https://github.com/Milklosz/nexus-aurea/pull/62) targets the unchanged a7c53b3 integration branch. [CI run 44054094533](https://github.com/Milklosz/nexus-aurea/actions/runs/44054094533) passed Windows, macOS and Playnite; release publication was skipped. PR checkout was synthetic merge 7cf56b3a54133c5795b414af8cb7d68660c73a98; manifest identifies cc24aff as source/head and a7c53b3 as base. Later evidence-only commits do not change the tested application source.

| Gate | Final engineering evidence / remaining acceptance |
| --- | --- |
| A — Architecture | IMPLEMENTED: one existing bounded native worker and normalized dispatcher; independent existing Home mechanism |
| B — Profiles | IMPLEMENTED / AUTOMATED TESTED: five versioned conservative profiles; no full compatibility claim |
| C — Simulator | IMPLEMENTED / AUTOMATED TESTED / COMPUTER USE VERIFIED native dispatch, mode/session selection, export and Home; full physical equivalence not claimed |
| D — Ownership | IMPLEMENTED / AUTOMATED TESTED; CU exact owned recovery and frontend unrelated-focus rejection; native race/UIPI live stress incomplete |
| E — Media | PARTIAL: YouTube preroll pause/resume and fullscreen CU verified; protected playback/seek/five-service effects not accepted |
| F — Live | PARTIAL: five public launches, narrow verified interactions; YouTube spatial attempt failed safely; full couch workflows remain open |
| G — Regression | Windows/macOS/Playnite CI green; narrow local live checks; physical/iPhone/game acceptance remains open |
| H — Security | Reviewed safeguards and automated tests; no critical finding identified in changed scope; residual OS/provider races documented; not external certification |
| I — Physical DS4 | BLOCKED until actual controller testing; never a stable-release pass |

Observed local evidence during integration:

- Baseline frontend: 946 tests / 105 files pass. Current frontend: 961 / 108 pass. TypeScript and production Vite build pass.
- Provenance and Claude status adapter: 37 tests pass (31 + 6).
- Isolated original-source Windows Rust baseline in sandbox: 397 pass, 32 fail, 2 ignored. Thirty-one failures concern sandbox Credential Manager access; one is the sandbox temporary linker path. These are preserved baseline results, not passed tests.
- Integrated Windows Rust outside sandbox: 442 pass, 0 fail, 2 ignored before the last pointer-coordinate test was added. An initial outside-sandbox attempt had one no-Git-metadata fixture failure because its temporary directory was inside the parent Git repository; using the normal external temporary root fixed it. Final completed-source local run: **443 pass, 0 fail, 2 ignored, 0 filtered**.
- Focused router tests: 16 pass after pointer bounds/DPI coverage. Five spatial geometry tests pass on the actual Windows compiler/test executable.
- Local Playnite build was BLOCKED by missing .NET SDK; exact-source Windows CI Playnite build subsequently passed.
- Only the Windows Rust target is installed locally; exact-source macOS CI tests/check/build subsequently passed.
- Touched Rust formatting and whitespace are checked. Whole-crate inherited formatting drift is not silently represented as a pass. Clippy all targets passes with inherited warnings; touched modules and whitespace pass formatting checks.

## Artifacts

Downloaded CI installer: `outputs/s2-3-ci-windows/VELORA_0.11.0-rc.1_x64-setup.exe`, 4,584,876 bytes, SHA-256 **27f138faaa3ba2d9b155c6d0a3941a41f8979617a97d7db7c28578636ea60012**. Its adjacent `velora-build-provenance.json` identifies exact source/checkout, tools and payload relation. Local `verify-release --preview` passed internal consistency; CI origin is not independently attested by a local verifier. Authenticode reports unsigned. CI artifact ID 14314773093, ZIP digest 6af2329db5193acf6042a87d16fe6b04c329e1268f25a848731c9eb24f906536 (available until 2026-12-17).

Clean local debug: `outputs/s2-3-cc24aff/nexus-aurea.exe`, 27,858,944 bytes, SHA-256 **0024ea2708ad7149e1b1be19b09d413b82c365e1ce88a72a5992f34f83274ba9**. Integrity manifest records sourceDirty:false, hardwareAccepted:false and no signature. Partial CU does not set a blanket compatibility acceptance flag. Installer was never run. Build hashes are integrity records, not digital signatures.

## Rollback procedure

Exit the separate diagnostic candidate normally, close only test-created service windows normally, then launch the unchanged installed VELORA 0.9.2. The candidate shares the existing single-instance and data identity; do not run it beside the installation. No user-data deletion, profile replacement, package modification, driver, service or startup change is part of rollback.

The installed executable before testing has SHA-256 `d702baf99b9e640c70d96ea0ed01306dac63482356826dfccdd7958ae1eee51f`. Verify the same hash after validation. The NSIS packaging format follows the existing repository policy; an installer is delivered for review without executing it.
