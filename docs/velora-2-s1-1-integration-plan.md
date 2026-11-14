# VELORA 2.0 S1.1: integration plan (work in progress)

Status: **partial**. Merge done and verified for tests; reliability fixes, security
regression audit, final Opus audit, hardware-readiness doc and Draft PR are NOT done yet.

## PR state (checked on GitHub, 2026-11-14)

| PR | Head | Base | State | CI (win/mac/playnite) |
|---|---|---|---|---|
| #49 credential store | 9212290 | stabilization/velora-2-s0 | open, draft | pass |
| #50 provenance | d43c0c8 | stabilization/velora-2-s0 | open, draft | pass |
| #51 S0.1 hardening | 1df1736 | tmp/velora-2-s0-combined | open, draft | pass |
| #52 Cinema Minimal | 30c1e50 | test/velora-2-combined | open, draft | pass |
| #53 Visual Polish | 7a57902 | #52 | open, draft | pass |
| #54 native DS4 | d816266 | #53 | open, draft | pass |

Note: #51 head is now 1df1736 (the 860138d in the sprint brief is outdated).

## Dependency graph

- S0 line: `test/velora-2-combined` (f82654c) -> #48 (3631248) -> #49 and #50 -> `tmp/velora-2-s0-combined` (8216c17) -> #51 (1df1736).
  1df1736 already contains #48, #49, #50 and #51.
- S1 line: f82654c -> #52 -> #53 -> #54 (d816266), linear, 7 commits beyond f82654c.
- merge-base(1df1736, d816266) = f82654c. S0 side has 24 commits, S1 side 7.

## Chosen integration

Single `git merge --no-ff d816266` into 1df1736, no rebase, no squash (provenance ties
evidence to exact SHAs). Branch: `integration/velora-2-s1-1-sprint` (the name
`integration/velora-2-s1-1` was already taken by someone else's uncommitted merge in
`C:\Users\milos\velora-s1-1`, which was left untouched). Merge commit `8d1fc3e`.
The merge is textually conflict-free; only lib.rs, ControlCenter.tsx and
controlCenter.test.tsx changed on both sides, and Opus found no semantic conflict.

## Verified on the merge commit (local, Windows)

- `tsc -b`: exit 0
- `vitest run`: 86 files, 796 tests passed
- `cargo test`: 338 passed, 0 failed
- Not yet run: `pnpm build`, `pnpm test:provenance`, cargo check on other targets, CI on the merge SHA.

## Opus pre-integration audit findings (to be acted on)

1. should-fix (security): Living Room ControlCenter drops the TLS warning sentence
   "Nie omijaj ostrzezen TLS w Safari." (ControlCenter.tsx, S1 side). Restore in both modes and add a test
   (Living Room + `initialPanel="remote"` + `storeState: "damaged"`).
2. should-fix: DualSense over Bluetooth is not identified. `gamepad_home.rs`
   `is_dualsense_device_path` needs `vid_054c`; BT paths use `VID&0002054c_PID&0ce6`.
   Fix: use `native::device_ids(device)` (RIDI_DEVICEINFO, vendor 0x054C, product 0x0CE6/0x0DF2) first, path as
   fallback, with USB and BT tests. Do not guess other formats.
3. should-fix: analog stick events have no deadzone and no rate cap (ds4.rs quantises to 1/16,
   pad_hub emits every change). Zero small values before quantising; coalesce stick-only changes per pad
   (~16 ms), send buttons and D-pad immediately.
4. should-fix: raw report forwarding to the DualSense runtime uses an unbounded channel and also forwards
   non-Sony pads. Use a bounded `sync_channel` with `try_send`, forward only Sony DualSense ids, and record a
   dropped home request in hub status.
5. should-fix (needs hardware check): Gamepad API "playstation" raw profile maps B0/B1 to confirm/back
   (`controllerInput.ts:127`), while diagnostics and HID order say B1 = Cross, B2 = Circle. Do not change
   the mapping without evidence; at minimum document it and add it to the hardware test plan.
6. should-fix: Options fires on press on the Gamepad API path and on release on the native path, so the
   90 ms / 400 ms gate can let a virtual-XInput Options through. Call `noteNativeActivity` from the store
   listener instead of the next tick, and add Options and PS+Options to hardware test 17a.
7. Hardware-only (not blockers): DS4 USB/BT report shapes, VID over BT, 3 s stale pruning of silent BT pads,
   Steam taking the PS button, Steam Desktop Configuration keystrokes, foreground detection with WebView2.
8. Behaviour note: the Raw Input sink (RIDEV_INPUTSINK) now lives for the whole app lifetime; exactly one
   registration exists (pad_hub.rs).

## Remaining work

Fixes 1-6 above with tests, security regression audit (Credential Manager, provenance, Control Service,
Remote), `pnpm build` and provenance test, push branch, open Draft PR, wait for CI, second independent Opus
audit after the fixes, `docs/velora-2-s1-1-hardware-readiness.md`, final report.
Nothing was installed on the MSI, `main` and PRs #49-#54 were not modified.
