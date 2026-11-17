# S2.4 Controller Simulator 2.0

## Scope and evidence

Candidate version: **0.12.0-rc.1**. The simulator is a local diagnostic client of the existing normalized native action pipeline. It does not implement a second Windows input dispatcher. The native debug build must advertise `simulatorAvailable`; browser preview and release builds cannot enable native simulator input. The panel remains inside `data-remote-admin`, which the iPhone Remote selection policy denies. No simulator command was added to the LAN vocabulary.

Open the isolated debug candidate, then **F2** or **Control Center → Diagnostyka**. Installed VELORA, user settings and physical DS4 are outside this setup. Native Home must already be running and enabled for this session; enabling the simulator does not enable Home implicitly.

This document describes source behavior and automated validation. It does not establish real service compatibility. Runtime results belong in the S2.4 Computer Use report with the tested executable/source identity.

## Setup versus controller workflow

1. Select **Włącz symulator diagnostyczny**.
2. Choose a known service and **Otwórz usługę testową**, or use a service already opened through VELORA. The launcher uses the existing service registry, never an imported URL.
3. Return to the panel, select **Odśwież sesje symulatora**, and choose the intended resumable Cinema session. Native capture resolves its ownership; the frontend supplies no HWND or PID.
4. Choose Automatic, Keyboard, Spatial or Pointer. Explicitly arm media shortcuts for this session only after inspecting an actual player.
5. Use simulator controls or a reviewed sequence. Inspect the real service after each meaningful action, then annotate the result.

Computer Use may click simulator controls to generate normalized actions. Ordinary mouse clicks, typing or keyboard shortcuts **inside the streaming page** are setup/intervention and must be reported separately. Search text entered with ordinary Computer Use is not a controller-only search. There is no arbitrary text-entry or credential command in the simulator contract. Existing authentication may be used, but credentials are never requested or recorded.

## Native contract

The existing Tauri commands remain unchanged:

| Command | Purpose |
| --- | --- |
| `get_tv_navigation_status` | Availability, generation, sequence high-water mark, mode, strategy, target/media status and `simulatorHomeReady` |
| `configure_tv_navigation` | Explicit diagnostic enable and mode |
| `capture_tv_navigation_target` | Resolve and pin one managed session |
| `simulate_tv_navigation_action` | One allowlisted semantic action with `sequence`, `generation`, `targetSession`, optional `deltaX`/`deltaY` |
| `cancel_tv_navigation_simulation` | Revoke the current native generation |
| `set_tv_navigation_media_controls` | Explicit media arm/disarm bound to one owned session |

Dispatch is serialized. The caller advances the sequence above the backend high-water mark and uses the generation from the latest receipt. Rejection or exception stops the remaining sequence without retry. Before native input, the backend revalidates the owned session and foreground context. It must reject unrelated windows.

Home uses the existing Home worker, independently of keyboard/spatial/pointer strategy. It is not proof that Bluetooth delivers the physical PS button. Physical L1/R1 retain their existing fallback Home meaning; simulator L1/R1 section controls are compatibility probes, not a changed hardware mapping.

**Home ends the current segment.** The normal App Home handler closes diagnostics and unmounts the simulator so the real Home screen remains usable. There is no hidden runner or post-Home input. A bounded, sanitized in-process snapshot preserves up to 64 recorded steps/receipts and the remaining reviewed continuation. It contains no original session IDs/raw errors and is not written to storage. Recording does not restart automatically when the panel reopens.

Reopen diagnostics and refresh status. Native `simulatorHomeReady === true` requires the latest successful Home completion revision, authoritative `veloraHome` state and current trusted-main focus. Until it is true, **Wznów pozostałe kroki po Home** remains disabled; a pending Home is not automatically classified as failed. Explicit Resume uses current generation/sequence and recaptures the next tagged service, even when it is the same service. Readiness is recorded separately as `homeTransitionReady`; accepted/queued Home alone never satisfies it. Full automatic multi-service replay is therefore **PARTIAL by design**, with an explicit local resume boundary.

## Timing, holds and analog

- Normal button actions wait **600 ms** before dispatch, allowing the initiating mouse button to release.
- Sequences contain at most **64** actions; each delay is **100–1000 ms**. There is no loop instruction.
- Semantic holds permit only directions, scroll or pointer movement. Duration is clamped to **100–5000 ms**, interval to **100–1000 ms**; the first pulse waits 600 ms. Actual wall time additionally includes native command latency and any review pauses.
- Analog simulation accepts axes −1…1, uses a **0.18** dead zone and emits bounded pointer pulses, at most **32 units per axis**. Precision uses at most **8 units**. Windows geometry, DPI conversion and final pointer bounds remain native responsibilities.
- A simulated hold is a sequence of normalized actions. It does not reproduce raw HID timing or establish physical analog latency, DS4 dead-zone calibration or PS delivery.

The busy guard prevents overlapping runs. There is no continuous UIA polling or unbounded replay loop.

## Record, inspect, export and replay

**Nagrywaj akcje symulatora** records accepted actions until stopped or the 64-step limit is reached. Each step retains its public service ID where known, semantic action, delay and pointer delta. Session IDs, page content and native errors are not recorded. The bounded snapshot survives closing/reopening diagnostics in the same process; it is not persisted to disk and is lost on application exit.

**Eksportuj sekwencję · JSON** produces sequence **schemaVersion 1**. Copy it into **Import sekwencji JSON**, then select **Wczytaj sekwencję do przeglądu**. Import accepts at most **32 KB**, 1–64 known actions, five known service IDs, bounded integer delays and pointer coordinates. It discards supplied target IDs, handles, process fields and checkpoint flags. Import only loads the sequence; it sends no input.

**Odtwórz nagranie** executes the reviewed list until rejection, cancellation, a review checkpoint or Home. A service-tagged step resolves exactly one currently listed resumable Cinema session for that service. Missing or ambiguous sessions stop replay. Switching services captures the new native target and generation. Home retains the remaining list for explicit Resume after reopening/readiness; it never continues in the background. No service is launched, logged into or purchased through an imported instruction.

Before replayed `confirm`, `click`, `pointerClick`, play/pause, seek, fullscreen, captions or player mute, execution pauses at a local screen-review checkpoint. **Wykonaj sprawdzony krok** permits that one semantic action. Review requirements are calculated locally and cannot be disabled by JSON. Inspect the service before continuing; never approve a purchase, rental, subscription or account change. Ordinary navigation steps do not require per-step approval.

Example portable navigation regression:

```json
{
  "schemaVersion": 1,
  "steps": [
    { "action": "down", "serviceId": "youtube", "delayMs": 600 },
    { "action": "right", "serviceId": "youtube", "delayMs": 600 },
    { "action": "back", "serviceId": "youtube", "delayMs": 600 },
    { "action": "home", "serviceId": "youtube", "delayMs": 600 }
  ]
}
```

This is a reproducible command sequence, not a guaranteed catalog path. Page state, focus, consent overlays and service updates can change the visible outcome. Do not assume that Down/Right selected a title because native dispatch succeeded.

## Reproducible validation workflows

| Workflow | Procedure and required observation |
| --- | --- |
| Navigation + Home | Start on the documented YouTube public surface with a captured session. Run the example. Observe directional/Back effects and final VELORA Home. A rejected Home is a failed workflow, even if later restored with a mouse. |
| Pointer geometry | Select Pointer, issue analog pulses, then inspect the cursor against visible controls and window edges. Use precision pulses before one reviewed click on a harmless public navigation target. Record actual screen coordinates/DPI separately. A moving cursor alone does not verify hit testing. |
| Playback | On a legitimately opened public player, arm the exact session. Record play/pause, seek, fullscreen and Home individually. Replay pauses before media. Observe time progression, pause/resume and fullscreen rather than inferring them from receipts. Never bypass ads. |
| Two-service regression | Open both services through VELORA and refresh sessions. Record directions/Back/Home for one service, reopen diagnostics, capture the other, then record its actions. Export/import and replay the service-tagged sequence. At Home, reopen diagnostics, confirm readiness and explicitly Resume. Report this as a segmented/PARTIAL automatic workflow, and record any service-page manual refocus or repair separately. |
| Cancellation | Start a hold or replay, then cancel before a pending step or at an activation checkpoint. Confirm no later queued action occurs. A command already delivered may still take effect. |
| Focus denial | During a queued delay, foreground an unrelated test window as explicit setup. Observe rejection and absence of input in that window. Do not use account/payment dialogs for this test. |

Netflix, Disney+, Max and Prime Video use the same semantic contract. Public-page navigation does not establish protected-catalog or playback support. Authentication-dependent steps remain BLOCKED when no legitimate session is available. Physical DS4 workflows remain NOT TESTED/BLOCKED until authorized separately.

## Cancellation and asynchronous effects

**Anuluj sekwencję** cancels the pending delay or review wait, invalidates the local run lease, removes pending continuation and requests native generation revocation. Controls remain busy until cancellation settles. Closing a panel during an ordinary active run also requests cancellation. A dispatched Home is already the final segment boundary: its normal overlay unmount does not revoke that Home transaction, and no later action is queued. An idle panel does not revoke unrelated real-controller activity.

The UI states that an action already accepted by Windows may have taken effect. A late receipt can be retained, but cannot start another step. A failed native cancellation acknowledgement is reported; queued frontend steps still stop. There is no automatic retry after an unknown outcome.

Home acceptance is asynchronous. Its receipt alone does not prove that VELORA is visible, that streaming is closed or that subsequent session activation is ready. On reopening/refresh, the native readiness status gates explicit Resume; visible UI acceptance still belongs in the Computer Use report. It does not claim that the streaming process was closed.

## Evidence schema and interpretation

**Eksportuj zgodność TV · JSON** produces receipt **schemaVersion 2**, at most 64 records. It separates:

1. `source: simulator` and the normalized action;
2. native `commandAccepted`, strategy, ownership and dispatch duration;
3. native `effect`, which may remain unverified;
4. `effectObservation` (`notChecked`, `observed`, `notObserved`) attributed to `localOperator`;
5. `physicalHardwareVerified: false`.

Use **Efekt widoczny**, **Brak widocznego efektu** or **Efekt niesprawdzony** only after inspecting the last action. These are manual annotations, not a native playback-state probe.

When UIA was attempted, receipts can include provider/focus availability, visited/candidate counts, fixed rejection counters, query duration, budget exhaustion and cache use. `fallbackActivated: true` means a sticky Pointer-mode policy switch with a generation change: the failed spatial action remains rejected and is not replayed, moved or clicked. False means no policy switch. The allowlisted reason explains the decision. The next explicit input uses the new mode/generation; Activation/Invoke is never silently repeated through a second strategy.

Exports use fixed field/code allowlists. Raw errors, URLs, page names/text and session identifiers are omitted. Unknown free-text codes become `redacted`; invalid diagnostic counters become null. Exports are displayed locally and are not uploaded or saved automatically.

## Home integration correction

Source inspection found that the inherited native Home/Control Center simulator preflight required VELORA itself to be foreground, while preceding streaming actions foreground the captured Edge window. S2.4 permits the trusted local main or the exact current captured managed target and rechecks context before dispatch. It preserves the existing Home worker and rejects unrelated windows.

Integration review also found that App's `useReturnHomeListener` unconditionally closes diagnostics, unmounting the component. Component-only readiness polling could therefore never establish continuous replay. S2.4 preserves the real overlay-close behavior, ends the segment at Home and retains only bounded sanitized memory. An integration test uses the actual Home-listener hook with the same conditional unmount pattern: receipts/recording survive even when the native receipt resolves after unmount; no later input occurs; reopening with readiness false cannot resume; explicit Resume after readiness recaptures the same service. No App/overlay-retention exception was introduced. Automatic multi-service acceptance remains PARTIAL.

## Automated checks

Targeted tests cover sequence import bounds and semantic allowlists, discarded target/checkpoint fields, analog dead zone/precision, hold bounds, rejection stopping repeats, record/export/replay, review checkpoint cancellation, service-switch generation propagation, local-only/LAN denial, operator-effect separation and diagnostic redaction. TypeScript and targeted whitespace validation passed during implementation. Full-suite and exact-build runtime results are recorded separately.
