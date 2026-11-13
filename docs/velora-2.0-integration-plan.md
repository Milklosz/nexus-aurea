# VELORA 2.0 — Integration Plan

Date: 2026-11-13. Companion to `docs/velora-2.0-audit.md`.

## Purpose

The open Draft PRs (#13–#33) form one stack, and fixes from #34 onwards branch
from `integration/velora-2.0`. This document records what is in the integration
branch, what is not, and why. Nothing here merges into `main`, and no existing
branch or PR was rewritten or closed.

## Integration branch

`integration/velora-2.0` was updated on 2026-11-13 by fast-forward only
(`cdef18d` → `9d16008`). No history was rewritten.

Merge record, in order (all `--no-ff`):

| Order | Branch | PR | Result |
|---|---|---|---|
| 1 | `docs/velora-sprint-a-audit` | #25 | clean (docs only) |
| 2 | `test/gamepad-simulated` | #30 | clean (tests only) |
| 3 | `fix/smtc-poll-pause-hidden` | #26 | one import conflict in `src/App.tsx`, both imports kept |
| 4 | `fix/clock-isolate-rerender` | #27 | clean |
| 5 | `fix/return-home-focus-selected-tile` | #29 | one import conflict in `src/App.tsx`, both imports kept |
| 6 | `fix/velora-2-focus-restore-overlays` | #34 | clean |
| 7 | `feat/velora-2-nav-back-intent` | #35 | clean; depends on #34, which is merged first |
| 8 | `fix/velora-2-lifecycle-audit` | #36 | clean |
| 9 | `fix/velora-2-toast-timer` | #37 | clean |
| 10 | `fix/velora-2-session-transition-notice` | #38 | `src/App.tsx` import conflict, both sides kept |
| 11 | `docs/velora-2-sprint-a-status` | #39 | clean (docs only) |
| 12 | `fix/velora-2-webview2-edge-audit` | #40 | clean |
| 13 | `feat/velora-2-home-zones` | #41 | `src/App.tsx` import conflict, union of both sides |
| 14 | `feat/velora-2-virtual-keyboard-model` | #42 | clean (model only, no UI) |

PR #33 (shortcut guards and the audit document) is not in the integration branch.
It stays on its own stack, based on `feat/nav-wire-controller-remote` (#32).

Before the update, `git merge-tree --write-tree` showed conflicts only in
`src/App.tsx`.

## Not integrated

- **`claude/charming-albattani-9sy4if` (PR #22)**: "VELORA 1.5 controller-first
  navigation and keyboard". It stays a Draft, unchanged, and is not merged. Its
  keyboard model is on the integration branch (#42, an unchanged port with 16
  tests). Its navigation is covered by the intent model (#31, #32) and the home
  zones (#41). See `docs/velora-pr22-recommendation.md`.

## Stack structure (verified)

- PR #35 is based on PR #34. Every other PR from #34 to #42 is based on
  `integration/velora-2.0`, so the merge order above respects the dependency.
- The 20 open PRs from #13 to #32 form one stack. Their bases do not change.

## Rules going forward

1. New fixes branch from `integration/velora-2.0`, not from the bottom of the
   stack, so the stack does not grow.
2. Each significant fix gets its own Draft PR with tests.
3. The integration branch changes only by fast-forward. Existing PRs are not
   closed or rewritten unless the owner decides so.
4. Merging to `main` and publishing any release require a separate owner decision.
5. No MSI build is installed and no working VELORA build is changed. Hardware
   checks stay NOT RUN until someone runs them on the device.

## Draft PRs

| PR | Head | Base | Scope |
|---|---|---|---|
| #33 | `fix/velora-2-shortcut-guards` | `feat/nav-wire-controller-remote` (#32) | Shortcut guards (F11 repeat, Ctrl/Alt/Meta); audit doc |
| #34 | `fix/velora-2-focus-restore-overlays` | `integration/velora-2.0` | Window focus does not move the dock highlight under an open overlay |
| #35 | `feat/velora-2-nav-back-intent` | `fix/velora-2-focus-restore-overlays` (#34) | Keyboard Backspace uses the shared back intent; parity tests |
| #36 | `fix/velora-2-lifecycle-audit` | `integration/velora-2.0` | Startup recovery notice from the session snapshot |
| #37 | `fix/velora-2-toast-timer` | `integration/velora-2.0` | Toast timer is no longer cleared on every re-render |
| #38 | `fix/velora-2-session-transition-notice` | `integration/velora-2.0` | A failed session change shows a notice |
| #39 | `docs/velora-2-sprint-a-status` | `integration/velora-2.0` | PR #22 recommendation and Sprint A status |
| #40 | `fix/velora-2-webview2-edge-audit` | `integration/velora-2.0` | Untracked managed launches and a failed Steam baseline are reported, not ignored |
| #41 | `feat/velora-2-home-zones` | `integration/velora-2.0` | Vertical home zones on the intent model; D-pad and stick up and down |
| #42 | `feat/velora-2-virtual-keyboard-model` | `integration/velora-2.0` | On-screen keyboard model on the intent model (no UI) |
| new | `feat/velora-2-virtual-keyboard-ui` | `integration/velora-2.0` | Keyboard UI; opens only for `data-velora-text-entry` fields |
| new | `fix/velora-2-dualsense-input-normalization` | `integration/velora-2.0` | Gamepad normalization; Sony D-pad read from the hat on axis 9 |
| new | `docs/velora-2-integration-update` | `integration/velora-2.0` | This document |

## Verification status

Local, Windows:

| Branch (head) | `pnpm test` | `pnpm build` | `cargo test --lib` |
|---|---|---|---|
| `integration/velora-2.0` (`9d16008`) | 67 files / 566 tests passed | passed | 259 passed |
| `feat/velora-2-virtual-keyboard-ui` (`2abcdae`) | 70 files / 603 tests passed | passed | not re-run (no Rust change) |
| `fix/velora-2-dualsense-input-normalization` (`af1a955`) | 68 files / 579 tests passed | passed | not re-run (no Rust change) |

`cargo test` runs with `CARGO_TARGET_DIR=C:\velora-target` to avoid LNK1104 on
long paths.

CI on #40, #41 and #42 passed on both the push and PR runs (Windows, macOS,
Playnite extension). The new PRs have no CI result yet; treat them as unverified
until their checks pass.

## Not verified (NOT RUN)

- DualSense on hardware: D-pad (hat and fallback), left stick, reconnect. The
  Options chord is not implemented; it is an experimental decision.
- iPhone remote up and down on the home screen.
- TV and HDMI: focus visibility on zones and the keyboard, sleep and wake,
  monitor disconnect.
- Installed MSI build: install, start, reboot and sign-in, real Steam, Playnite
  and Edge launches.

## Next steps

1. Review the Draft PRs in stack order, one at a time, after CI passes on each.
   Nothing goes to `main` without the owner's decision.
2. Decide the keyboard's first field. No VELORA screen has one yet.
3. Decide the Edge orphan policy (see `docs/velora-2-sprint-a-status.md`).
4. Hardware checks above remain NOT RUN until someone runs them on the device.
