# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Active branch: `feat/velora-night-build-2`.
- Latest tested implementation commit on the branch: `69514f774f1d375cebbf8cf233739936af1072b2`.
- The local stage-06 commit `fdb5a6411af3ac12f253d18cff6602e27915cc18` is preserved under `refs/codex/local/feat-velora-suspend-stage-06`; its tree matches the published commit.
- Verified base commit: `6dbcc36abeded18b753a134bc8ede10fb37df391`; exact base tree `ea6aa33175216fd51036676c20aadc7ddd7e5773`.
- Night Build 2 published commit: `7c93d3443770fd55dc030b554880896f7efcfeb6`.
- Dock launch-guard published commit: `c1e8a51d6e99832295626b099d0f6ecfc2a4b9e9`.
- Streaming-error published commit: `9ea8ef697e401d9d6e23d1b15fa7297cd54bb1d1`.
- Windows-app error published commit: `a32e7735e0a94eabc13aa03b66fab66db436d9c3`.
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
- While Control Service is running, a non-VELORA or unknown foreground process suspends local Gamepad polling. With the service off, existing behavior is unchanged.
- React tests: 24 files, 114 tests passed.
- TypeScript and Vite production build passed.
- The latest feature commit is published to the Draft PR; local and GitHub commit IDs differ because GitHub tools created the remote commit, but their tree SHA is identical.

## Blockers

- Codex artifact attachment for PR #13 did not return; the Draft PR remains available at the link above.
- Git CLI push stalled during authorization. Commits were published with GitHub tools after verifying each expected remote SHA; updates were fast-forward only.
- Rust tooling is not present in this environment. Steam/game ownership has not been verified on the MSI; this stage only uses the existing read-only foreground process signal.

## Next step

Review Windows and macOS CI for this commit, then continue the read-only Windows process work. Keep uncertain states suspended and leave global controller actions disabled until process detection and hardware behavior are independently tested.