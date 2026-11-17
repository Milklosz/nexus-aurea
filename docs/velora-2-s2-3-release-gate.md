# S2.3 engineering release gate

Candidate: **0.11.0-rc.1**. Base source: `a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea`; branch `feature/velora-2-s2-3-native-tv-experience`. Preserve Draft status. No merge, stable release or replacement installation is authorized.

The final delivery evidence records exact source SHA, Draft PR, Windows/macOS/Playnite CI, candidate hashes and live results. Those identifiers must be checked against the actual artifacts rather than inferred from the rc.2 CI run.

| Gate | Engineering status before final candidate validation |
| --- | --- |
| A — Architecture | IMPLEMENTED: one existing bounded native worker and normalized dispatcher; independent existing Home mechanism |
| B — Profiles | IMPLEMENTED / AUTOMATED TESTED: five versioned conservative profiles; no full compatibility claim |
| C — Simulator | IMPLEMENTED / AUTOMATED TESTED; preflight UI and service launch observed; final live action validation pending |
| D — Ownership | IMPLEMENTED / AUTOMATED TESTED; live unrelated-window protection and recovery pending |
| E — Media | IMPLEMENTED / AUTOMATED TESTED routing; real player effects pending |
| F — Live | PARTIAL; see 20-scenario Computer Use report |
| G — Regression | Automated checks pass as recorded below; physical/iPhone/game acceptance remains open |
| H — Security | Source safeguards implemented; remaining OS races and provider limitations explicitly documented |
| I — Physical DS4 | BLOCKED until actual controller testing; never a stable-release pass |

Observed local evidence during integration:

- Baseline frontend: 946 tests / 105 files pass. Current frontend: 961 / 108 pass. TypeScript and production Vite build pass.
- Provenance and Claude status adapter: 37 tests pass (31 + 6).
- Isolated original-source Windows Rust baseline in sandbox: 397 pass, 32 fail, 2 ignored. Thirty-one failures concern sandbox Credential Manager access; one is the sandbox temporary linker path. These are preserved baseline results, not passed tests.
- Integrated Windows Rust outside sandbox: 442 pass, 0 fail, 2 ignored before the last pointer-coordinate test was added. An initial outside-sandbox attempt had one no-Git-metadata fixture failure because its temporary directory was inside the parent Git repository; using the normal external temporary root fixed it. Final completed-source local run: **443 pass, 0 fail, 2 ignored, 0 filtered**.
- Focused router tests: 16 pass after pointer bounds/DPI coverage. Five spatial geometry tests pass on the actual Windows compiler/test executable.
- The local Playnite build was attempted and is BLOCKED because no .NET SDK is installed; the existing Windows CI job is required.
- Only the Windows Rust target is installed locally. macOS results require exact-source CI.
- Touched Rust formatting and whitespace are checked. Whole-crate inherited formatting drift is not silently represented as a pass. Clippy all targets passes with inherited warnings; touched modules and whitespace pass formatting checks.

## Rollback

Exit the separate diagnostic candidate normally, close only test-created service windows normally, then launch the unchanged installed VELORA 0.9.2. The candidate shares the existing single-instance and data identity; do not run it beside the installation. No user-data deletion, profile replacement, package modification, driver, service or startup change is part of rollback.

The installed executable before testing has SHA-256 `d702baf99b9e640c70d96ea0ed01306dac63482356826dfccdd7958ae1eee51f`. Verify the same hash after validation. The NSIS packaging format follows the existing repository policy; an installer is delivered for review without executing it.
