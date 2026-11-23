# VELORA 3.0 — Operation Ascension: Phase 0 reconnaissance report

- Branch: `feat/velora-3-ascension`
- Base commit: `4a431768f85d4ba81161b331ebcce93b4684dd2e` (`origin/feat/s2-9-hardware-recovery`, Draft PR #72)
- Date: 2026-11-18 · Environment: macOS (engineering), target hardware MSI GP76 Leopard 11UG / Windows 11 / Panasonic TX-49EX610E 4K / DS4 BT / iPhone LAN remote
- Status: **Draft engineering branch. No merge to `main`, no release, no installer run, no hardware claims.**

## 1. Repository lineage (verified via `git merge-base` / `gh pr list`)

```
main 433a24a (2026-11-11, PR #5)
 └─ 7f1b765 fix: preserve Cargo.lock contents in v0.5 branch
     └─ integration/velora-2.0 9d16008 (2026-11-13, PRs #34–#42 merged)
         └─ integration/velora-2-s2-3-s2-4 7878b83 (2026-11-17, PR #64)
             └─ feat/hy4-s2-5 446ad37 (S2.5–S2.8 candidate, PR #65 + slices #66–#70)
                 └─ feat/portable-validation-build d50ed79 (PR #71, portable no-install validation)
                     └─ feat/s2-9-hardware-recovery 4a43176 (PR #72, S2.9 MSI root-cause fixes)  ← ASCENSION BASE
```

Parallel v1 line (superseded by the 2.0 line, kept for reference): `feat/velora-night-build-2` (PR #13) → `feat/velora-v1-experience` (PR #15, `efa45d8`) → `feat/velora-v1-ecosystem` (PR #18, `28267a1`). DeepSeek-owned areas (`fix/velora-deepseek-p1` PR #14, `feat/velora-v1-core` PR #16) were integrated into the 2.0 line as `session_orchestrator.rs`, `window_broker.rs`, `ds4.rs`, `pad_hub.rs`.

Open Draft PRs: #51–#72 (all `isDraft: true`, stacked 2.0 line). No open issues. PR #71 = portable Windows validation build (workflow `portable-windows.yml`, no-install, provenance manifest naming the exact pushed commit). PR #72 CI (`gh pr checks 72`, historical evidence for the **base** branch only, not for ascension): macOS + Windows + Playnite net462 + portable candidate all **pass**; release jobs skipping (no tag).

Mission-text cross-check: "PR #71 portable build and isolation" and "S2.5–S2.8" confirmed as real (#71, #65–#70). Hardware validation evidence lives in `docs/evidence/*` and `docs/velora-2-s2-4-hardware-cim.json` etc.; the S2.9 "Luna handoff" (`docs/velora-2-s2-9-luna-test-procedure.md`) lists physical gates still **NOT TESTED**.

## 2. Baseline verification on the ascension base (local, macOS)

| Check | Result |
| --- | --- |
| `pnpm test` (vitest) | **112 files / 1046 tests PASS** |
| `pnpm test:soak` | 3 PASS (3000-transition CrossSourceGate soak) |
| `pnpm test:provenance` / `test:portable-manifest` / `test:claude-usage` | PASS (node --test suites) |
| `pnpm build` (tsc -b + vite build) | PASS |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | **432 passed / 0 failed / 1 ignored** (macOS; Windows-only modules cfg'd out — PR #72 reports 491 on Windows) |
| Authoritative Windows MSVC check + NSIS + portable build | CI on PR #72, windows-latest — **pass** (not reproducible locally on macOS: `aws-lc-sys` needs Windows SDK headers) |

## 3. Architecture map

```
┌─ React 19 + TS UI (src/, 233 files) ─────────────────────────────────────┐
│  components/living-room/  LivingRoomHome, LivingDock, TopBar, SceneLayer │
│  components/               ControlCenter, SessionsPanel, GamingHub,      │
│                            GamepadDiagnostics, ControllerSimulator, …    │
│  hooks/                    useGamepad, useNativeController, useNavigation│
│  services/ (60 modules)    sessionOrchestrator, veloraSessionManager,    │
│                            edgeCinema(Lifecycle), controllerInput,       │
│                            crossSourceGate, remoteAccess/Command/…       │
│  contracts/                typed domain/session/actions/events/ipc      │
└─────────────── Tauri 2 IPC (116 commands in src-tauri/src/lib.rs) ───────┘
┌─ Rust backend (src-tauri/src, 39 modules / 39 041 LOC) ──────────────────┐
│  input:      ds4.rs, pad_hub.rs, gamepad_home.rs, controller_supervisor.rs│
│  sessions:   session_orchestrator.rs, velora_session_manager.rs,         │
│              session_monitor.rs, session_store.rs, window_broker.rs,     │
│              launch_registry.rs, operation_registry.rs                   │
│  streaming:  edge_cinema.rs, streaming_control.rs, tv_navigation.rs      │
│  remote:     remote_access.rs, remote_reliability.rs, remote_state_lock.rs│
│              credential_store.rs                                          │
│  platform:   app_manager.rs, platform_launchers.rs, playnite_library.rs,  │
│              playnite_manifest.rs, control_service.rs, music_service.rs,  │
│              audio_control.rs, display_audio.rs, tv_mode.rs               │
│  reliability: portable.rs, single_instance.rs, autostart.rs, diagnostics.rs│
│              build_support.rs, process_table.rs, spatial_navigation.rs,   │
│              lifecycle_control.rs, pointer_indicator.rs                   │
└───────────────────────────────────────────────────────────────────────────┘
   Windows-only deps (cfg(windows)): axum/axum-server/rustls (LAN remote),
   windows crate, keyring, rcgen. Frontend deps: react, @tauri-apps/api,
   plugin-opener only. No new deps added since v1.
```

Dependency graph (key edges): UI services → `contracts/*` (typed) → Tauri `invoke` → Rust modules; `remote_access.rs` ↔ `public/remote/` PWA (HMAC-SHA256 `NEXUS-AUREA-REMOTE-V1` payload, monotonic `sequence` replay guard, TLS rustls, Host/Origin exact match, per-device keyring credentials); `portable.rs` redirects all writable state to `<VELORA-Portable-Data>` for the no-install candidate; `build_support.rs` embeds commit SHA into builds; `scripts/*.mjs` generate provenance/portable manifests.

## 4. Risk register (from S2.9 RCA, security reviews, release gate — not re-verified on hardware)

| # | Risk | Severity | State |
| --- | --- | --- | --- |
| R1 | Physical DS4 BT: reconnect, PS+Options Home chord, double-input across sources — NOT TESTED on MSI | high | open hardware gate (Luna procedure) |
| R2 | iPhone QR/TLS pairing on real device; portable trust-profile flow — NOT TESTED | high | open hardware gate |
| R3 | First-launch focus asymmetry in `launch_edge_cinema` spawn path (S2.9-A mitigated; verify on hardware) | medium | fixed in code, unverified on HW |
| R4 | Blind-toggle media control (Space/K) with no playback readback for Netflix/Prime/YouTube; playback-state preservation is explicitly out of scope | medium | documented limitation |
| R5 | `get_control_service_status` can exceed 8 s UI deadline during start/stop race (S2.9-B mitigated with typed `unknown`) | low | fixed in code, unverified on HW |
| R6 | iPhone cert model: device-wide root trust, shared CA key + HMAC tokens in one vault blob, no pinning/CRL (audit doc) | medium | accepted residual; plan only, no workaround |
| R7 | Credential Manager denied in sandboxes → 39 Windows-vault tests excluded there, not failed | low | environmental |
| R8 | Installer unsigned (SmartScreen warning); upgrade/rollback NOT TESTED | medium | documented; no signing key |
| R9 | HDMI disconnect/reconnect, negative monitor coords, display topology — partially covered by `display_audio.rs`; HW unverified | medium | open hardware gate |
| R10 | Single-instance + portable isolation rely on env redirection & disjoint identities; CI asserts `installedProfileCreated: false` | low | covered by CI smoke |

## 5. Prioritized implementation backlog (Ascension phases)

| Priority | Phase | Item | Owner |
| --- | --- | --- | --- |
| P0 | 0 | Recon + baseline + this report | lead (done) |
| P1 | 1 | Controller-first: cross-source double-input suppression, DS4 reconnect resync, PS+Options Home recovery, focus recovery — deterministic tests | Agent A (`ascension-a-input`) |
| P1 | 2 | Session intelligence: unified session ownership/lifecycle for Edge Cinema services + Steam/Playnite, duplicate-launch prevention, crash-recovery diagnostics, explicit playback-state limits | Agent B (`ascension-b-sessions`) |
| P1 | 3 | iPhone Remote 4.0: wire tested reliability primitives fail-closed (queue/dedup/backoff/timeout, replay-safe), revocation + device identity, security regression guards | Agent D (`ascension-d-remote`) |
| P2 | 6 | CI/provenance: soak tests in CI, SHA-256 manifest script for local dist artifacts, release-readiness doc, Windows-specific test notes | Agent E (`ascension-e-ci`) |
| P2 | 4 | UI: preserve Cinema Minimal; only measurable accessibility/readability fixes (audit by review agent) | review |
| P3 | 5 | Windows reliability audit doc: startup/shutdown, WebView2 lifecycle, scaling, audio, HDMI — bounded recovery only | lead/review |
| P0 | — | Independent security + regression review of the full ascension diff | Agent F |
| — | — | All physical hardware checks remain NOT TESTED until executed on the MSI per `docs/velora-2-s2-9-luna-test-procedure.md` | Luna (human) |

## 6. Worktree / ownership plan

| Worktree | Branch | Owns |
| --- | --- | --- |
| `velora-3-ascension` | `feat/velora-3-ascension` | integration, recon, final report (lead) |
| `ascension-a` | `ascension-a-input` | `src/services/controller*`, `crossSourceGate`, `nativeController*`, `gamepadSnapshot`, `hooks/useGamepad*`, `useNativeController`, Rust `ds4.rs`, `pad_hub.rs`, `gamepad_home.rs`, `controller_supervisor.rs` + own tests |
| `ascension-b` | `ascension-b-sessions` | `src/services/session*`, `veloraSessionManager`, `edgeCinema*`, `openStreamingService`, `homeActions`, `windowFocusRestore` + Rust `session_*`, `velora_session_manager.rs`, `window_broker.rs`, `edge_cinema.rs`, `streaming_control.rs`, `launch_registry.rs`, `operation_registry.rs` + own tests |
| `ascension-d` | `ascension-d-remote` | `public/remote/*`, `src/services/remote*`, Rust `remote_access.rs`, `remote_reliability.rs`, `remote_state_lock.rs`, `credential_store.rs` + own tests |
| `ascension-e` | `ascension-e-ci` | `.github/workflows/*`, `scripts/*`, `package.json` scripts, release-readiness docs + own tests |

Shared rules for every agent: no new npm/cargo dependencies; no changes to `pnpm-lock.yaml`/`Cargo.lock`; never weaken TLS/HMAC/replay/CSP/capabilities; no process killing, no window enumeration outside existing modules, no DRM/browser-security bypass; no global input hooks; no force push, no merge to `main`, no release; hardware tests stay NOT TESTED; run `pnpm test`, `pnpm build`, `cargo test --lib`, and the node check suites before reporting; commit in small reviewable milestones on your own branch only.
