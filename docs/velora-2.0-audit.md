# VELORA 2.0 — Audit, Plan and Backlog

Audit date: 2026-11-13. Repository: `Milklosz/nexus-aurea`.

This document is the entry point for the next work session. It records the
repository state, what was verified, the priorities, and what could not be
verified here. Update it when a backlog item lands.

## 1. Repository state

- `main` contains only NEXUS AUREA v0.5 (PRs #1–#7 merged, #8–#12 merged as
  v0.7.1–v0.9.2). Nothing from VELORA 1.0 or later is on `main`.
- 20 open Draft PRs (#13–#32) form one stack. Each PR targets a branch
  lower in the stack, so merging or retargeting one changes every PR above
  it. The VELORA 1.0 work (#13–#21) sits below the VELORA 1.5 / 2.0 work
  (#22–#32).
- Head of the stack: `feat/nav-wire-controller-remote` (commit `05c929a`, PR #32).
  All recent CI runs on this head are green on Windows and macOS
  (for example run 43327864609).
- No PR has been merged or released in this sprint. Merging and releasing
  require a separate decision.

## 2. Verified in this session

| Check | Commit | Result |
|---|---|---|
| `pnpm install --frozen-lockfile` | `05c929a` | OK |
| `pnpm test` (Vitest) | `05c929a` | 53 files, 471 tests passed |
| `pnpm build` (tsc -b + vite) | `05c929a` | OK |
| `cargo test --locked --lib` (Windows, MSVC) | `05c929a` | 258 passed, 0 failed |

Local Rust note: on this machine `cargo test` failed with `LNK1104` while the
build directory sat under the long scratch path. It passed with
`CARGO_TARGET_DIR` pointing to a short path (`C:\velora-target`). Use a short
target directory on Windows here.

Local git note: a clone under the scratch workspace failed with "Filename too
long" until `core.longpaths` was enabled.

## 3. Findings

### Fixed in this sprint (branch `fix/velora-2-shortcut-guards`)

- **S1. Held F11 toggles fullscreen repeatedly.** The App-level keydown
  handler in `src/App.tsx` acted on F11, Escape, F2 and F3 with no
  auto-repeat guard. Holding F11 flipped window mode on every repeat.
- **S2. Ctrl/Alt/Meta combinations reached app actions.** For example,
  Ctrl+Escape (Start menu) also exited fullscreen. Arrow navigation in the
  same handler ignored modifiers as well.

Fix: `isIgnoredShortcutEvent` in `src/services/navIntent.ts`, used by the
App-level handler. Covered by four unit tests in
`src/__tests__/navIntent.test.ts`. Arrow and Backspace auto-repeat are
unchanged.

### Open (backlog)

- **B1. Window `focus` restore ignores Control Center.** `App.tsx` restores
  dock focus on window `focus` unless the diagnostics panel is open. It does
  not check `controlCenterOpen`. Modal `<dialog>` content is inert, so this is
  probably harmless, but it should be confirmed on hardware and guarded the
  same way.
- **B2. Progress document is stale.** `NIGHT_BUILD_PROGRESS.md` describes the
  PR #13 lineage as of 2026-11-11. It must be rewritten for the current chain.
- **B3. Stack complexity.** Twenty draft PRs with stacked bases make
  merge order fragile. Proposal: one integration branch, with every stacked
  change cherry-picked or rebased onto it, then a single Draft PR to `main`.
  This is a decision for the owner, so it is not done here.
- **B4. Hardware validation is outstanding.** The checklist in
  `NIGHT_BUILD_PROGRESS.md` (MSI install, DualSense reconnect, Playnite
  fullscreen handoff, return to VELORA) has not been run on hardware.

## 4. Priorities for VELORA 2.0

Acceptance criteria are listed for each item. "Done" means the criteria are
met and the tests above still pass.

1. **Stability (Stage 2).** Shortcut guards (done here). Next: verify
   single-instance restore and the app-exit path (`src-tauri/src/lib.rs`) with
   tests where they can run without hardware.
2. **Navigation (Stage 3).** The shared intent model exists (`navIntent.ts`).
   Next: a keyboard, DualSense and iPhone-remote mapping test table, including
   reconnect and double-activation guards.
3. **TV experience (Stage 4).** Service tiles, weather, clock, autostart and
   error handling. Needs a manual pass on a real TV; not verifiable here.
4. **Integration and CI (Stage 5).** One integration branch (B3), green CI
   before any Draft PR is marked ready.

## 5. Not verified here

- Any physical controller (DualSense or other), iPhone remote, TV or MSI.
- Windows NSIS/MSI installer build and install (CI builds the installer; it
  was not run locally).
- Real Netflix, YouTube, Disney+, Max, Prime Video, Apple Music, Steam, Playnite
  or GOG behavior. These depend on third-party clients and accounts.

## 6. How to continue

```bash
git fetch origin
git switch fix/velora-2-shortcut-guards
pnpm install --frozen-lockfile
pnpm test
pnpm build
CARGO_TARGET_DIR=C:/velora-target cargo test --locked --manifest-path src-tauri/Cargo.toml --lib
```

Then take the next open item from section 3 or 4 and keep this document
current.
