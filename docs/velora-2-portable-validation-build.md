# VELORA 2.0 — Portable Windows validation build

**Status:** implemented and CI-verified. See `velora-2-portable-validation-report.md`.
**Candidate:** Draft PR #65, commit `446ad37e8ff9a32ff0eff9b8e0cc7d3867bc40d8` (validated base).
**This work:** separate Draft PR from branch `feat/portable-validation-build`. PR #65 is not modified.

## 1. Why the standalone smoke artifact was skipped

The Windows job in `.github/workflows/ci.yml` builds **only** the NSIS installer
(`tauri build --ci --target x86_64-pc-windows-msvc`; `bundle.targets = ["nsis"]`).
The smoke artifact is a single `nexus-aurea.exe` extracted from that installer with
7-Zip, and its publication is gated twice on a **push to a branch**:

1. `.github/workflows/ci.yml:203-210` — the upload step requires
   `github.event_name == 'push' && startsWith(github.ref, 'refs/heads/')`.
   Draft PR #65 runs with `pull_request` and `refs/pull/65/merge`, so the step is
   skipped.
2. `.github/workflows/ci.yml:161-165` — the `smoke_payload` output that names the
   file is only written under the same push-to-branch condition, so even removing
   the first guard would leave an empty path and fail `if-no-files-found: error`.

The provenance write/verify and installer upload **did** run on the PR; only the
smoke-EXE upload was suppressed. This was a deliberate policy against publishing
binaries from synthetic PR merge commits, not a build failure.

## 2. Why a new workflow is required

The extracted NSIS payload is not a portable application: it carries the NSIS
bundle marker, and the installer's normal phases (including any WebView2
bootstrapper handling) are skipped. The existing provenance verifier also
intentionally accepts exactly one EXE plus pinned NSIS plugin DLLs in the
extraction directory, so adding runtime files there would fail verification.

`.github/workflows/portable-windows.yml` therefore builds a genuine standalone
executable with `tauri build --no-bundle --ci --target x86_64-pc-windows-msvc`
and packages it into its own ZIP with a dedicated manifest.

## 3. Isolation design (path changes alone are not isolation)

Tauri v2 resolves `app_data_dir()` / `app_config_dir()` / `app_local_data_dir()`
through Windows Known Folders (`SHGetKnownFolderPath`), which does **not** read
the process `APPDATA` / `LOCALAPPDATA` environment variables. Setting those
variables alone would leave the installed app's session state and the entire
main WebView2 profile shared. The portable candidate therefore combines:

| Mechanism | Implementation |
| --- | --- |
| Tauri app dirs + WebView2 profile | `portable_context()` in `src-tauri/src/lib.rs` sets `AppDirectoriesOverride::Root` from `VELORA_PORTABLE_DATA_DIR` (Tauri also points WebView2 at `app_local_data_dir`). |
| App's own `LOCALAPPDATA` reads (locks, Edge Cinema, Playnite, claude usage) | `scripts/portable/Start-VELORA-Portable.ps1` redirects `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP`, `TMP` for the child process only. |
| Credential Manager pairing secrets | `src-tauri/src/portable.rs` switches the service to `com.nexus.aurea.remote.portable-validation`; `remote_access.rs` uses it for both the store and the state lock. |
| Single instance / window identity | distinct mutex and window title in `portable.rs`, consumed by `single_instance.rs` and the Tauri context. |
| Registry autostart | `set_autostart_enabled` refuses to write in portable mode. |
| iOS trust profile (system Downloads) | `prepare_remote_trust_profile` refuses to write in portable mode. |

When `VELORA_PORTABLE_DATA_DIR` is absent, every helper returns the installed
value, so the installed build's behaviour is unchanged. Unit tests in
`portable.rs` assert both sides of that contract; the manifest verifier checks
that the recorded isolation identity matches those source constants.

## 4. Runtime dependencies

No installer runs, so nothing installs WebView2. The ZIP contains no redistributable
DLLs. The prerequisite is a preinstalled WebView2 Runtime (Evergreen) — normal on
Windows 11 — and Microsoft Edge for optional Edge Cinema. The read-only
`Preflight-WebView2.ps1` reports their status and never installs anything. If
WebView2 is missing, Tauri exits without a UI; this is documented, not hidden.

## 5. Artifact and evidence

`portable-windows.yml` uploads `VELORA-Portable-Windows-x64-<commit>` containing:

* `VELORA-Portable-Windows-x64.zip` — the launchable package,
* `velora-portable-manifest.json` — exact source commit, checkout SHA, event SHA,
  workflow run URL, per-file SHA-256 and the isolation identity,
* `SHA256SUMS.txt` — one-line ZIP hash,
* `smoke-result.json` — bounded CI process startup/shutdown result.

Hashes are a consistency record, **not** a digital signature. The CI smoke test is
a headless runner process check, **not** MSI or physical-hardware validation.
