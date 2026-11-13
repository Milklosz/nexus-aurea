# VELORA 2.0 — Integration Plan

Date: 2026-11-13. Companion to `docs/velora-2.0-audit.md`.

## Purpose

The open Draft PRs (#13–#33) form one stack, but some work sits on side
branches that are not ancestors of the newest stack head. This document
records which work is already in `integration/velora-2.0`, which is not, and
why. It is a plan only. Nothing here merges into `main`, and no existing
branch or PR was rewritten or closed.

## Integration branch

`integration/velora-2.0` = `fix/velora-2-shortcut-guards` (PR #33) plus
these side branches, merged in this order:

| Order | Branch | PR | Result |
|---|---|---|---|
| 1 | `docs/velora-sprint-a-audit` | #25 | clean (docs only) |
| 2 | `test/gamepad-simulated` | #30 | clean (tests only) |
| 3 | `fix/smtc-poll-pause-hidden` | #26 | one import conflict in `src/App.tsx`, resolved by keeping both imports |
| 4 | `fix/clock-isolate-rerender` | #27 | clean |
| 5 | `fix/return-home-focus-selected-tile` | #29 | one import conflict in `src/App.tsx`, resolved by keeping both imports |

Verification of the integration branch (local, Windows):
`pnpm test` 57 files / 494 tests passed; `pnpm build` passed.

## Not integrated

- **`claude/charming-albattani-9sy4if` (PR #22)**: "VELORA 1.5 controller-first
  navigation and keyboard". It is three commits ahead of `claude/zealous-ride-swcraj`
  and conflicts in `src/App.tsx` with the integration branch. It overlaps the
  shared navigation intent model (PRs #31 and #32). Decision needed: either
  retire it as superseded by the intent model, or port its unique behavior onto
  the intent model in a separate PR. Not merged here.

## Stack structure (verified)

- Every base branch is an ancestor of its head (`behind = 0` for all 20 open PRs).
- Heads that are ancestors of PR #33's head: #13–#21, #23, #24, #28, #31, #32, #33.
- Heads not in that history: #22, #25, #26, #27, #29, #30. #25, #26, #27, #29 and #30
  are carried by `integration/velora-2.0`. #22 is not.

## Rules going forward

1. New fixes branch from `integration/velora-2.0`, not from the bottom of the
   stack, so the stack does not grow.
2. Each significant fix gets its own Draft PR with tests.
3. Existing PRs are not closed or rewritten unless the owner decides so.
4. Merging to `main` and publishing any release require a separate owner decision.
