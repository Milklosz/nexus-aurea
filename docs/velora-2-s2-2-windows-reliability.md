# S2.2 Windows reliability

## Preserved mechanisms

Existing current-user autostart registration remains explicit opt-in through AutostartPanel. This work does not enable it, alter the Windows shell or add a service. Existing single-instance handling, LaunchRegistry process identity, SessionOrchestrator persistence/recovery and Home restore guards remain authoritative. Existing streaming ownership checks and controller supervisor are preserved.

TV startup restoration is bounded to native available monitor enumeration. Missing saved displays fall back to a decorated primary-display window. `--windowed` must take precedence over saved placement and topology callbacks. No busy startup wait, restart loop, persistent watchdog or global display/audio mutation is introduced. Network, Steam, Playnite and controller availability are still represented by their existing independent status/error routes.

The local restart action uses Tauri `request_restart` so the normal Exit callback runs. At the end of that callback, after stopping VELORA workers, the single-instance module atomically closes only its own named-mutex handle. This corrects the observed rc.1 race where the replacement process saw the old process's guard and exited as a duplicate. Normal secondary launches remain excluded while VELORA runs. The new isolated native test uses a separate test mutex, never the live application's guard. Original startup arguments, including `--windowed`, follow Tauri's supported restart path. A broken event loop that forces Tauri's exceptional direct-restart fallback remains outside the verified recovery claim.

## Exit and rollback

Use the existing local desktop/minimize and normal exit controls. F11/Escape window recovery follows existing behavior. For a candidate failure, close the candidate normally and reopen the unchanged installed VELORA; do not uninstall or delete settings. Disable autostart only through the explicit existing setting if it was previously enabled by the user. This increment adds no automatic startup registration and requires no cleanup of system services.

## Unverified

Windows login startup, crash/relaunch behavior with third-party apps, display disconnect and installer upgrade/rollback require separate validation. Computer Use now works in the follow-up; actual candidate-specific results are recorded in its scenario matrix, without any physical DS4/iPhone/TV success claim. Build and installer evidence belongs to the integrated release-gate report. No persistent watchdog or automatic VELORA crash restart is implemented.
