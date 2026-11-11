# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Branch: `feat/velora-night-build-2` in the clean clone.
- Verified upstream base: `6dbcc36abeded18b753a134bc8ede10fb37df391`; exact tree `ea6aa33175216fd51036676c20aadc7ddd7e5773`.
- Night Build 2 published commit: `7c93d3443770fd55dc030b554880896f7efcfeb6`.
- Dock launch-guard published commit: `c1e8a51d6e99832295626b099d0f6ecfc2a4b9e9`.
- Streaming-error published commit: `9ea8ef697e401d9d6e23d1b15fa7297cd54bb1d1`.
- Windows-app error published commit: `a32e7735e0a94eabc13aa03b66fab66db436d9c3`.
- Draft PR: [#13](https://github.com/Milklosz/nexus-aurea/pull/13), targeting `feat/aurea-v0.9.1-secure-iphone-remote`.

## Completed

- Preserved Control Center, dock, HBO Max, TV navigation, and Steam Big Picture changes.
- Secured the 12 original Night Build 2 files and SHA-256 manifest at `nexus-velora-night-build-2-recovery-20261111`.
- Saved Night Build 2 and continuation-stage patches outside the source folders.
- Added a per-service guard against duplicate dock launches with accessible busy feedback.
- Added localized retry guidance for website opener failures while keeping unsafe-address validation explicit.
- Added Windows-app guidance for missing executable, permission denied, and other spawn errors.
- React tests: 22 files, 104 tests passed.
- TypeScript and Vite production build passed.
- All completed stages have local commits; all code stages are published to Draft PR #13.

## Blockers

- Codex artifact attachment for PR #13 did not return; the Draft PR remains available at the link above.
- Git CLI push stalled during authorization. GitHub tools published each commit after verifying the remote branch SHA; updates were fast-forward only.

## Next step

Continue with the README roadmap: prototype read-only Windows controller identification that suspends while a game or Steam Input owns the device. Keep global input actions disabled until that behavior is independently tested.