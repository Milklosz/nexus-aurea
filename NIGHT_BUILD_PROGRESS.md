# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Active branch: `feat/velora-night-build-2`.
- Latest tested implementation commit on the branch: `3829ed9641bbdf5988de5e66c561ef3d6351777f`.
- Original local stage commit preserved under `refs/codex/local/feat-velora-suspend-stage-04`: `2476a9ec21a650777c385b38cf1fc37596e4c5b1` (same tree as current branch head).
- Verified base commit: `6dbcc36abeded18b753a134bc8ede10fb37df391`; exact base tree `ea6aa33175216fd51036676c20aadc7ddd7e5773`.
- Night Build 2 published commit: `7c93d3443770fd55dc030b554880896f7efcfeb6`.
- Dock launch-guard published commit: `c1e8a51d6e99832295626b099d0f6ecfc2a4b9e9`.
- Streaming-error published commit: `9ea8ef697e401d9d6e23d1b15fa7297cd54bb1d1`.
- Windows-app error published commit: `a32e7735e0a94eabc13aa03b66fab66db436d9c3`.
- Draft PR: [#13](https://github.com/Milklosz/nexus-aurea/pull/13), targeting `feat/aurea-v0.9.1-secure-iphone-remote`.

## Completed

- Preserved Control Center, dock, HBO Max, TV navigation, and Steam Big Picture changes.
- Secured all 12 original Night Build 2 files, SHA-256 manifest, and patch outside the source checkout.
- Saved each continuation stage as a patch and file copy outside the source checkout.
- Added per-service duplicate-launch protection with accessible busy feedback.
- Added Polish retry guidance for website opener failures while preserving unsafe-address validation.
- Added Windows app launch guidance for missing executables, permission errors, and other spawn failures.
- Gamepad polling now stops while the window is unfocused or input is suspended, and resets held/repeat state before resuming.
- React tests: 22 files, 105 tests passed.
- TypeScript and Vite production build passed.
- Current code stage is committed locally and published to the Draft PR. Its local and GitHub commit IDs differ because the GitHub API created the remote commit; their tree SHA is identical.

## Blockers

- Codex artifact attachment for PR #13 did not return; the Draft PR remains available at the link above.
- Git CLI push stalled during authorization. The commit was published with GitHub tools after verifying the expected remote SHA; the update was fast-forward only.
- Native Rust tooling is not present in this environment. Keep any Windows-native ownership work isolated and do not enable global controller actions without independent tests.

## Next step

Continue the controller-safety roadmap with a read-only ownership-state prototype. Treat game or Steam process evidence as advisory, default unknown states to suspended, and keep global input actions disabled until the Windows behavior is independently tested.