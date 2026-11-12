# VELORA 1.0 — Integration Plan (Phase Zero)

Verified on 2026-11-12 against `origin` (`Milklosz/nexus-aurea`). These are the
actual refs observed, not assumptions from the sprint brief.

## 1. Git graph

| PR | Branch | HEAD | Commits ahead of Night Build | Merge-base with #13 |
|---|---|---|---|---|
| #13 | `feat/velora-night-build-2` | `7fd83c6` | 0 | `7fd83c6` |
| #14 | `fix/velora-deepseek-p1` | `8b2fc99` | 1 | `7fd83c6` |
| #16 | `feat/velora-v1-core` | `3a201da` | 4 | `7fd83c6` |
| #17 | `feat/velora-v1-system-intelligence` | `069c4e2` | 9 | `7fd83c6` |
| #15 | `feat/velora-v1-experience` | `efa45d8` | 7 | `7fd83c6` |
| #18 | `feat/velora-v1-ecosystem` | `28267a1` | 17 | `7fd83c6` |

All six lines share the same merge-base, `7fd83c6`. Core contains P1. System
Intelligence contains Core. Ecosystem contains Experience. Ecosystem does **not**
contain P1/Core/System Intelligence, so it was merged last into a branch based
on the verified System Intelligence HEAD.

```text
7fd83c6 Night Build #13
├── 8b2fc99 P1 #14
│   └── 06f3d9f → 83dad78 → 3a201da Core #16
│       └── 09430ee → … → 069c4e2 System Intelligence #17
│                                        │
│                                        └── integration/velora-v1
│
└── 050b8e2 → … → efa45d8 Experience #15
    └── b2820ec → … → 28267a1 Ecosystem #18 ── merge ──┘
```

## 2. Integration strategy

1. Create `integration/velora-v1` from `069c4e2` (verified #17 HEAD).
2. Merge `28267a1` (Ecosystem, which contains Experience) with a real merge
   commit. Never force-push or rewrite any source branch.
3. Resolve only conscious conflicts; keep P1 security behavior.
4. Replace the Ecosystem prototype session/state duplication with the single
   native owner: `SessionOrchestrator` + `LaunchRegistry` + `WindowBroker`.
5. Run the full local gate, push, run Windows CI, then open a Draft PR against
   `feat/velora-night-build-2`.

## 3. Shared files and conflicts

Actual merge conflicts:

| File | Why | Resolution |
|---|---|---|
| `README.md` | Both lines appended V1 documentation | One “Grand Integration” section; both architecture/experience/ecosystem links kept |
| `src-tauri/src/lib.rs` | Both lines register modules/managed state/commands | Union of all modules, managed state and commands; no prototype `EdgeCinemaSessions` owner |

Auto-merged but reviewed: `src/App.tsx` (AUREA grid option + native session
wiring), `src/styles.css` (appended panels), navigation/remote tests.

No conflict occurred in `app_manager.rs`, `control_service.rs`,
`remote_access.rs`, `music_service.rs`, `public/remote/*` or capabilities, so
P1 fixes were not reverted. `src/__tests__/remoteSecurityInvariants.test.ts`
expected the pre-P1 Service Worker cache name; P1 intentionally bumped it to
`…command-5`, so the invariant now asserts the current confirmed-command cache.

## 4. Architectural risks found before coding

1. **Two session owners.** Ecosystem `EdgeCinemaSessions` and `edge_cinema.rs`
   kept a second global state (`idle/launching/active/…`) and emitted events
   without touching `SessionOrchestrator`. This is the highest-risk duplication.
2. **Two Edge launch paths.** `app_manager` launched a generic `msedge.exe`
   managed app; Edge Cinema had a separate spawn path. Neither used the
   dedicated profile as the session identity.
3. **Window identity.** `LaunchRegistry` matched windows only against
   descendant PIDs, so a root-owned window (Edge browser, Steam Big Picture)
   could not become the session window. Foreground matching by PID alone was
   also vulnerable to PID reuse.
4. **Window close vs process exit.** Edge can keep background processes alive
   after the app window closes. Process-exit-only tracking would leave a Cinema
   session stuck.
5. **Playnite library vs launch.** The manifest was validated and displayed but
   clicking a game only recorded a local recent item; no native launch existed.
6. **iPhone Remote retry.** The PWA deliberately never auto-retries, but the
   server had no exact-duplicate acknowledgement. Retrying a consumed sequence
   was indistinguishable from a replay attack.
7. **Concurrent Home.** Gamepad, iPhone Remote and UI could each request Home,
   duplicating focus restoration and `velora-return-home` events.
8. **C# extension.** The Playnite exporter is source only. The SDK version is a
   placeholder and the authoring environment has no .NET/Playnite toolchain.

## 5. Integration order

1. History merge and compile baseline.
2. `LaunchRegistry`: Cinema kind, root-window ownership, window-close completion,
   shorter Edge start deadline, read-only session accessors.
3. `WindowBroker`: confirmed `WM_CLOSE` for a tracked external window only.
4. `edge_cinema`: rewrite as a thin adapter over LaunchRegistry + WindowBroker,
   with a non-secret persistent marker for safe adoption after restart.
5. Playnite: canonical manifest URI + `ShellExecuteW` launch through the
   existing Playnite session.
6. iPhone Remote: bounded in-memory receipt log + exact duplicate ACK.
7. Concurrent Home dedupe.
8. Frontend: Playnite launch wiring, display contracts, IPC registry.
9. Tests, docs, Windows CI, Draft PR.

## 6. Test plan

- Local: `pnpm test`, `pnpm build`, `cargo test --locked --lib`,
  `cargo check --locked`, `git diff --check`.
- Windows CI: MSVC `cargo check`, Rust tests, React tests/build, NSIS x64,
  SHA-256 of exactly one installer.
- Mocked integration coverage: Edge window lifecycle, window-close while
  process lingers, PID/HWND reuse, Playnite handoff, restart recovery,
  sleep/wake, concurrent Home, remote duplicate/replay, stale autostart entry,
  diagnostics without secrets.
- Hardware-only checks: DualSense USB/BT, Steam Input, Edge DRM/HDCP, 4K/HDR,
  Panasonic HDMI, Playnite extension packaging, autostart after real install.
  These are **REQUIRES MSI**, never claimed as CI-passed.

## 7. Decisions requiring architectural judgement

- **Edge identity:** LaunchRegistry owns process/window lifecycle; the Edge
  profile marker is only a recovery hint. It is validated against PID creation
  time, `msedge.exe` image name and a visible window before adoption.
- **No process kill:** confirmed close uses `WM_CLOSE` on one tracked HWND.
  Closing the Edge window is the user gesture; the browser process may linger
  and is not terminated.
- **Playnite game launch:** only the canonical
  `playnite://playnite/start/<guid>` URI from the validated manifest is opened
  through the Windows shell. Raw paths/arguments are never read.
- **Remote idempotency:** only an exact already-executed `(device, sequence,
  command)` gets a 204 replay acknowledgement. A different command on a used
  sequence is rejected. Automatic retry stays disabled in the PWA.
- **C# extension:** stays source-only until a real Windows + Playnite SDK build
  proves it. Rust parser tests do not prove the extension works.
