# VELORA 3.0 — Operation Genesis — Changelog (S3.1–S3.5)

- Branch: `feat/velora-3-genesis` (tip `a83f148`)
- Base: verified Ascension tip `ded73f4` = `origin/feat/velora-3-ascension` (Draft PR #73)
- Scope: 11 commits, 61 files, +8399 / −66 (`git diff ded73f4..HEAD`)
- All Ascension functionality preserved (77 base Tauri handlers intact; remote security code byte-identical).

## S3.1 — Intelligent Living Room Home (Agent A, `genesis-a-home` → `bafedfc`)
- Context-aware Home sections row on Living Room Home: **"Ostatnio używane"** (MRU, deduped, cap 8) from the read-only local recents store, and **"Kontynuuj"** only when session state is actually known (`getSessionState`/`listenForSessionChange` + launch events). No playback progress is ever fabricated (`PLAYBACK_STATE_READ_SUPPORTED` stays false).
- New `src/services/homeSections.ts` + `src/components/living-room/HomeSections.tsx`; wired inside `LivingRoomHome.tsx` (App.tsx untouched).
- Reliable **focus memory**: last-focused dock index and section-tile index persisted (`velora.home.focus.*`) and restored on Home mount.
- New `"sections"` home zone (between music and dock) so up/down reaches the row; left/right + confirm work via the existing `homeActions` path.
- **4K readability**: `clamp()`-based fluid type/spacing tokens in `tokens.css`/`livingRoom.css` (Cinema Minimal, reduced-motion aware).
- Graceful **empty / loading / error** states for the sections row.
- Tests: `genesisAHomeSections.test.tsx` (30 tests).

## S3.2 — Gaming Hub 3.0 (Agent B, `genesis-b-gaming` → `2565362`)
- **Read-only Steam library** (`src-tauri/src/steam_library.rs`): SteamPath via HKCU `KEY_READ` (added `Win32_System_Registry` feature to the existing `windows` crate — no new crates), `libraryfolders.vdf` + `appmanifest_*.acf` VDF parsing. New commands `get_steam_library`, `launch_steam_game` (canonical `steam://run/<appid>` only), `get_game_process_state` (observation-only).
- Steam games merged into `AppManagerSnapshot.games` as `steam:<appid>` (launcher "steam") alongside Playnite `playnite:<guid>`.
- GamingHub grid shows Steam games with a launcher badge (no fabricated covers), routes launch by id, shows truthful exit/crash notice + **"Wróć do Home"** via `returnVeloraHome`. Never kills a game process; no DRM/save/anti-cheat access.
- Tests: `genesisBSteamLibrary.test.ts` (11), `genesisBGamingHub.test.tsx` (9), +9 Rust unit tests.

## S3.3 — Control Center 4.0 (Agent C, `genesis-c-control` → `a4a3221`)
- **System overview card** at the top of Control Center: read-only aggregation of display info, audio output/volume, controller connection, active session, network/remote — each item explicit loading/ready/unknown, never fabricated.
- **Confirm-gated recovery actions**: reusable `data-velora-confirm` + `useConfirmGate()` + `ConfirmDialog` (`role="alertdialog"`); `canRemoteSelect` denies gated controls everywhere (fail-closed — the remote cannot trigger risky actions via generic click). Gated: revoke devices, stop remote, remote trust recovery, reset Edge Cinema, restart/exit VELORA, restore desktop.
- **Diagnostics summary** (`summarizeDiagnostics`) in SystemDiagnosticsPanel.
- **Accessibility**: labelled regions, `aria-live`, verified tablist/arrow-key model.
- Tests: `genesisC{ConfirmGate,SystemOverview,Accessibility,DiagnosticsSummary}.test.tsx` (28 tests).

## S3.4 — Reliability & Performance (Agent D, `genesis-d-reliability` → `56c798b`)
- **Measure-first instrumentation** (`perfMetrics.ts`): startup latency, time-to-first-render, per-command `invoke()` latency histogram (p50/p95/max, bounded ring), dev-only render counter. No polling; snapshot only. No speculative claims.
- **Bounded retry** (`retryPolicy.ts`): exponential backoff + jitter, configurable max, ambiguous/unknown failures never retried; wired into `remoteReliability.ts` without changing its fail-closed ≤3-never-reached semantics.
- **Focus / HDMI reconnect hardening**: `DisplayTopologyFocusRecovery` re-runs focus restore exactly once per display signature (bounded, cooldown); `ExactlyOnceRecoveryGate`; `focusWindowSafelyBounded`.
- **Clean shutdown**: interruptible sliced sleeps + bounded 2 s join in `session_monitor`/`window_broker` so monitors never hang Exit.
- **WebView2 memory watch** (`memory_watch.rs`): 60 s read-only working-set sample, documented 1 GiB threshold → truthful `velora-memory-notice` (no GC API faked). New `get_memory_watch_status` command.
- Bounded **error bus** (`errorBus.ts`, 64-entry ring, nothing swallowed).
- Tests: `genesisD{RetryPolicy,PerfMetrics,FocusRecovery,ErrorBus,Soak}.test.ts` (43) + 9 Rust tests.

## S3.5 — Quality, Security & Release Engineering (Agent E, `genesis-e-ci` → `7de2fae`)
- **Deterministic integration guard** (`genesisEIntegration.test.ts`, 17 tests): IPC contract ↔ `lib.rs` handler consistency both directions, base 77-command set never shrinks, CRLF-normalized source-text guards for fail-closed remote + window-ownership invariants.
- **LAN security guards** (`genesisELanSecurity.test.ts`, 13), **controller simulation** (`genesisEControllerSim.test.ts`, 13), **session soak** (`genesisESoak.test.ts`, 6 — 5000/4000/3000 seeded steps), **UI regression** (`genesisEUiRegression.test.tsx`, 6).
- **Portable isolation verification** (`scripts/portable-isolation-node-check.mjs`, 6 tests, `pnpm test:portable-isolation`) + **CI wiring proof** (`scripts/genesis-ci-node-check.mjs`, 5 tests, `pnpm test:genesis-ci`).
- CI: `ci.yml` + `portable-windows.yml` additively run `test:genesis`, `test:genesis-soak`, `test:portable-isolation`, `test:genesis-ci` on **both** macos-latest and windows-latest; CRLF preserved; no existing step removed.
- Contracts: 4 new genesis commands promoted into `IPC_COMMANDS` at integration.
- Docs: `velora-3-genesis-plan.md`, `velora-3-genesis-installer-upgrade-rollback.md` (test plan only — nothing installed).

## Integration
- Five disjoint branches merged sequentially into `feat/velora-3-genesis` (A→C→E→B→D), zero conflicts; only shared hot files (`lib.rs`, `Cargo.toml`, `contracts/ipc.ts`) were touched additively and resolved at integration (commit `a83f148`).
