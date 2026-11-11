# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Active branch: `feat/velora-night-build-2`.
- Latest tested implementation commit: `f6d63e4de93c40aea2dd51f6a6f2f02605154aad`.
- Local stage-16 implementation commit `adf81a6893538385330365233986d30bb4748a0a` is preserved under `refs/codex/local/backspace-text-edit-stage-16`; its tree matches the published implementation.
- Local stage-15 implementation commit `2445c8dfd7ea8c84128ef75b27383f9808658f26` is preserved under `refs/codex/local/remote-offline-race-stage-15`; its tree matches the published implementation.
- Local stage-14 implementation commit `689ab0dff82ea0cc6712da4999e55121f67e8812` is preserved under `refs/codex/local/remote-resume-status-stage-14`; its tree matches the published implementation.
- Local stage-13 source commit `119db2a7138f4c6cad2912ce8e3ed0944532366a` is preserved under `refs/codex/local/modal-focus-handoff-stage-13`; its tree matches the published commit.
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
- Added a retry for the read-only iPhone Remote status check; pairing and server actions remain hidden until the retry succeeds.
- Improved the visible focus ring for Control Center buttons and inputs, and gave pressed controls a clearer gold state. The tab navigation regression test now verifies that focus follows the selected tab.
- Focus returns to the selected dock item when Control Center closes, including the gamepad/options toggle. Switching directly to Diagnostics preserves focus in the new dialog.
- Made modal focus restoration conditional so switching between Control Center and Diagnostics does not steal focus. Added a regression test for the handoff.
- iPhone Remote rechecks its read-only server and pairing status when the PWA becomes visible again; hidden-page transitions do not trigger a request. The service-worker cache key was bumped.
- iPhone Remote invalidates pending status reads when the browser goes offline, so a late response cannot replace the offline message or revive stale pairing UI. Added a regression test and bumped the service-worker cache key.
- TV navigation now leaves Backspace available for editing text in inputs, selects, textareas, and contenteditable targets while preserving Backspace/BrowserBack navigation elsewhere.
- React tests: 24 files, 119 tests passed. TypeScript and Vite production build passed.
- GitHub Actions run [43026294733](https://github.com/Milklosz/nexus-aurea/actions/runs/43026294733) passed on Windows and macOS, including React, Rust, TypeScript/Vite, and platform builds. The Release job was skipped.
- GitHub Actions runs [43029135952](https://github.com/Milklosz/nexus-aurea/actions/runs/43029135952) (stage 09), [43029773813](https://github.com/Milklosz/nexus-aurea/actions/runs/43029773813) (stage 10), [43030395848](https://github.com/Milklosz/nexus-aurea/actions/runs/43030395848) (stage 11), [43031259001](https://github.com/Milklosz/nexus-aurea/actions/runs/43031259001) (stage 12), [43032589406](https://github.com/Milklosz/nexus-aurea/actions/runs/43032589406) (stage 13), stage 14 [43033436829](https://github.com/Milklosz/nexus-aurea/actions/runs/43033436829), and stage 15 [43035329173](https://github.com/Milklosz/nexus-aurea/actions/runs/43035329173) passed on Windows and macOS. Stage-16 run [43036042119](https://github.com/Milklosz/nexus-aurea/actions/runs/43036042119) is running.
- The artifact below is from the earlier, fully passing stage-08 checkpoint.
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

Review stage-16 CI, then continue with another small VELORA navigation or Remote improvement and regression test. Keep GUI review marked `NOT TESTED` unless a supported, policy-compliant path becomes available; keep iPhone Remote safely disabled by default.
