# VELORA 3 Infinity checkpoint

## Verified baseline · 24 November 2026, Europe/Warsaw

- Integration branch `feat/velora-3-infinity` starts at `95da492d34f64ba37643dfb42386d80ce8050341`, the exact open [First Frame Recovery PR #76](https://github.com/Milklosz/nexus-aurea/pull/76) head. Its merge base with [Singularity PR #75](https://github.com/Milklosz/nexus-aurea/pull/75) is `e1e801e382d9d2658b4d3403b3f4464be7a98c28`. Recovery contributes commits `4e35dc3` and `95da492`.
- Isolated working copy on the MSI at `C:\Users\milos\velora-s1-1-sprint\work\velora-infinity`. The starting checkout was the older `codex/velora-2-s1-2-claude-usage` and had user files. The isolated copy was cloned directly from the verified recovery branch and avoids writes to the parent checkout and existing worktrees.
- Exact head and ancestry were checked with `git ls-remote origin refs/pull/76/head refs/pull/75/head refs/heads/feat/velora-3-singularity`, `gh pr view 76`, `git rev-parse HEAD`, `git merge-base HEAD e1e801e382d9d2658b4d3403b3f4464be7a98c28` and `git log --oneline e1e801e..HEAD`. Working-tree inventory was captured with `git status --short --branch` and `git worktree list --porcelain`.
- Independent baseline CI review confirmed [Windows, macOS and Playnite success](https://github.com/Milklosz/nexus-aurea/actions/runs/45422470326). Windows Rust reported 553 passing and 3 ignored. macOS reported 495 passing and 1 ignored. [Exact-head Windows portable CI](https://github.com/Milklosz/nexus-aurea/actions/runs/45422470238) passed for visible startup, React readiness, WebView2 isolation and orderly exit. The archived [baseline artifact](https://github.com/Milklosz/nexus-aurea/actions/runs/45422470238/artifacts/14935187557) was independently checked against GitHub's digest and the package manifest.
- Local baseline `node node_modules/vitest/vitest.mjs run --no-cache` reported 1,382 passing in 146 files. Each of the seven `scripts/*node-check.mjs` suites was run via `node --test` for 72 passing checks, including 81 Rust and TypeScript IPC names in parity and 13 documented rows.
- The [First Frame Recovery report](velora-3-first-frame-recovery.md) documents native creation before fullscreen setup, sanitized startup tracing and isolated CLI usage. The historical intermittent first-frame failure remains unexplained. The preserved MSI evidence identified a Home subtitle/empty-recents overlap, with Panasonic 4K, physical DS4, streaming, Steam/Playnite and real LAN journeys still pending.

## Active ownership at baseline

| Owner | Scope and files | Integration gate |
| --- | --- | --- |
| Startup specialist | Startup diagnostics, portable setup, single-instance guard, startup sections of `lib.rs` and portable isolation test | Bounded diagnostics, portable and installed identity separation, failure tests and exact-head smoke |
| Controller and streaming specialist | Native/gamepad hooks and streaming session coordination with focused regressions | Reconnect and focus rearming, rapid launch and missing receipt fields verified in deterministic tests |
| Security specialist | Independent baseline and candidate review, then bounded LAN hello and trust profile hardening in `remote_access.rs` | Preserve fresh credential verification, explicit approval and file isolation |
| Integration lead | Home, Gaming Hub, Control Center and CI evidence, candidate integration and reports | Focus tests, browser layout, full local and remote gates |

Resume in the isolated branch. Start with `git status --short --branch`, `git log --oneline -8` and `git diff --check`. Check [the repository's Actions](https://github.com/Milklosz/nexus-aurea/actions) against the exact candidate SHA before using any artifact. Use the acceptance matrix and physical handoff in the engineering report for pending work.

## Integrated development checkpoint · 24 November 2026, Europe/Warsaw

- First published checkpoint `c0d1ac0bb368a305009efbe52e12c36a200b1507` contains the startup and controller/streaming commits. [Draft PR #77](https://github.com/Milklosz/nexus-aurea/pull/77) targets the recovery branch directly. [Checkpoint CI](https://github.com/Milklosz/nexus-aurea/actions/runs/45429754581) and [checkpoint portable smoke](https://github.com/Milklosz/nexus-aurea/actions/runs/45429754380) passed for that earlier revision.
- Home, Control Center, Gaming Hub and the extended portable CI smoke were integrated in `ab67fc1`, `89b6ef9` and `7fc643b`. The integrated frontend passed 1,395 tests in 146 files and built successfully. The portable workflow's five PowerShell script blocks parsed successfully.
- The later LAN commit hardens hello accounting, start/stop state, and trust profile file handling. The integrated Windows portable-feature Rust run passed 561 tests with 3 ignored. The 73 Node checks and all 12 real-browser geometry fixtures passed. The full candidate and independent security findings are described in the [engineering report](velora-3-infinity-report.md).
- Resume by checking the exact head of Draft PR #77 and its matching CI jobs. The PR body records the exact final commit, job outcomes and portable hashes. Keep physical Panasonic, DS4, iPhone and service tests open until there is device evidence.
