# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Active branch: `feat/velora-night-build-2`.
- Latest tested implementation commit: local `e88fbe0f5b86d6d51eb9fb92386e43e68ac9a118`, published as `137be5c68d6f5ee4d8d5aa2db5296716774ff2f7`; their trees match. Stage 41 retains the last known Windows library on refresh errors and blocks launches until recovery; 145 React tests and TypeScript/Vite build pass locally. GitHub Actions run 43080053138 passed on Windows and macOS.
- Latest tested implementation commit: local `62181463ba53fb0ec1a747316fa5c47bcae67283`, published as `dcbbe9ac1fea1b6b591646f66eea5b561c9f3e0a`; their trees match. Stage 40 checks the App Manager game-launch receipt before announcing success; 145 React tests and the TypeScript/Vite build pass locally. GitHub Actions run 43078222464 passed on Windows and macOS.
- Latest tested implementation commit: local `acb32fafd7b9fb7cc79d96ad8aea865edb6b7a2f`, published as `e839f37c736f3fb5798911bd5da212cf8e77e34c`; their trees match. Stage 39 excludes CSS-hidden dialog controls from navigation; 144 React tests and TypeScript/Vite build pass locally.
- Stage 36 tested implementation: local `8d4cf0a89a58e18894a099f2828696fe98b9ca2b`, published as `9cf4d4d9bf662a27558b071a8b68400917f364da`; their trees match.
- Stage 35 final recovery checkpoint: local `c9dd9be49be86d514e5d9cb0fb536d520a84a8f4`, published as `d56a7ee6778849c65b706af7afa9afb91af723ee`; their trees match, and the full snapshot verifies 308 entries.
- Stage 36 final progress checkpoint: local `ed92f8d0f227e24b08639fa95200a433c3aeb465`, published as `2fc1bb7150697e3bc773912bf285712c8cdf4044`; their trees match, with 315 verified recovery entries.
- Stage 37 final recovery checkpoint: local `8fe4493ec4cff2b03beef61bbfd1786bc369bd0c`, published as `e818274c3656cfac14edce63ae725ebe27fb0b15`; their trees match, with 324 verified recovery entries.
- Stage 38 final recovery checkpoint: local `9671d25e62e3eab5745e71615f16a241eee2a100`, published as `c344baa2f8d99e39f270a21d040b960430144c68`; their trees match, with 331 verified recovery entries.
- Stage 39 pre-archive progress checkpoint: local `51518334249dd27f622072b83305d1b2d41d6131`, published as `c730b400911260ec5ceaec986a023454f2b8895e`; trees match. It compared 104 commits ahead, 0 behind.
- Latest published implementation commit: local `b42757ad27530e2a5937ba46ac4faddbdbeecd6e`, published as `e0337167448b6c0ac70d31d3c5873e141a8dd0f8`; their trees match.
- Latest published implementation commit: local `3d9c78533126fa679a2f3828b35d3e27b77c94bd`, published as `91ddcbf4804c7cd5a7454a5976e4b91a7dc7f5a7`; their trees match.
- Latest progress checkpoint: local `e4f4efe3466de7c3cc12bc86a0196afd5c61e08a`, published as `91646dc0f9ec30fb05c0871167855a7c572ede5e`; their trees match.
- Local stage-33 implementation commit is preserved under `refs/codex/local/gaming-hub-refresh-focus-stage-33`.
- Local stage-34 implementation commit is preserved under `refs/codex/local/gaming-hub-error-retry-focus-stage-34`.
- Local stage-34 validation checkpoint is preserved under `refs/codex/local/gaming-hub-error-retry-focus-stage-34-checkpoint`.
- Local stage-35 implementation commit is preserved under `refs/codex/local/gaming-hub-deduplicate-refresh-stage-35`.
- Local stage-35 validation checkpoint is preserved under `refs/codex/local/gaming-hub-deduplicate-refresh-stage-35-checkpoint`.
- Local stage-37 implementation commit is preserved under `refs/codex/local/dialog-navigation-skip-aria-hidden-stage-37`.
- Local stage-39 implementation commit is preserved under `refs/codex/local/dialog-navigation-skip-css-hidden-stage-39`.
- Local stage-38 implementation commit is preserved under `refs/codex/local/gaming-hub-fallback-recovery-focus-stage-38`.
- Local stage-36 implementation commit is preserved under `refs/codex/local/gaming-hub-fallback-retry-deduplicate-stage-36`.
- Local stage-32 implementation commit is preserved under `refs/codex/local/gaming-hub-retry-focus-stage-32`.
- Local stage-31 implementation commit is preserved under `refs/codex/local/gaming-hub-refresh-feedback-stage-31`.
- Local stage-30 implementation commit is preserved under `refs/codex/local/control-service-listener-diagnostics-stage-30`.
- Local stage-29 implementation commit is preserved under `refs/codex/local/control-service-urgent-stop-notice-stage-29`.
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
- Gaming Hub clears old launch feedback during library refreshes and announces a successful launcher result after the follow-up read, including when that read fails.
- Gaming Hub keeps its App Manager retry button mounted, focused, and marked busy while a fallback status refresh is pending.
- The Windows Gaming Hub keeps its library panel and focused refresh button present during a status read, with busy feedback in the existing live region.
- When a Windows status refresh fails, the Gaming Hub carries focus from the refresh button into the fallback retry control and keeps the error visible.
- Control Service actions announce pending work and the resulting state, expose busy status on both controls, and clear pending feedback after errors.
- The emergency-stop event invalidates pending Control Service action results, immediately clears busy state, and prevents an older operation finalizer from clearing a newer action busy state.
- The initial Control Service status read is ignored if an emergency-stop event arrives before that read resolves, so stale startup data cannot revive the stopped state.
- Any Control Service stop event clears the pending action announcement; an unexpected stop leaves its error visible without a stale “updating” message.
- Emergency-stop feedback uses an assertive live announcement; routine action feedback remains polite.
- Failures to register either Control Service status listener now produce a visible diagnostic that the displayed state may be stale.
- Latest local React run: 25 files, 140 tests passed. TypeScript and Vite production build passed.
- GitHub Actions run [43026294733](https://github.com/Milklosz/nexus-aurea/actions/runs/43026294733) passed on Windows and macOS, including React, Rust, TypeScript/Vite, and platform builds. The Release job was skipped.
- GitHub Actions runs [43029135952](https://github.com/Milklosz/nexus-aurea/actions/runs/43029135952) (stage 09), [43029773813](https://github.com/Milklosz/nexus-aurea/actions/runs/43029773813) (stage 10), [43030395848](https://github.com/Milklosz/nexus-aurea/actions/runs/43030395848) (stage 11), [43031259001](https://github.com/Milklosz/nexus-aurea/actions/runs/43031259001) (stage 12), [43032589406](https://github.com/Milklosz/nexus-aurea/actions/runs/43032589406) (stage 13), stage 14 [43033436829](https://github.com/Milklosz/nexus-aurea/actions/runs/43033436829), stage 15 [43035329173](https://github.com/Milklosz/nexus-aurea/actions/runs/43035329173), stage 16 [43036042119](https://github.com/Milklosz/nexus-aurea/actions/runs/43036042119), stage 17 [43036705267](https://github.com/Milklosz/nexus-aurea/actions/runs/43036705267), stage 18 [43039325451](https://github.com/Milklosz/nexus-aurea/actions/runs/43039325451), and stage 19 [43040038281](https://github.com/Milklosz/nexus-aurea/actions/runs/43040038281) passed on Windows and macOS.
- GitHub Actions runs [43043218481](https://github.com/Milklosz/nexus-aurea/actions/runs/43043218481) (stage 20), [43043740999](https://github.com/Milklosz/nexus-aurea/actions/runs/43043740999) (stage 21), and [43045040872](https://github.com/Milklosz/nexus-aurea/actions/runs/43045040872) (stage 22) passed on Windows and macOS; the Release jobs were skipped.
- GitHub Actions runs [43047036322](https://github.com/Milklosz/nexus-aurea/actions/runs/43047036322) (stage 23) and [43047629891](https://github.com/Milklosz/nexus-aurea/actions/runs/43047629891) (stage 24) passed on Windows and macOS; Release was skipped.
- Stage 25 GitHub Actions run [43048341666](https://github.com/Milklosz/nexus-aurea/actions/runs/43048341666) passed on Windows and macOS; React, Rust, TypeScript/Vite, and platform builds succeeded. The Release job was skipped.
- Stage 26 GitHub Actions runs [43051591281](https://github.com/Milklosz/nexus-aurea/actions/runs/43051591281) (PR) and [43051579122](https://github.com/Milklosz/nexus-aurea/actions/runs/43051579122) (push) passed on Windows and macOS; Release was skipped.
- Stage 27 GitHub Actions runs [43053322359](https://github.com/Milklosz/nexus-aurea/actions/runs/43053322359) (PR) and [43053309991](https://github.com/Milklosz/nexus-aurea/actions/runs/43053309991) (push) passed on Windows and macOS.
- Stage 28 GitHub Actions runs [43054012947](https://github.com/Milklosz/nexus-aurea/actions/runs/43054012947) (PR) and [43053998764](https://github.com/Milklosz/nexus-aurea/actions/runs/43053998764) (push) passed on Windows and macOS.
- Stage 30 Actions runs [43055651446](https://github.com/Milklosz/nexus-aurea/actions/runs/43055651446) (PR) and [43055634481](https://github.com/Milklosz/nexus-aurea/actions/runs/43055634481) (push) passed on Windows and macOS.
- Stage 31 GitHub Actions runs [43057193890](https://github.com/Milklosz/nexus-aurea/actions/runs/43057193890) (PR) and [43057181243](https://github.com/Milklosz/nexus-aurea/actions/runs/43057181243) (push) passed on Windows and macOS.
- Stage 32 GitHub Actions runs [43059553007](https://github.com/Milklosz/nexus-aurea/actions/runs/43059553007) (PR) and [43059538714](https://github.com/Milklosz/nexus-aurea/actions/runs/43059538714) (push) passed on Windows and macOS; Release jobs were skipped.
- Stage 33 GitHub Actions runs [43061141004](https://github.com/Milklosz/nexus-aurea/actions/runs/43061141004) (PR) and [43061131133](https://github.com/Milklosz/nexus-aurea/actions/runs/43061131133) (push) passed on Windows and macOS; Release jobs were skipped.
- Stage 34 GitHub Actions runs [43063620136](https://github.com/Milklosz/nexus-aurea/actions/runs/43063620136) (PR) and [43063611269](https://github.com/Milklosz/nexus-aurea/actions/runs/43063611269) (push) passed on Windows and macOS; Release jobs were skipped.
- Stage 35 GitHub Actions runs [43066219552](https://github.com/Milklosz/nexus-aurea/actions/runs/43066219552) (PR), [43066207610](https://github.com/Milklosz/nexus-aurea/actions/runs/43066207610) (push), and [43066446793](https://github.com/Milklosz/nexus-aurea/actions/runs/43066446793) (progress update) passed on Windows and macOS; Release jobs were skipped.
- Stage 36 local validation passed: 25 React test files, 141 tests; the Gaming Hub file passed all 14 tests; TypeScript and Vite production build passed. GitHub Actions run [43069783881](https://github.com/Milklosz/nexus-aurea/actions/runs/43069783881) passed on Windows and macOS. The Stage 36 recovery-document run [43070000362](https://github.com/Milklosz/nexus-aurea/actions/runs/43070000362) also passed.
- Stage 37 local validation passed: the navigation file has 5 passing tests; the full suite has 25 files and 142 tests; TypeScript/Vite production build passed. GitHub Actions run [43072191134](https://github.com/Milklosz/nexus-aurea/actions/runs/43072191134) passed on Windows and macOS; Release was skipped.
- Stage 38 local validation passed: 25 React test files, 143 tests; the Gaming Hub file has 15 passing tests; TypeScript/Vite build passed. GitHub Actions run [43073689068](https://github.com/Milklosz/nexus-aurea/actions/runs/43073689068) passed on Windows and macOS; Release was skipped.
- Stage 39 validation passed: 25 React test files, 144 tests; the navigation file has 6 passing tests; TypeScript/Vite build passed. GitHub Actions run [43075438533](https://github.com/Milklosz/nexus-aurea/actions/runs/43075438533) passed on Windows and macOS; Release was skipped.
- Stage 40 validation passed: 25 React test files, 145 tests; the Gaming Hub file has 16 passing tests; TypeScript/Vite build passed. GitHub Actions run [43078222464](https://github.com/Milklosz/nexus-aurea/actions/runs/43078222464) passed on Windows and macOS; Release was skipped.
- Stage 41 validation passed: 25 React test files, 145 tests; the Gaming Hub file has 16 passing tests; TypeScript/Vite build passed. GitHub Actions run [43080053138](https://github.com/Milklosz/nexus-aurea/actions/runs/43080053138) passed on Windows and macOS; Release was skipped.
- Stage 29 GitHub Actions runs [43054839359](https://github.com/Milklosz/nexus-aurea/actions/runs/43054839359) (PR) and [43054826843](https://github.com/Milklosz/nexus-aurea/actions/runs/43054826843) (push) passed on Windows and macOS.
- The currently installed MSI copy was only opened for visual inspection. Its Control Center is the older long-list layout; it was closed afterward. No installed files or settings were changed.

## Artifact record

- Latest Windows CI artifact for stage 34 from run [43063611269](https://github.com/Milklosz/nexus-aurea/actions/runs/43063611269), artifact ID `13874273614`: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-a0092854aa4ac3fe83f5d08d7a887833fda8b831.zip`.
- ZIP SHA-256: `ff14d0a7ea0fb3f3dd728199a5c485ecc0491a7a1fd7be6fe488d51fb019e217` (matches the GitHub artifact digest); checksum sidecar: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-a0092854aa4ac3fe83f5d08d7a887833fda8b831-SHA256.txt`.
- Extracted installer (not run): `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-a0092854aa4ac3fe83f5d08d7a887833fda8b831-extracted\VELORA_0.9.2_x64-setup.exe`.
- Installer SHA-256: `a3ad2aeba5dc4729d6e403b0577152084800464e4a686a7ec1e3d2cee8ee510d`; Authenticode status: `NotSigned`. It was not executed or installed; the existing MSI remains untouched.
- Prior stage-29 Windows artifact and checksum details remain recorded below.
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
- Stage 28 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-28` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-28.patch`; its CI runs passed on Windows and macOS.
- Stage 29 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-29` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-29.patch`; its CI runs passed on Windows and macOS.
- Stage 30 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-30` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-30.patch`; its CI runs passed on Windows and macOS.
- Stage 31 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-31` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-31.patch`; its interim snapshot verifies 272 entries, and CI passed on Windows and macOS.
- Stage 32 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-32` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-32.patch`; its focus regression and the full 137-test suite pass, and TypeScript/Vite build passes.
- Stage 32 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage32-final.zip` (SHA-256 `240e54b26a2887742d60b9ba9df8f1977bdefd814b9bcf1f5f07534765f9c385`); its checksum sidecar is stored beside it.
- Stage 33 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-33` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-33.patch`; the full 138-test suite and TypeScript/Vite build pass.
- Stage 33 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage33-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 33: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage33-final.zip`; its checksum sidecar is stored beside it.
- Stage 34 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-34` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-34.patch`; the full 139-test suite and TypeScript/Vite build pass.
- Stage 34 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage34-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 34: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage34-final.zip`; its checksum sidecar is stored beside it.
- Stage 34 archive SHA-256 values: standalone `405e9aab811ae6e7656d1726fbeebc42170645d5015047e94149bfa857d8e62`; full snapshot `28d6a98cc6062332c6f272772a09df10d36d7bc98f6c5e29b3bfcf4522bc04e4` (299 manifest entries verified).
- Stage 35 source copies and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-35` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-35.patch`; the full 140-test suite and TypeScript/Vite build pass. CI is green on Windows and macOS.
- Stage 36 test source and before-copy are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-36`; patch: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-36.patch` (SHA-256 `EA189DF6646834E4E5ED9C058E38D6094807F1937492C19762AD40A458B926E`).
- Stage 37 changed sources, before-copies, and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-37` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-37.patch`; patch SHA-256 `4B300DF725A38F963A59CDF030D5753F1F43AA02A55C9E3E27A3C1731C7AA3DE`.
- Stage 38 test source, before-copy, and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-38` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-38.patch`; patch SHA-256 `51060A60A4889C5EFD934A3AB97F5383CD7E6C8406B65837FC758B752DBC6F07`.
- Stage 39 changed sources, before-copies, and patch are stored under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-39` and `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-39.patch`; patch SHA-256 `A2E36ED44B8523C445F761BF7836FAC3BD5DFAE220390778C81A059CB2E9569C`.
- Stage 40 source copies and before-copies are under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-40`; patch: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-40.patch`, SHA-256 `87C5D60307826E3E134C5B561051C70A803AC236E3EC2BEE56CE961775703ACC`.
- Stage 41 source copies and before-copies are under `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-41`; patch: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111\continuation-41.patch`, SHA-256 `B45EC21DB750CFEA5CC162F8B9D62C98A2833CABBEAE00408842CFB43BD49AC8`.
- Stage 41 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage41-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 41: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage41-final.zip`; all 358 manifest entries are verified.
- Stage 41 Windows CI artifact from run [43080053138](https://github.com/Milklosz/nexus-aurea/actions/runs/43080053138), artifact ID `13883428811`, digest `sha256:49f011d570981a53b3a26721d607b46fc8b937d2f7e805cd8b1866a3248790eb`.
- ZIP: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-stage41.zip`; extracted installer SHA-256 `e9e63ce0468b2ae04b64a2ef3b0496793ff635b2705ec0a6a7a4a6e5fdf575e6`; Authenticode: `NotSigned`. The installer was extracted only, not run or installed.
- Stage 40 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage40-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 40: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage40-final.zip`; all 349 manifest entries are verified.
- Stage 40 Windows CI artifact from run [43078222464](https://github.com/Milklosz/nexus-aurea/actions/runs/43078222464), artifact ID `13883033253`, digest `sha256:1b0a7ef6f31e377c42633e52440e5ba60d9f29a67aa7d078b8e2f9ec8fd8966e`.
- ZIP: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-stage40.zip`; extracted installer SHA-256 `0ede340bad14eaa95d9af9e43d147ec9176d6f7c9e6bd182729a59b4d66bd1da`; Authenticode: `NotSigned`. The installer was extracted only, not run or installed.
- Stage 39 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage39-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 39: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage39-final.zip`; its checksum sidecar is stored beside it. All 340 manifest entries are verified.
- Stage 39 Windows CI artifact from run [43075438533](https://github.com/Milklosz/nexus-aurea/actions/runs/43075438533), artifact ID `13879879196`, digest `sha256:847b6923c2f030a971241b90330785297653a39d6fde94a0ecd127d96cf9665d`.
- ZIP: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-stage39-1aa9df9b8f7249c867700aae382fcd1b671858bc.zip`; extracted installer SHA-256 `0b087d5edf3b4c653ea3e7876e20b85ba12c4ba407fc9a2bfac722b24a8884ef`; Authenticode: `NotSigned`. The installer was not executed or installed.
- Stage 38 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage38-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 38: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage38-final.zip`; its checksum sidecar is stored beside it. All 331 manifest entries are verified.
- Stage 38 Windows CI artifact from run [43073689068](https://github.com/Milklosz/nexus-aurea/actions/runs/43073689068), artifact ID `13880197018`, digest `sha256:f7b24bce3bba1fc656a25b8d6e04b76c5642b9c4b76c0f2a8faf2df11f952684`.
- ZIP: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-stage38-c2b978910cea590fba5fb8f956d28cb08596c5e5.zip`; extracted installer SHA-256 `a6269cf0152460f7b471ce2037e7e948cf0776826544e166271f7799154576de`; Authenticode: `NotSigned`. The installer was extracted only; it was not executed or installed.
- Stage 37 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage37-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 37: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage37-final.zip`; its checksum sidecar is stored beside it. All 324 manifest entries are verified.
- Stage 37 Windows CI artifact from run [43072191134](https://github.com/Milklosz/nexus-aurea/actions/runs/43072191134), artifact ID `13878987663`, digest `sha256:7420e2c568e11490893b13bc2d9dba46d167c44c3867e905025076ee74c45fd9`.
- ZIP: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-stage37-2cdb52ce704e1990e6ef7dd05722ca9b7dc35965.zip`; extracted installer SHA-256 `15372bca3ecdfc39e5d033ba16298501f50b00734a38968ea22289c0ec43d786`; Authenticode: `NotSigned`. The installer was extracted only; it was not executed or installed.
- Stage 36 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage36-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 36: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage36-final.zip`; its checksum sidecar is stored beside it. All 315 manifest entries are verified.
- Stage 36 Windows CI artifact from run [43069783881](https://github.com/Milklosz/nexus-aurea/actions/runs/43069783881), artifact ID `13878076320`, digest `sha256:01e9bc3a7f15db58e71f161c236924dde35666e068353408da347a500e3691cb`.
- ZIP: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-stage36-55fc68b18e41c4bb8cb6c3a20c417e5240919e04.zip`; extracted installer SHA-256 `1d520a17b6fd3403076f0e1e087a44fb8ecca6c6e869bd2993862c8a3def3a54`; Authenticode: `NotSigned`. The installer was extracted only and was not executed or installed.
- Stage 35 final standalone archive: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-stage35-final.zip`; its checksum sidecar is stored beside it.
- Full recovery snapshot through Stage 35: `C:\Users\milos\Documents\Codex\nexus-velora-night-build-2-recovery-20261111-full-through-stage35-final.zip`; its checksum sidecar is stored beside it. All 308 manifest entries are verified.
- Stage 35 Windows CI artifact from run [43066207610](https://github.com/Milklosz/nexus-aurea/actions/runs/43066207610), artifact ID `13874844404`, digest `sha256:f8056cb63fa3b85bfce7f9e16e4e2f9deecce3301059618636ce8f175fa419e9`.
- ZIP: `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-stage35-9a297d011bcc8c8e5a5b467522f752bfa2654588.zip`; extracted installer SHA-256 `13f2430a5800a805e5ba5e7b097ff7de861946ee883696fcfcf780d6049f9d7`; Authenticode: `NotSigned`. The installer was not executed or installed.
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
- A single post-publication Git fetch attempt failed after 21 seconds with a GitHub connection error. Do not retry Git fetch; continue publishing through GitHub Git Data APIs and compare local/published tree SHAs.
- The controller signal is process-based and has not been validated against Steam Input ownership on the MSI. The installed VELORA was not replaced.
- Local Tauri development launch is blocked because `cargo` is not installed on this machine.
- Computer Use stopped when it could not confidently determine the browser URL. GUI review is `NOT TESTED`; this tool will not be retried or bypassed. The installed copy's old panel was inspected and then closed without changing installation state.

## Next step

Stages 32–41 are locally tested, committed, published, CI-passed, and backed up. Stages 35–41 have 308, 315, 324, 331, 340, 349, and 358 verified recovery-manifest entries. Stage 41 passed 25 React files (145 tests), the TypeScript/Vite build, and GitHub Actions run 43080053138 on Windows and macOS; its 358-entry recovery archive is verified. Its implementation is local `e88fbe0f5b86d6d51eb9fb92386e43e68ac9a118`, published as `137be5c68d6f5ee4d8d5aa2db5296716774ff2f7`. The Draft PR compared 111 commits ahead and 0 behind before this archive checkpoint, which brings it to 112; exact merge base `6dbcc36abeded18b753a134bc8ede10fb37df391`. Next: start a focused Stage 42 improvement and checkpoint it. GUI review remains `NOT TESTED`; iPhone Remote remains safely disabled by default.
