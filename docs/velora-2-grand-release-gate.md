# Grand Living Room release gate

Current follow-up candidate version: `0.10.0-rc.2`, based on preserved rc.1 `f232ea6`. Engineering candidate only. Never stable while hardware acceptance is open. Artifact and live evidence must distinguish these two builds.

| Gate | Evidence and scope | Status |
| --- | --- | --- |
| A Architecture | Single existing launch/window/input authorities, bounded projection and shared IDs | PASS source review |
| B Implementation | Vitest 946/105 files; full Windows Rust 429 PASS /2 ignored /0 filtered; adapter/provenance 37 PASS; TypeScript PASS; final build/Clippy recorded at delivery | PASS declared automated scope |
| C Integration | Home/CC/session/remote automated integration; actual Windows UI unverified | Automated checks only |
| D Computer Use | Follow-up host can operate exact rc.1 candidate; per-scenario evidence and rc.2 smoke are recorded separately | In progress, no blanket PASS |
| E Security | Independent source review; admin-denial and stale SW delivery issues fixed | SOURCE REVIEW PASS |
| F Installer | rc.1 NSIS artifact downloaded/hash verified; rc.2 requires own exact-source build; identity unchanged; no installation authorized | rc.2 packaging pending |
| G Hardware | DS4, iPhone, Panasonic HDMI/audio | BLOCKED |

## Test environment and inherited failures

Follow-up complete native execution outside the sandbox passed 429 tests after the live restart correction, with 2 ignored and no filters, using unique synthetic test Credential Manager services. The ignored tests are subprocess helpers explicitly invoked by other tests, not passed hardware checks. This resolves the available test-scope limitation without converting the older sandbox failures into passes. Clippy retains inherited warnings; modified native modules pass rustfmt. The first follow-up test attempt failed before execution because its explicit temporary directory did not exist; after creating it, the full suite passed.

The full initial S2.0 native run recorded 380 PASS /32 FAIL /2 ignored. Thirty-one failures depend on Windows Credential Manager denied in this sandbox; the other failure was an overlong sandbox temporary linker path. Explicitly filtering the 37 remote Windows-vault tests plus 2 Credential Store tests is a 39-test exclusion, NOT 39 passes. Use a short external temporary directory (outside any Git repository) for the provenance subprocess tests. Whole-crate rustfmt retains inherited drift in unrelated modules; modified native modules are checked separately. Clippy warnings are retained, not described as a warning-free build. Local .NET has only a runtime, so Playnite C# compilation depends on CI.

## Installer identity and reversal

Keep Tauri identifier `pl.nexus.aurea`, executable `nexus-aurea.exe`, and current-user NSIS mode. The existing upgrade hook selects the legacy NEXUS AUREA installation if present. The installer does not enable startup or replace Explorer. Preserve settings and browser profiles. No stable tag or release publication is part of this program.

Before any approved installation, retain the previous installer and a user-approved backup of application configuration. No backup containing cookies, credentials or private data is uploaded. A standalone candidate shares the application identity and single-instance/data boundary with the installation; it is not an isolated second profile. Close an existing VELORA normally before testing the candidate. Start with `--windowed` for recovery; this bypasses saved TV fullscreen restoration. Existing unrelated browser windows must remain open.

Rollback without installation: exit the candidate normally and reopen installed VELORA 0.9.2. If an upgrade is later explicitly approved, rollback requires the retained previous installer; do not uninstall with data deletion. New Smart Home/Gaming data are versioned separate ID-only keys; TV preference uses a separate versioned file. Do not delete user settings to resolve an error. Autostart is changed only by the user's explicit local setting, never by this engineering session.

## Residual limitations

Resume means application window, not video time. Close is supported only for exact-owned Cinema sessions. Steam collections and the existing supported Playnite manifest/library remain separate. Playnite 10/SDK6 integration does not assert Playnite 11 support. No unsupported default-audio policy API, TV HDMI-CEC, new iOS app, persistent watchdog or account-data scraping is introduced. Two PWA tabs using the same credential can conflict on sequence; the server rejects replay and the user may need to re-pair. Monitor topology/resolution changes can invalidate an opaque display selection and require reselection.
