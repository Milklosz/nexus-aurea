# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Active branch: `feat/velora-night-build-2`.
- Latest tested implementation commit: `69514f774f1d375cebbf8cf233739936af1072b2`.
- Latest published checkpoint containing the CI result: `f821b85b954ad23a6247af61a5b9f4bccf916a2f`.
- The local stage-06 implementation commit is preserved under `refs/codex/local/feat-velora-suspend-stage-06`; its tree matches the published implementation commit.
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
- React tests: 24 files, 114 tests passed. TypeScript and Vite production build passed.
- GitHub Actions run [43023723699](https://github.com/Milklosz/nexus-aurea/actions/runs/43023723699) passed on Windows and macOS, including Rust tests and platform builds. The Release job was skipped.
- Windows CI produced `VELORA_0.9.2_x64-setup.exe` inside the downloaded artifact ZIP. ZIP SHA-256: `8af5f900627252f751a0cde0deaa8a2878eec04a70122b8fae3cd840664e1e22`. Installer SHA-256: `d09249bed3b42cf7ef775eb2dd1b81c9bc3a7f11e8b53af3428b44d93a99015b`.
- The installer is stored at `C:\Users\milos\Documents\Codex\VELORA-Windows-x64-6ed483a5f06074f90ecf918cbb0f00efe45637a8.zip`; it was not run or installed.

## Blockers

- Codex artifact attachment for PR #13 did not return; the Draft PR remains available at the link above.
- Git CLI push stalled during authorization. Commits were published with GitHub tools after verifying each expected remote SHA; updates were fast-forward only.
- The controller signal is process-based and has not been validated against Steam Input ownership on the MSI. The installed VELORA was not replaced.

## Next step

Continue with a separate, locally testable Full Cinema Console improvement. Keep iPhone Remote safely disabled by default, avoid Windows network/security setting changes, and do not install the generated artifact on the MSI.