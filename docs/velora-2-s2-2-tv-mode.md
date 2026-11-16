# S2.2 TV mode

## Implemented

`tv_mode.rs` uses Tauri native monitor enumeration and the main VELORA window exclusively. A monitor identity hashes its actual native name, physical position and size; neither the frontend nor a remote client supplies coordinates or executable paths. A changed resolution or topology can invalidate the saved identity and requires reselecting the available display. HDMI transport and Panasonic identity are not guessed from display numbers.

`get_tv_mode_status` reports available physical displays, primary/current placement, scale and current fullscreen status. `set_tv_mode` resolves an opaque ID against fresh native enumeration, then moves only the main VELORA window. Fullscreen and decorated windowed recovery are explicit local UI actions. Settings use a small versioned file containing only selected identity and fullscreen preference; writes use a pending file and rename. No Windows topology, resolution, audio endpoint or shell registry setting is changed.

`restore_tv_mode` is a bounded recovery helper for startup and the existing display-monitor topology event. When the saved display is disconnected, it returns VELORA to a decorated window on the actual primary display. No new polling thread or watchdog is introduced. Integration must skip persisted restoration when `--windowed` is present, including topology callbacks, so emergency windowed startup retains priority. When a saved screen reconnects, restoration can reuse the still-preserved identity.

The TV panel is marked `data-remote-admin`, preserving local-only system/window configuration. Native keyboard/controller actions in local VELORA remain available. Read-only audio and monitor diagnostics remain separate from opt-in configuration.

## Verification and limits

Frontend tests cover browser unsupported state, explicit selection only, argument validation, windowed escape, native identity selection, remote administrative boundary and honest disconnected-screen errors. Native pure tests cover identity changes, malformed IDs and strict preference fields. Full native compilation and integrated tests are recorded by the program owner. Live movement, HDMI/audio, mixed-DPI behavior and Panasonic reconnect are NOT TESTED; Computer Use is BLOCKED. The helper returns failures without inventing success, but there is no hardware acceptance claim. A monitor name/geometry identity is conservative and may require reselection after Windows rearranges screens; it is not an EDID hardware identity.
