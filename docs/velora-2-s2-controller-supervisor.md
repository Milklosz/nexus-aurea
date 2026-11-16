# S2 controller supervisor

## Scope and ownership

Windows controller input remains owned by the existing `PadHub` Raw Input
thread and its single message-only window. The window registers joystick and
gamepad collections with `RIDEV_INPUTSINK | RIDEV_DEVNOTIFY`, so the same pump
receives reports while VELORA is in the background and observes device arrival
and removal. The supervisor adds no second Raw Input registration, global
keyboard hook, driver, or OS-wide setting.

`ds4.rs` identifies and parses supported DualShock 4 reports. The browser receives
semantic controller state only. The streaming bridge receives a parsed
`Ds4Report` and an opaque hashed device label from the same pump; raw HID bytes
and device paths are not forwarded.

## Home gestures and gates

The existing DS4 Home chord is PS + Options. It remains subject to the effective
session Home setting: an explicit session override takes precedence over the
Control Service setting. Its chord tracker is disabled internally whenever the
fallback is enabled, while `NativeControllerStatus.homeEnabled` continues to
report the session Home setting. The separate `primaryChordSuppressed` field
reports that PS + Options is suppressed by the fallback configuration.

The fallback is disabled by default. Enabling it selects the provisional
L1 + R1 + Options gesture and a hold of 1.5, 2, or 3 seconds. The mapping has
**not been validated on a physical controller**. A deliberate hold triggers at
most once until all three buttons are released and the device rearms from a
neutral report.

The fallback requires both gates below:

1. The user or Control Service has enabled the session Home setting
   (`homeGateOpen`).
2. The session orchestrator is outside `VeloraHome` (`sessionGateOpen`).

Changing either gate invalidates an in-progress hold and requires a new neutral
sample. The fallback and primary DS4 chord therefore cannot dispatch Home for
the same input sequence. Home requests use the existing bounded session
transaction and safe foreground restore path; the chord does not close an
external application.

## Configuration and status API

The Tauri commands are `get_controller_fallback_status` and
`configure_controller_fallback`. The configuration payload is:

```json
{
  "enabled": true,
  "gesture": "l1R1Options",
  "holdMs": 2000
}
```

To disable it, send `enabled: false` and `gesture: "disabled"`. The command
accepts only the three documented hold durations and rejects inconsistent
enabled/gesture pairs. Configuration is in memory for the current application
session; it does not change Steam, Windows, or controller settings.

Status reports the effective config, the physical validation note, primary
chord suppression, neutral arming state, connected and holding devices,
streaming suppression count, last trigger time, both gates, and the latest
supervisor outcome. Native report and hold timestamps are monotonic elapsed
milliseconds from the process clock; they are diagnostic durations, not Unix
timestamps.

## Reconnects, silence, and bounded work

Fallback timers are keyed per hashed DS4 device. Reports from two controllers
cannot combine into one gesture. A device removal, a configuration change, a
gate transition, or more than 750 ms without a report clears the current hold
and requires a neutral report before another hold can start. HID arrival and
removal, native queue overflow, and a DS4 silence gap also invalidate queued
streaming reports. A resumed report is checked for a gap before it reaches the
streaming bridge, even if the message pump has not run its periodic silence tick.
The native DS4 tracker emits one neutral release on silence and resets that
device's pending primary PS + Options state at the same time.

The pump continues to process controller input and dispatch Home asynchronously:

- DualSense reports for the Control Service use the existing bounded 64-item
  queue. `try_send` never blocks the Raw Input pump; overflow advances an epoch
  so queued chord fragments cannot be combined with newer input. The consumer
  drains at most 64 envelopes per turn.
- Home return requests use the existing bounded 8-item session worker queue.
- Parsed DS4 reports reach the streaming bridge through its bounded 8-item
  queue. The pump-side route is nonblocking and the bridge applies its own rate
  limit, stale-packet checks, and foreground ownership checks. Either native raw
  queue overflow or streaming queue saturation invalidates the controller epoch
  so older queued input cannot continue a stale interaction.

The device handle cache is capped at 64 entries. When it is full, new handles
are ignored rather than clearing live handle-to-path mappings and orphaning
tracked input state.

## Verification status

Synthetic unit tests cover disabled-by-default config, the unvalidated mapping,
the minimum hold and one-shot release/rearm, per-device isolation, disabled Home
and active-session gates, invalid config, and stale-report rearming. Hub tests
cover background delivery of full parsed reports and suppression of the primary
DS4 chord while fallback is enabled.

**Physical DualShock 4 USB/Bluetooth behavior and the L1 + R1 + Options mapping
remain not tested on hardware.** Synthetic tests do not establish the mapping,
Raw Input delivery on the target laptop, Steam coexistence, or foreground
restoration behavior on the target machine.
