# Grand Living Room release gate

Current follow-up candidate version: `0.10.0-rc.2`, based on preserved rc.1 `f232ea6`. Engineering candidate only. Never stable while hardware acceptance is open. Artifact and live evidence must distinguish these two builds.

Frozen final source: **`a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea`**. Post-build evidence is on a separate documentation branch.

| Gate | Evidence and scope | Status |
| --- | --- | --- |
| A Architecture | Single existing launch/window/input authorities, bounded projection and shared IDs | PASS source review |
| B Implementation | Vitest 946/105 files; full Windows Rust 429 PASS /2 ignored /0 filtered; adapter/provenance 37 PASS; TypeScript PASS; final build/Clippy recorded at delivery | PASS declared automated scope |
| C Integration | Home/CC/session/remote automated integration; final native Home/source/export/restart/readback smoke observed | PASS declared scope |
| D Computer Use | rc.1 matrix plus separate exact-source final smoke; live remote/game/unrelated-browser and full device cases remain open | PARTIAL / open cases documented |
| E Security | Independent reviews; administrative boundary, stale events, pairing CAS and restart ordering reviewed/fixed | SOURCE REVIEW PASS |
| F Installer | Final run 43953442661 Windows NSIS/provenance and downloaded ZIP/EXE hashes pass; metadata0.10.0-rc.2; no installation | PASS artifact gate; execution NOT TESTED |
| G Hardware | DS4, iPhone, Panasonic HDMI/audio | BLOCKED |

Final CI: Windows 429 Rust /2 ignored, macOS 378 /1 ignored, Vitest 946 /105 files, provenance 31 and Claude adapter 6; Windows/macOS/Playnite build jobs PASS; stable-release publication SKIPPED. Local Clippy PASS with inherited warnings. The installer SHA-256 is `37605cd38e1cdf6b1fcacc03fda44c4228f3b1f641ce512fb9b6a5c8119732c0`. The CI runner verified its source/checkout/tool context and installer payload relation; local consistency is independently checked, while signature authenticity is not proven. Build commands and tool metadata are recorded; bit-for-bit reproducibility across arbitrary machines is not asserted.

## Test environment and inherited failures

Follow-up complete native execution outside the sandbox passed 429 tests after the live restart correction, with 2 ignored and no filters, using unique synthetic test Credential Manager services. The ignored tests are subprocess helpers explicitly invoked by other tests, not passed hardware checks. This resolves the available test-scope limitation without converting the older sandbox failures into passes. Clippy retains inherited warnings; modified native modules pass rustfmt. The first follow-up test attempt failed before execution because its explicit temporary directory did not exist; after creating it, the full suite passed.

The full initial S2.0 native run recorded 380 PASS /32 FAIL /2 ignored. Thirty-one failures depend on Windows Credential Manager denied in this sandbox; the other failure was an overlong sandbox temporary linker path. Explicitly filtering the 37 remote Windows-vault tests plus 2 Credential Store tests is a 39-test exclusion, NOT 39 passes. Use a short external temporary directory (outside any Git repository) for the provenance subprocess tests. Whole-crate rustfmt retains inherited drift in unrelated modules; modified native modules are checked separately. Clippy warnings are retained, not described as a warning-free build. Local .NET has only a runtime, so Playnite C# compilation depends on CI.

## Installer identity and reversal

Keep Tauri identifier `pl.nexus.aurea`, executable `nexus-aurea.exe`, and current-user NSIS mode. The existing upgrade hook selects the legacy NEXUS AUREA installation if present. The installer does not enable startup or replace Explorer. Preserve settings and browser profiles. No stable tag or release publication is part of this program.

Before any approved installation, retain the previous installer and a user-approved backup of application configuration. No backup containing cookies, credentials or private data is uploaded. A standalone candidate shares the application identity and single-instance/data boundary with the installation; it is not an isolated second profile. Close an existing VELORA normally before testing the candidate. Start with `--windowed` for recovery; this bypasses saved TV fullscreen restoration. Existing unrelated browser windows must remain open.

Rollback without installation: exit the candidate normally and reopen installed VELORA 0.9.2. If an upgrade is later explicitly approved, rollback requires the retained previous installer; do not uninstall with data deletion. New Smart Home/Gaming data are versioned separate ID-only keys; TV preference uses a separate versioned file. Do not delete user settings to resolve an error. Autostart is changed only by the user's explicit local setting, never by this engineering session.

## Residual limitations

Resume means application window, not video time. Close is supported only for exact-owned Cinema sessions. Steam collections and the existing supported Playnite manifest/library remain separate. Playnite 10/SDK 6 integration does not assert Playnite 11 support. No unsupported default-audio policy API, TV HDMI-CEC, new iOS app, persistent watchdog or account-data scraping is introduced. Two PWA tabs using the same credential can conflict on sequence; the server rejects replay and the user may need to re-pair. Monitor topology/resolution changes can invalidate an opaque display selection and require reselection.
