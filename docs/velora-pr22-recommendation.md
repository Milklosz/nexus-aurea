# PR #22 — Comparison with the navigation model and recommendation

Date: 2026-11-13. PR #22 (`claude/charming-albattani-9sy4if`, "VELORA 1.5
controller-first navigation and keyboard") is a Draft and is NOT changed,
closed or integrated by this document.

## What PR #22 contains

- Vertical home zones: up/down move between Control Center, the Music mini
  player, the dock and Diagnostics (`src/services/homeZones.ts`).
- DualShock 4 support in the WebView: D-pad read from the 8-way hat on axis 9,
  hat decoding with a tolerance (`decodeDpadHat`), and a 250 ms Options hold for
  the PS+Options Home chord (`HOME_CHORD_WINDOW_MS`).
- A virtual on-screen keyboard (`VirtualKeyboard`, `useVirtualKeyboard`,
  `virtualKeyboard.ts`). Its only consumer is a test field in Diagnostics.
- Documentation: `docs/velora-v1.5-controller-first.md` (states that hardware
  checks are NOT RUN).

## Where the current model (#31, #32, #35 and the integration branch) stands

| Capability | Current model | PR #22 | Gap |
|---|---|---|---|
| Keyboard, DualSense, remote intents (move, select, back, menu, home) | Shared in `navIntent.ts` | Its own controller engine rewrite | Overlap in `controllerEngine.ts` and `App.tsx` |
| Up/down on home | Quick-settings shortcut; dock grid for remote | Zone-aware | Missing: zones |
| DualSense D-pad | Buttons 12–15 only | Hat on axis 9 for Sony pads | Missing: hat decoding (see below) |
| PS+Options Home from the WebView | Not handled; the native `gamepad_home.rs` handles DualSense PIDs `0x0CE6`/`0x0DF2` only | Chord with a 250 ms Options hold | Missing; DS4 Home is not handled natively (its test excludes `0x05C4`) |
| On-screen keyboard | None | Full keyboard | Missing; product decision on where it is used |

Trial merge: merging PR #22 into the integration branch conflicts only in
`src/App.tsx`. `controllerEngine.ts` and `useGamepad.ts` merge cleanly in that
trial, but their behavior is not compatible with the intent model without
review.

## Recommendation

**Keep, do not integrate yet.** Specifically:

1. **Do not close or merge PR #22.** It is the only place with the zone model,
   the hat decoding and the keyboard. Its base is PR #21, the old chain; rebasing
   would rewrite history, which this sprint avoids.
2. **Port the hat decoding first** (`decodeDpadHat`, a pure function with its
   tests) as a small PR on the integration branch. It is self-contained, adds
   no UI behavior, and fixes D-pad input for Sony pads. Confirm with a physical
   controller before merging. NOT RUN here.
3. **Port the zones on top of the intent model** after #35 merges. Zones change
   only what up/down means on the home screen. Keep the existing left/right
   dock behavior and the remote grid unchanged.
4. **Decide before porting the Home chord.** It changes Options behavior: a
   single Options press is delayed by 250 ms. That is a product decision.
   The native DualSense Home path already exists, so the WebView chord would
   mainly serve DS4 users.
5. **Keep the virtual keyboard out of this sprint** unless there is a real text
   consumer for it on the main screen (for example Playnite search). Today its
   only user is a diagnostics test field.

## Decisions needed from the owner

- Which controller is the target: DualShock 4 (PR #22 documents DS4 as the
  hardware target) or DualSense (the native path and the progress notes focus
  on DualSense)? The answer decides whether the hat port and the Home chord are
  needed at all.
- Accept the 250 ms Options delay if the PS+Options Home chord is wanted.
- Is the on-screen keyboard wanted on the TV, and where?

## Risks of integrating PR #22 as-is

- It rewrites `controllerEngine.ts` (276 changed lines) and changes Options
  timing for every pad.
- Its base is an old chain (PR #21). Its CI result is not on the current head.
- Its documentation says hardware checks are NOT RUN, so all controller
  behavior is unverified on real hardware.
