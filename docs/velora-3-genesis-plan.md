# VELORA 3.0 Genesis — delivery plan & test matrix (S3.1–S3.5)

- Base: `ded73f4` = `feat/velora-3-genesis` tip (Ascension integrated). This doc covers the **genesis** workstreams S3.1–S3.5 on top of it.
- S3.5 (this branch, `genesis-e-ci`, Agent E — CI/QA/security/release) adds **no runtime behavior change**: tests, CI wiring, scripts, contracts forward-looking notes and docs only. No Rust source changes, no new dependencies, no edits to A/B/C/D-owned files.

## 1. Workstream summary

| Workstream | Owner | Content (integrated by the lead, in order) |
| --- | --- | --- |
| S3.1 | A | Controller-first input hardening on the genesis base (cross-source gate wiring, DS4/DS reconnect, focus-owner recovery) |
| S3.2 | B | Session intelligence: Steam library read-only view, `launch_steam_game`, `get_game_process_state` (observation-only), duplicate-launch prevention |
| S3.3 | C | iPhone Remote 4.x control commands (LAN, signed, fail-closed) |
| S3.4 | D | Windows reliability additions (autostart recovery, foreground-restore truthfulness) |
| S3.5 | E (this branch) | Deterministic integration guards, controller-sim coverage, session soak, UI regression smoke, LAN security source-text guards, portable isolation verification, CI/provenance wiring, installer upgrade/rollback **test plan** (doc only) |

Because S3.5 merges LAST, new IPC commands from S3.1–S3.4 are documented in `src/contracts/ipc.ts` under `FORWARD_LOOKING_IPC_COMMANDS` and moved into `IPC_COMMANDS` at integration once their handlers exist in `src-tauri/src/lib.rs`.

## 2. Test matrix added by S3.5 (all on `genesis-e-ci`)

| Suite | File | Kind | Count |
| --- | --- | --- | --- |
| Integration guard | `src/__tests__/genesisEIntegration.test.ts` | vitest — IPC contract ↔ `generate_handler!` consistency (base set at `ded73f4` never shrinks; every documented command registered; new handlers must be documented) + source-text fail-closed remote & window-ownership invariants (CRLF-normalized) | 17 |
| Controller simulation | `src/__tests__/genesisEControllerSim.test.ts` | vitest — holds, analog dead-zone, export/parse round-trip, review gate, memory/home-boundary lifecycle | 13 |
| Session soak | `src/__tests__/genesisESoak.test.ts` | vitest — 5000 coordinator steps + 4000 raw lifecycle events per machine + 3000 browser transitions: bounded receipts, monotonic seq, no duplicate launches, revision bumps exactly once | 6 |
| UI regression | `src/__tests__/genesisEUiRegression.test.tsx` | vitest + testing-library/jsdom — ControlCenter, LivingRoomHome, GamingHub, PlayniteLibrary landmarks | 6 |
| LAN security guards | `src/__tests__/genesisELanSecurity.test.ts` | vitest source-text — rustls + `trust_confirmed` gate, HMAC prefix, persist-before-emit replay, 11-route allowlist, 4096 limit, CSP, fail-closed lock/vault | 13 |
| Portable isolation | `scripts/portable-isolation-node-check.mjs` (`pnpm test:portable-isolation`) | node --test source-text — `VELORA_PORTABLE_DATA_DIR`, `AppDirectoriesOverride::Root` (incl. WebView2 user data), disjoint identity, no registry/installer in portable scripts | 6 |
| CI wiring guards | `scripts/genesis-ci-node-check.mjs` (`pnpm test:genesis-ci`) | node --test — ci.yml runs every suite on both OSes; portable-windows.yml intact | 5 |

Total new tests: **66** (55 vitest + 11 node --test).

## 3. CI wiring

- `.github/workflows/ci.yml` (matrix `macos-latest` + `windows-latest`, unchanged): new steps `pnpm test:genesis`, `pnpm test:genesis-soak`, `pnpm test:portable-isolation`, `pnpm test:genesis-ci`. All existing steps kept (pnpm test, test:soak, claude-usage, provenance, portable-manifest, manifest, cargo test, build, sha256 manifest write+verify, diff --check, per-OS cargo check, NSIS build).
- `.github/workflows/portable-windows.yml`: adds `pnpm test:portable-isolation` and `pnpm test:genesis-ci`; still builds strictly `--no-bundle`.
- `package.json`: additive scripts only — `test:genesis`, `test:genesis-soak`, `test:portable-isolation`, `test:genesis-ci`.

## 4. Safety invariants pinned by the new guards

No global input hooks · no process killing (observation-only; `PROCESS_QUERY_LIMITED_INFORMATION` only) · `PLAYBACK_STATE_READ_SUPPORTED = false` · TLS rustls + `trust_confirmed` + 4096-byte limit + HMAC `NEXUS-AUREA-REMOTE-V1` + persist-before-emit replay + exact 11-route LAN allowlist + unchanged CSP · window ownership limited to VELORA's own main window with truthful `unknown` foreground denials · portable data-root isolation with disjoint credential/mutex/title identity · no installer/registry writes in the portable path.

## 5. Known limitations

- All guards are static/source-text or jsdom-level; physical hardware gates remain NOT TESTED until the Luna procedure runs on the MSI with the portable candidate.
- The installer upgrade/rollback plan (`docs/velora-3-genesis-installer-upgrade-rollback.md`) is a **plan only** — nothing was installed or executed.
- Forward-looking IPC entries are documentation-only until the S3.1–S3.4 handlers land at integration.
