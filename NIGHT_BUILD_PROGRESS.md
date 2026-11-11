# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Active branch: `feat/velora-night-build-2`.
- Latest tested implementation commit: `931873f9923201d943583a0d3ea61ef3d2dc57dc`.
- Local stage-09 source commit `3aa2d34e9000428a769356dc9603e198a9b57ae6` is preserved under `refs/codex/local/remote-status-fail-closed-stage-09`; its tree matches the published commit.
- Local stage-08 commit `8390a6555aa573063ff2d92bd0f9c6077082abc2` is preserved under `refs/codex/local/feat-velora-remote-storage-stage-08`; its tree matches the published commit.
- Verified base commit: `6dbcc36abeded18b753a134bc8ede10fb37df391`; exact base tree `ea6aa33175216fd51036676c20aadc7ddd7e5773`.
- Draft PR: [#13](https://github.com/Milklosz/nexus-aurea/pull/13), targeting `feat/aurea-v0.9.1-secure-iphone-remote`.

## Completed

- Preserved Control Center, dock, HBO Max, TV navigation, and Steam Big Picture changes.
- Secured all 12 original Night Build 2 files, SHA-256 manifest, and patch outside the source checkout.
- Saved each implementation continuation as a patch and file copy outside the source checkout.
- Added per-service duplicate-launch protection with accessible busy feedback.
- Added Polish retry guidance for website opener failures while preserving unsafe-address validation.
- Added Windows app launch guidance for missing executables, permission errors, and other spawn failures.
- Gamepad polling stops while VELORA is unfocused or input is suspended, and resets held/repeat state before resuming.
- Control Service diagnostics classify the foreground process as VELORA, Steam, external, or unknown. Steam is advisory; no controller ownership is claimed.
- While Control Service is running, non-VELORA or unknown foreground states suspend local Gamepad polling. With the service off, existing behavior is unchanged.
- iPhone Remote now fails closed if IndexedDB cannot read the secure device-key record: the pairing form remains hidden, pairing is disabled, and no commands can be sent. The service-worker cache key was bumped so the PWA fetches the updated script.
- Control Center now treats an unreadable iPhone Remote status as unknown, shows an error, and hides all remote actions until a fresh status arrives.
- React tests: 24 files, 116 tests passed. TypeScript and Vite production build passed.
- GitHub Actions run [43026294733](https://github.com/Milklosz/nexus-aurea/actions/runs/43026294733) passed on Windows and macOS, including React, Rust, TypeScript/Vite, and platform builds. The Release job was skipped.
- CI for the stage-09 commit is pending; the artifact below is from the prior, fully passing stage-08 checkpoint.
- The currently installed MSI copy was only opened for visual inspection. Its Control Center is the older long-list layout; it was closed afterward. No installed files or settings were changed.

## Artifact record

- Prior-checkpoint Windows CI artifact from run [43026294733](https://github.com/Milklosz/nexus-aurea/actions/runs/43026294733): `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-92d942a17173f8af3e244995d9c409df94716897.zip`.
- ZIP SHA-256: `ff512ee2a362516a3a067d9655597643b62346e106a3837fe9002b9af01a9eb9`.
- Extracted installer (not run): `C:\Users\milos\Documents\Codex\VELORA_0.9.2_x64-setup-92d942a17173f8af3e244995d9c409df94716897.exe`.
- Installer SHA-256: `eab9905c006b3beef847a0e063e8dafd336b0b2a07386ae48181eac917a108ac`; Authenticode status: `NotSigned`.
- Checksum sidecar: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-92d942a17173f8af3e244995d9c409df94716897-SHA256.txt`.
- No installer was executed or installed; the existing MSI installation remains untouched.

## Blockers

- Codex artifact attachment for PR #13 did not return; the Draft PR remains available at the link above.
- Git CLI push stalled during authorization. Commits were published with GitHub tools after verifying each expected remote SHA; updates were fast-forward only.
- The controller signal is process-based and has not been validated against Steam Input ownership on the MSI. The installed VELORA was not replaced.
- Local Tauri development launch is blocked because `cargo` is not installed on this machine.
- Computer Use stopped when it could not confidently determine the browser URL. GUI review is `NOT TESTED`; this tool will not be retried or bypassed. The installed copy's old panel was inspected and then closed without changing installation state.

## Next step

Review CI for stage 09, then continue with a small, testable Control Center or TV-navigation improvement directly in source. Keep GUI review marked `NOT TESTED` unless a supported, policy-compliant path becomes available; keep iPhone Remote safely disabled by default.
