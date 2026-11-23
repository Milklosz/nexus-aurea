# VELORA 3.0 — Ascension A: controller-first Windows input (Phase 1)

- Branch: `ascension-a-input` (Agent A worktree `ascension-a`)
- Base: `4a431768f85d4ba81161b331ebcce93b4684dd2e` (`origin/feat/s2-9-hardware-recovery`, Draft PR #72)
- Scope: `src/services/{controllerInput,controllerEngine,controllerOwnership,crossSourceGate,gamepadSnapshot,nativeController,nativeControllerStore,controllerHomePreflight}.ts`, `src/hooks/{useGamepad,useNativeController,useControllerOwnershipSuspension}.ts`, Rust `src-tauri/src/{ds4,pad_hub,gamepad_home,controller_supervisor}.rs`, new tests `src/__tests__/ascensionA*.test.ts(x)`, this doc.
- **Hardware disclaimer:** all findings are from static source + deterministic synthetic tests. No physical DS4/DualSense was operated. Physical hardware gates remain **NOT TESTED** (Luna procedure, MSI GP76). The Windows-target cargo check is CI-only (`aws-lc-sys` needs the Windows SDK); locally verified via `cargo test --lib` on macOS (Windows-only `cfg` modules are parse-checked with rustfmt) plus CI on the PR.

## 1. Cross-source double-input suppression (Deliverable 1)

`CrossSourceGate` (`src/services/crossSourceGate.ts`) now arbitrates **four** sources
uniformly: `"native"` (Rust `pad_hub` semantic events), `"gamepad-api"` (browser
Gamepad API), `"keyboard"` (keys acting as controller input — e.g. a DS4 button that
also surfaces as a keyboard event), `"remote"` (authenticated LAN `remoteCommand`).

Rules (all deterministic, clock injected by the caller):

1. **Explicit suppression window** (`windowMs`, default 90 ms): an action is dropped
   only when the *same* action key was accepted from a *different* source within the
   window — including the **same tick**. A single physical press surfacing on several
   sources therefore fires exactly one action. The same source is never throttled
   here; its own debounce/repeat logic owns its timing.
2. **Native priority** (`nativePriorityMs`, default 400 ms): while the native pad is
   active (`noteNativeActivity`), *every* non-native source is dropped — globally and
   per action key. This covers virtual pads from the same physical DS4 (DS4Windows,
   ViGEm, Steam virtual XInput) and DS4 buttons echoed as keyboard events.
3. **Generation/epoch check**: `advanceEpoch()` is called at deterministic resync
   boundaries (native pad connect/disconnect, window focus regain). `accept(...)` may
   carry the epoch tag captured when the input was produced; a tag from before the
   latest boundary is a **replayed event** and is dropped even after all time windows
   elapsed. `reset()` clears timing state but never rewinds the epoch.

Wiring: `useGamepad` and `useNativeController` dispatch through the shared
`crossSourceGate` singleton (native dispatches are epoch-tagged). The keyboard and LAN
remote dispatch sites live in `App.tsx`/`navIntent.ts` (owned by another agent); they
plug into the same exported singleton with one call — `crossSourceGate.accept("keyboard"
| "remote", action, now)` — and are covered by the gate's arbitration and tests now.

**Steam Input coexistence (explicitly out of scope):** VELORA performs **no** Steam
Input interception and no global input hooks. It only reads its own window focus
(`document.hasFocus()` / foreground-own-process on the Rust side) and the browser
Gamepad API, plus its own process-local Raw Input registration for DS4/DualSense HID.
If Steam Input remaps the DS4 into a virtual XInput pad, the native-priority rule
suppresses the browser echo of the same physical press.

Tests: `src/__tests__/ascensionACrossSourceGate.test.ts` (10 tests: simultaneous
four-source same-tick, DS4-as-keyboard, pad+remote race, same-source repeat allowed,
native priority over all non-native sources, per-action priority, epoch replay,
reset-never-rewinds-epoch, key mapping, seeded 2000-step four-source soak).

## 2. DS4 reconnect resync (Deliverable 2)

Frontend (`nativeController.ts`, `nativeControllerStore.ts`, `useNativeController.ts`):

- `NativeControllerModel.epoch` is a **monotonic connection epoch**, bumped on every
  `connected` / `disconnected` / `unavailable` event and never rewound (not even by
  store stop/start).
- When the **active** pad disconnects (Bluetooth drop, USB replug, stale prune),
  `snapshot` becomes neutral/null and `lastButton`/`lastInputAt` are cleared — no
  stuck held/"armed" state survives the boundary. Ownership falls to another pad or
  back to the Gamepad API (`chooseInputSource` / `nativeControllerOwnsGamepadApi`).
- A reconnecting pad starts from `NEUTRAL_SNAPSHOT`, which re-primes the input engine:
  the first sample after a reconnect is a prime, never a release — a button held
  across the reconnect does not fire.
- The hook syncs model-epoch changes to a `crossSourceGate` epoch boundary, so input
  tagged before the reconnect is rejected as replayed.

Rust (`ds4.rs`, `pad_hub.rs`, `gamepad_home.rs`, `controller_supervisor.rs`):

- `Ds4Tracker` emits `Connected` + the held `State` **in one ingest** on reconnect, so
  the frontend applies both before its next 16 ms tick and primes on the held state.
- `ComboTracker.require_device_rearm` / `on_arrival` set a per-device
  `awaiting_neutral` flag (surviving the internal staleness reset): a (re)connected
  pad must observe one fully neutral sample before PS+Options can fire. `HubCore`
  arms it on every `Connected` event; `GamepadHomeRuntime` arms it on device arrival.
  This closes the gap where the DualSense arrival path never bumped the global chord
  generation — a PS held across a drop could previously complete a chord on reconnect.
- The fallback supervisor (`ControllerSupervisor`) already rearms after
  `remove_device` / silence; now covered by an explicit reconnect test.
- On device change the run loop still calls `invalidate_controller_streaming` exactly
  once per real transition (armed media/tv-navigation state resync), unchanged.

Tests: `ascensionAReconnect.test.ts` (8 pure reducer/store tests, injected timestamps),
`ascensionANativeReconnectHook.test.tsx` (6 hook tests with fake timers + injected
`performance.now()`: disconnect mid-press, held-across-reconnect priming, PS+Options
straddling a reconnect never opens a panel, two-pad handover, double focus event,
press-while-blurred never fires late), Rust: 3 `gamepad_home` + 1 `pad_hub` + 1 `ds4`
+ 1 `controller_supervisor` tests.

## 3. PS + Options Home recovery (Deliverable 3)

The Home chord is detected in Rust from raw reports (`pad_hub` HubCore for DS4,
`gamepad_home` ComboTracker for DualSense) and dispatched through the existing Home
transaction (`request_return_home`) **without consulting any UI state** — so it works
identically from any overlay, dialog, panel or streaming session. The frontend
`velora-return-home` handler closes overlays and focuses the dock tile that launched
the session (`returnHomeFocusTarget(activeServiceRef.current, count)` — the launched
tile, clamped, never always tile 0).

- Frontend readiness acknowledgement (`controllerHomePreflight.ts`) is bound to
  `sessionRevisionToken` (session id + revision + launch id): a real transition into a
  streaming session or a remount invalidates it; re-establishing is an explicit user
  action, never a silent continuation.
- `homeActions.ts` (owned elsewhere, used here only through its exported API):
  `closeHomeDisclosure` closes an open Home disclosure even while focus is inside a
  dialog; `moveWithinHomeActions` never wraps/leaves the row; `activateHomeAction`
  presses only row actions.
- On the native source, Options fires on release and never together with PS, so the
  chord cannot also open Control Center — including a chord that straddles a
  reconnect (tested at hook level).

Tests: `ascensionAHomeRecovery.test.ts` (12 tests), plus the hook-level chord tests in
`ascensionANativeReconnectHook.test.tsx`.

## 4. Window ownership & focus recovery (Deliverable 4)

`useFocusOwner` / `useReturnHomeFocus` / `windowFocusRestore` already existed and are
**verified here, not duplicated**:

- Regaining foreground resolves exactly one focus owner (`external` → `home-dock`);
  a `confirm` landing inside the `CONFIRM_SETTLE_MS` (180 ms) hand-over window is
  swallowed **exactly once**, moves/back are never delayed, and duplicate `focus`
  events do not extend the settle window (double-activation suppression).
- A window `focus` event never moves dock focus while any dialog/Control
  Center/diagnostics overlay is open (`shouldRestoreDockFocus`); the dock tile is
  restored on focus regain only when no overlay owns focus.
- `useNativeController` treats focus regain as a resync boundary: it advances the
  cross-source gate epoch (replayed recovery actions die) and re-primes the engine, so
  the selected tile/focus owner is restored exactly once and a held button cannot
  fire late.

Tests: `ascensionAFocusRecovery.test.tsx` (8 tests: pure guard + hook-level with
injected clock).

## 5. Verification (all run on `ascension-a-input`, this branch tip)

| Command | Result |
| --- | --- |
| `pnpm test` (vitest, full suite) | **117 files / 1092 tests PASS** (baseline 112 / 1046 → **+5 files / +46 tests**) |
| `pnpm build` (tsc -b + vite build) | PASS |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | **438 passed / 0 failed / 1 ignored** (baseline 432 → **+6 tests**) |
| `pnpm test:soak` | 3 PASS |
| `pnpm test:provenance` | 31 pass / 0 fail |
| `pnpm test:portable-manifest` | 8 pass / 0 fail |
| `pnpm test:claude-usage` | 6 pass / 0 fail |

Windows-target cargo check (`x86_64-pc-windows-msvc`) is CI-only; the single
`cfg(target_os = "windows")` line changed (`tracker.on_arrival(&id)`) calls a
non-cfg method with the same signature as the call it replaces; all four Rust files
parse cleanly under rustfmt.

## 6. Known limitations

- Physical hardware behavior (DS4 Bluetooth reconnect timing, real chord feel, Steam
  Input coexistence on the MSI) is **NOT TESTED** here — Luna's procedure owns that gate.
- Keyboard/remote dispatch sites (`App.tsx`, `navIntent.ts`) are owned by another
  agent; the gate fully supports them and their tests cover the arbitration, but the
  one-line `accept("keyboard"|"remote", ...)` call at those sites is theirs to add.
- The 90 ms suppression window assumes a human cannot press the same button twice
  within it; a machine-generated double press from one source is intentionally not
  throttled by the gate (the engine's own debounce owns that).
- No new npm/cargo dependencies; no changes to locks, capabilities, CSP, workflows;
  TLS/HMAC/replay/Host-Origin/cert gates untouched; no global hooks, no process
  killing, no window enumeration, no DRM/browser-security bypass.
