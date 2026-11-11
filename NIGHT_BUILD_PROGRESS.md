# VELORA Night Build Progress

Updated: 2026-11-11 (Europe/Warsaw)

## Current branch and commits

- Branch: `feat/velora-night-build-2`.
- Current implementation commit: `ae267723eaa27bcd5e882f68424f01a0c2b3976c` (`feat: guard duplicate dock launches`).
- Verified upstream base: `6dbcc36abeded18b753a134bc8ede10fb37df391`; its exact tree is `ea6aa33175216fd51036676c20aadc7ddd7e5773`.
- Published Night Build 2 commit: `7c93d3443770fd55dc030b554880896f7efcfeb6`.
- Draft PR: [#13](https://github.com/Milklosz/nexus-aurea/pull/13), targeting `feat/aurea-v0.9.1-secure-iphone-remote`.
- The original local Night Build commit `d39dd68992246e231938bd025f7bc06a9861e9c9` remains in the earlier recovery checkout; this clean clone has the actual Git history from `6dbcc36…` onward.

## Completed

- Preserved Control Center, dock, HBO Max, TV navigation, and Steam Big Picture changes.
- Secured the 12 original Night Build 2 files and SHA-256 manifest at `nexus-velora-night-build-2-recovery-20261111`.
- Saved the Night Build 2 patch and continuation-stage patch outside the source folders.
- Published Night Build 2 through GitHub and verified its Draft PR contains the expected file set.
- Added a per-service launch guard to ignore repeated launches while one is pending.
- Added accessible busy state and clear launch feedback in the dock.
- React tests: 22 files, 101 tests passed.
- TypeScript and Vite production build passed.

## Blockers

- Codex artifact attachment for PR #13 did not return; the Draft PR is available at the link above.
- Git fetch and package installation now work in the clean checkout.

## Next step

Publish the launch-guard commit to Draft PR #13. Then improve error feedback when an external app or website fails to open, with a focused test and commit.