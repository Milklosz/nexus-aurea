# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Active branch: `feat/velora-night-build-2`.
- Latest tested implementation commit: local `6cc616cdf0848877c46cab5cf7af23659561f67d`, published as `9331c6c075296156d37548e305522e497047a646`; their trees match.
- Local stage-28 implementation commit is preserved under `refs/codex/local/control-service-stop-feedback-stage-28`.
- Local stage-27 implementation commit is preserved under `refs/codex/local/control-service-initial-status-race-stage-27`.
- Local stage-26 implementation commit remains preserved under `refs/codex/local/control-service-emergency-stop-stage-26`.
- Local stage-24 implementation commit `3ca7b50b565bda5197d45aefb9f1f1230a9b5db3` is preserved under `refs/codex/local/gaming-launch-failure-status-stage-24`; its tree matches published commit `a1f8de1176117bfe2da24c0a661c665b02109e50`.
- Local stage-23 implementation commit `fdadd1e1e26effcd9cbfaff570f4f3d90eb89e62` is preserved under `refs/codex/local/gaming-launch-status-stage-23`; its tree matches published commit `c345a500339e4096e16427b9f0280b69781d4dff`.
- Local stage-22 implementation commit is preserved under `refs/codex/local/remote-offline-command-race-stage-22`.
- Local stage-21 implementation commit `b3cd86440621d33d2251eac8d508d3872c0ec066` is preserved under `refs/codex/local/remote-command-feedback-stage-21`; its tree matches published commit `611acc37d31db2a8c47c279db782fcadc962133f`.
- Local stage-20 implementation commit `0f196da0076e9d89d9a39b1a9ab56d9200eb905f` is preserved under `refs/codex/local/remote-command-status-stage-20`; its tree matches published commit `a2bd3208ec114b94a4bbed8d212bb8f5bf4d92f3`.
- Local stage-19 implementation commit `de31db486e07a1f9ba56216dd20481d5dd2b0ebe` is preserved under `refs/codex/local/remote-home-restore-stage-19`; its tree matches the published implementation.
- Local stage-18 implementation commit `4f876cc19540e802dbb8c40cd85cdb7d8602563f` is preserved under `refs/codex/local/remote-home-focus-stage-18`; its tree matches the published implementation.
- Local stage-17 implementation commit `329fcfc499a0a952baa115072798f3564d307b12` is preserved under `refs/codex/local/dialog-form-navigation-stage-17`; its tree matches the published implementation.
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
- Controller and keyboard navigation inside dialogs now includes enabled checkboxes and other form controls, skips disabled/hidden controls, and lets text inputs and selects handle their native arrow-key editing.
- The iPhone Remote Home command closes open panels and safely requests VELORA window focus. Windows focus refusal is caught and announced with an Alt+Tab fallback; app-return handlers use the same safe focus helper.
- iPhone Remote Home now unminimizes VELORA before focusing it. Added the narrowly scoped Tauri unminimize capability and a test for restore/focus ordering and failure handling.
- iPhone Remote announces the command being sent through its live status message while the remote controls are temporarily disabled. Added a pending-command regression test and bumped the service-worker cache key.
- iPhone Remote now uses the same localized command label while sending and after successful delivery. Added the completion assertion and bumped the service-worker cache key.
- iPhone Remote invalidates pending command UI updates when the iPhone goes offline, so a late response cannot overwrite the offline status. Added a regression case and bumped the service-worker cache key; commands are never retried automatically.
- Gaming Hub now announces pending Steam Big Picture, Playnite, and game launches, and exposes busy state on each launch button. Added a pending-launch accessibility regression test.
- Gaming Hub clears its pending live status when a Steam, Playnite, or game launch fails, leaving the error alert as the current message.
- Control Service actions announce pending work and the resulting state, expose busy status on both controls, and clear pending feedback after errors.
- The emergency-stop event invalidates pending Control Service action results, immediately clears busy state, and prevents an older operation finalizer from clearing a newer action busy state.
- The initial Control Service status read is ignored if an emergency-stop event arrives before that read resolves, so stale startup data cannot revive the stopped state.
- Any Control Service stop event clears the pending action announcement; an unexpected stop leaves its error visible without a stale “updating” message.
- Latest local React run: 25 files, 131 tests passed. TypeScript and Vite production build passed.
- GitHub Actions run [43026294733](https://github.com/Milklosz/nexus-aurea/actions/runs/43026294733) passed on Windows and macOS, including React, Rust, TypeScript/Vite, and platform builds. The Release job was skipped.
- GitHub Actions runs [43029135952](https://github.com/Milklosz/nexus-aurea/actions/runs/43029135952) (stage 09), [43029773813](https://github.com/Milklosz/nexus-aurea/actions/runs/43029773813) (stage 10), [43030395848](https://github.com/Milklosz/nexus-aurea/actions/runs/43030395848) (stage 11), [43031259001](https://github.com/Milklosz/nexus-aurea/actions/runs/43031259001) (stage 12), [43032589406](https://github.com/Milklosz/nexus-aurea/actions/runs/43032589406) (stage 13), stage 14 [43033436829](https://github.com/Milklosz/nexus-aurea/actions/runs/43033436829), stage 15 [43035329173](https://github.com/Milklosz/nexus-aurea/actions/runs/43035329173), stage 16 [43036042119](https://github.com/Milklosz/nexus-aurea/actions/runs/43036042119), stage 17 [43036705267](https://github.com/Milklosz/nexus-aurea/actions/runs/43036705267), stage 18 [43039325451](https://github.com/Milklosz/nexus-aurea/actions/runs/43039325451), and stage 19 [43040038281](https://github.com/Milklosz/nexus-aurea/actions/runs/43040038281) passed on Windows and macOS.
- GitHub Actions runs [43043218481](https://github.com/Milklosz/nexus-aurea/actions/runs/43043218481) (stage 20), [43043740999](https://github.com/Milklosz/nexus-aurea/actions/runs/43043740999) (stage 21), and [43045040872](https://github.com/Milklosz/nexus-aurea/actions/runs/43045040872) (stage 22) passed on Windows and macOS; the Release jobs were skipped.
- GitHub Actions runs [43047036322](https://github.com/Milklosz/nexus-aurea/actions/runs/43047036322) (stage 23) and [43047629891](https://github.com/Milklosz/nexus-aurea/actions/runs/43047629891) (stage 24) passed on Windows and macOS; Release was skipped.
- Stage 25 GitHub Actions run [43048341666](https://github.com/Milklosz/nexus-aurea/actions/runs/43048341666) passed on Windows and macOS; React, Rust, TypeScript/Vite, and platform builds succeeded. The Release job was skipped.
- Stage 26 GitHub Actions runs [43051591281](https://github.com/Milklosz/nexus-aurea/actions/runs/43051591281) (PR) and [43051579122](https://github.com/Milklosz/nexus-aurea/actions/runs/43051579122) (push) passed on Windows and macOS; Release was skipped.
- Stage 27 GitHub Actions runs [43053322359](https://github.com/Milklosz/nexus-aurea/actions/runs/43053322359) (PR) and [43053309991](https://github.com/Milklosz/nexus-aurea/actions/runs/43053309991) (push) passed on Windows and macOS.
- Stage 28 push run [43053998764](https://github.com/Milklosz/nexus-aurea/actions/runs/43053998764) is running.
- The currently installed MSI copy was only opened for visual inspection. Its Control Center is the older long-list layout; it was closed afterward. No installed files or settings were changed.

## Artifact record

- Latest Windows CI artifact for stage 26 from run [43051591281](https://github.com/Milklosz/nexus-aurea/actions/runs/43051591281), artifact ID `13870450916`: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-78b508367a26cb34872d751627898fa15bb9a490.zip`.
- ZIP SHA-256: `7f6e48aa33a08d1575988be3d7cf2d697f683c2d608d32dd00ea1801d2c108f1` (matches the GitHub artifact digest).
- Extracted installer (not run): `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-78b508367a26cb34872d751627898fa15bb9a490-extracted\VELORA_0.9.2_x64-setup.exe`.
- Installer SHA-256: `5704b5578e07a47b77cb710d0155f10a78771024550041b662dace365c3efc1b`; Authenticode status: `NotSigned`.
- Checksum sidecar: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-78b508367a26cb34872d751627898fa15bb9a490-SHA256.txt`.
- The stage-26 artifact digest matches the GitHub Actions artifact record; no installer was run or installed. The MSI installation remains untouched.
- Prior Windows CI artifact for stage 22 from run [43045040872](https://github.com/Milklosz/nexus-aurea/actions/runs/43045040872): `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-5ce71d8295d007940e8144a62cd69e28d4f4518f.zip` (SHA-256 `4c4029a24370116f33d057baec6ff765c3ce599dc657f6b5ef835dd63a1024e8`). Installer SHA-256 `6ca72f8eb0dbdefa94a4bd118510207986821d9c1c3d6779c89f9234690eb166`; Authenticode `NotSigned`; it was not run or installed.

## Recovery checkpoints

- Stage 20 archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage20-final.zip` (SHA-256 `5ec31fc950e230046915d3d0e2a6d184485fb52074c5068231cd4f06d7d5a8c1`).
- Stage 21 archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage21-final.zip` (SHA-256 `3d3331d0772d664b852cb89fbb27dc2bbfe57461e6b629d18a2e374bf1629b17`).
- Stage 22 standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-continuation22-final.zip` (SHA-256 `bb39338eec234f39c83696a92fabdf66b01701d3404295df415584bd73aae65f`).
- Stage 25 standalone snapshot: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage25-final.zip` (SHA-256 `3a2b3b09c3266722823689c501da6e6095909a9ed8d0737d53188ce09dbaf189`).
- Stage 26 standalone snapshot: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage26-final.zip`; checksum sidecar: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage26-final-SHA256.txt`.
- Full recovery snapshot through stage 26: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage26-final.zip`; checksum sidecar: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage26-final-SHA256.txt`. All 227 manifest entries were verified before the Stage 26 final progress snapshot; the final checksum sidecar records the refreshed archive.
- Stage 26 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-26` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-26.patch`; the final full snapshot and checksum sidecars are listed below.
- Stage 27 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-27` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-27.patch`; GitHub Actions passed on Windows and macOS.
- Stage 28 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-28` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-28.patch`; refresh the full snapshot after CI and the progress checkpoint.
- Prior Windows CI artifact for stage 19 from run [43040038281](https://github.com/Milklosz/nexus-aurea/actions/runs/43040038281): `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-fbbc0e52343fffd9c68369bc6dc3dfe969df187f.zip` (SHA-256 `f3dedafd2cb510cc7886be8598cd8776677cfe6684c56a40ddfba183b170bb13`).
- Stage-19 installer SHA-256: `983a2fb40e56761c8be8145dfb8a260cf531301bed95707166324d76cb5629b8`; Authenticode status: `NotSigned`; it was not run or installed.
- Prior Windows CI artifact for stage 17 from run [43036705267](https://github.com/Milklosz/nexus-aurea/actions/runs/43036705267): `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-3be7517542ad6b164d3001cc4a4aa4063ab1bc4b.zip`.
- ZIP SHA-256: `18aa95b26daced7ef3027a533c29bc3c999fcf44566a13397ef4f39974b709fa`.
- Extracted installer (not run): `C:\Users\milos\Documents\Codex\VELORA_0.9.2_x64-setup-3be7517542ad6b164d3001cc4a4aa4063ab1bc4b.exe`.
- Installer SHA-256: `3c55c84b75b69c30c7285e67dd55a898041681fd1f3dcc7db28b6e05c52b5f8c`; Authenticode status: `NotSigned`.
- Checksum sidecar: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-3be7517542ad6b164d3001cc4a4aa4063ab1bc4b-SHA256.txt`.
- The stage-17 installer was not run or installed.
- Prior-checkpoint Windows CI artifact from run [43026294733](https://github.com/Milklosz/nexus-aurea/actions/runs/43026294733): `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-92d942a17173f8af3e244995d9c409df94716897.zip`.
- ZIP SHA-256: `ff512ee2a362516a3a067d9655597643b62346e106a3837fe9002b9af01a9eb9`.
- Extracted installer (not run): `C:\Users\milos\Documents\Codex\VELORA_0.9.2_x64-setup-92d942a17173f8af3e244995d9c409df94716897.exe`.
- Installer SHA-256: `eab9905c006b3beef847a0e063e8dafd336b0b2a07386ae48181eac917a108ac`; Authenticode status: `NotSigned`.
- Checksum sidecar: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-92d942a17173f8af3e244995d9c409df94716897-SHA256.txt`.
- No installer was executed or installed; the existing MSI installation remains untouched.

## External integration checks

- The HBO Max launcher uses the official Polish page at [hbomax.com/pl/pl](https://www.hbomax.com/pl/pl).
- RustDesk was not detected as installed (command, common install paths, or uninstall entries). Mac remote-control setup is `NOT CONFIGURED`; development continues without it.

## Blockers

- Codex artifact attachment for PR #13 did not return; the Draft PR remains available at the link above.
- Git CLI push stalled during authorization. Commits were published with GitHub tools after verifying each expected remote SHA; updates were fast-forward only.
- The controller signal is process-based and has not been validated against Steam Input ownership on the MSI. The installed VELORA was not replaced.
- Local Tauri development launch is blocked because `cargo` is not installed on this machine.
- Computer Use stopped when it could not confidently determine the browser URL. GUI review is `NOT TESTED`; this tool will not be retried or bypassed. The installed copy's old panel was inspected and then closed without changing installation state.

## Next step

Stage 28 is locally tested, committed, and published; CI is running. Stage 29: announce emergency-stop feedback assertively to assistive technology while preserving polite announcements for routine actions. Keep GUI review marked `NOT TESTED`; keep iPhone Remote safely disabled by default.
