# S2.1 Control Center: native audio controls

Status: IMPLEMENTED; automated and live verification recorded separately in program results.

`AudioControls` is a compact scoped component for Control Center. It reads the Windows default console render output, its friendly name, master volume and mute. Explicit buttons change volume by five percentage points or set mute; successful controls display native readback. No optimistic success, volume key injection, default-output change, app-volume adjustment, or global display/audio preference changes are introduced.

The new `audio_control` commands reuse `display_audio`'s COM apartment, Core Audio enumeration, bounded friendly names and hashed endpoint IDs. UI writes include the displayed endpoint hash. A newly selected system default output rejects a stale command instead of changing an unseen device. Invalid/non-finite/out-of-range numbers fail before Windows access. No raw endpoint path leaves native code. Core Audio errors remain recoverable and no retry repeats a mutation.

Refresh occurs on mount, explicit refresh, window focus, or return to visible state. There is no new timer or polling loop. Only one operation can be in flight. A denied command clears the old snapshot and requires another read. Writes require deliberate UI input; development tests do not change the machine volume.

## Integration

Register `mod audio_control;` and commands `audio_control::get_system_audio`, `audio_control::set_system_audio_volume`, `audio_control::set_system_audio_mute`. Render `<AudioControls />` inside Control Center's supported navigation/remote container. Native commands are local Tauri IPC; no unauthenticated LAN endpoint is added. Existing paired remote DOM navigation may reach the component through current permission routing.

## Verification boundaries

Service tests cover IPC identity, invalid values, unsupported browser behavior and failure propagation. Panel tests cover explicit actions, actual readback, serialization, denial recovery and refresh cleanup. Rust tests cover native numeric and endpoint validation. Physical HDMI output, actual master-volume behavior and Computer Use read/change/restore remain hardware/runtime checks. If the output disappears or refuses endpoint control, UI reports the error; it does not claim success.

Output selection is intentionally unavailable: Windows does not provide a supported public default-output setter in the current project. Existing display/audio diagnostics continue to enumerate outputs independently and remain read-only.
