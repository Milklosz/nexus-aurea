# VELORA 2.0 — Portable Validation Candidate (Windows x64)

This is a **no-install test build** for hardware validation on the MSI machine. It is
**not** a replacement for the installed VELORA 0.9.2, it is **not signed**, and it
records **no physical hardware test result**. Do not use it with real accounts,
real pairing codes or production credentials.

## 1. What you download

The GitHub Actions artifact is a ZIP (GitHub adds this wrapper). After extracting
it once you get:

| File | Purpose |
| --- | --- |
| `VELORA-Portable-Windows-x64.zip` | The portable application package. Verify this file. |
| `velora-portable-manifest.json` | Exact commit, run, isolation identity and SHA-256 records. |
| `SHA256SUMS.txt` | One-line SHA-256 of the portable ZIP. |

Inside `VELORA-Portable-Windows-x64.zip`:

| File | Purpose |
| --- | --- |
| `nexus-aurea.exe` | Standalone Tauri v2 application (built `--no-bundle`). |
| `Run-VELORA-Portable.cmd` | Double-click launcher. Use this to start the app. |
| `Start-VELORA-Portable.ps1` | Launcher implementation (sets the isolated environment). |
| `Preflight-WebView2.ps1` | Read-only prerequisite check. |
| `README-PORTABLE.md` | This file. |

## 2. Download and extract (verifiable procedure)

1. Open the GitHub Actions run linked from the validation report. Under **Artifacts**,
   download `VELORA-Portable-Windows-x64-<commit-sha>`.
2. Extract the artifact ZIP to a new folder, for example
   `C:\VELORA-Portable-Validation`. **Do not extract into the VELORA 0.9.2 install
   folder or into `C:\Program Files`.**
3. Open PowerShell in that folder and verify the portable ZIP:

   ```powershell
   Get-FileHash -Algorithm SHA256 '.\VELORA-Portable-Windows-x64.zip'
   Get-Content '.\SHA256SUMS.txt'
   ```

   The two hashes must match. For an independent second tool:

   ```cmd
   certutil -hashfile VELORA-Portable-Windows-x64.zip SHA256
   ```

4. (Optional) cross-check with the manifest:

   ```powershell
   $m = Get-Content '.\velora-portable-manifest.json' -Raw | ConvertFrom-Json
   $m.artifacts.package.sha256
   $m.source.sourceSha        # exact source commit used for the build
   $m.source.runUrl           # exact GitHub Actions run
   ```

5. Extract the portable ZIP **inside the same folder**: right-click → *Extract All…*
   or `Expand-Archive .\VELORA-Portable-Windows-x64.zip .`. You should now see
   `nexus-aurea.exe` and `Run-VELORA-Portable.cmd` together.

## 3. Prerequisites

* Windows 10/11 x64.
* **WebView2 Runtime (Evergreen) must already be installed.** Windows 11 normally
  ships it. The portable build deliberately does **not** bundle, download or run
  a WebView2 bootstrapper: installers normally do that, but this candidate never
  executes an installer. Check with the read-only preflight:

  ```powershell
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File '.\Preflight-WebView2.ps1'
  ```

* Microsoft Edge is required only for Edge Cinema streaming; the preflight reports
  its status. No admin rights are needed for any step.

## 4. Launch and shutdown

1. Double-click **`Run-VELORA-Portable.cmd`**.
2. For a windowed (non-fullscreen) validation session use:

   ```cmd
   Run-VELORA-Portable.cmd --windowed
   ```

3. The launcher prints the isolated data root before starting the app. All writes
   go to `VELORA-Portable-Data` next to the launcher.
4. Close normally with the window close button or `Alt+F4`. The application runs an
   orderly shutdown (workers and single-instance guard are released). If the app
   hangs, end only the `nexus-aurea.exe` process started from this folder.

## 5. Isolation — what is protected

Changing the executable path alone would **not** isolate a Tauri app. This candidate
uses both a launch-time environment and an isolated compile-time identity:

| Concern | Installed VELORA 0.9.2 | Portable candidate |
| --- | --- | --- |
| Tauri config/data/local-data/cache/log dirs | `%APPDATA%\pl.nexus.aurea`, `%LOCALAPPDATA%\pl.nexus.aurea` | `VELORA-Portable-Data` (Tauri `appDirectoriesOverride`) |
| Main WebView2 profile (localStorage, cookies, cache) | `%LOCALAPPDATA%\pl.nexus.aurea` | same isolated data root (Tauri points WebView2 at `app_local_data_dir`) |
| Remote state lock / checkpoint | `%LOCALAPPDATA%\VELORA\locks` | `VELORA-Portable-Data\Local\VELORA\locks` |
| Pairing secrets / device tokens (Credential Manager) | service `com.nexus.aurea.remote` | service `com.nexus.aurea.remote.portable-validation` |
| Single-instance mutex / window | `Local\pl.nexus.aurea.single-instance` / `VELORA` | `Local\pl.nexus.aurea.portable-validation.single-instance` / `VELORA (Portable Validation)` |
| Edge Cinema profiles | `%LOCALAPPDATA%\VELORA\EdgeCinemaServices` | isolated `Local\VELORA\EdgeCinemaServices` |
| Windows autostart (`HKCU\...\Run`) | available in installed app | write command is disabled in the portable build |
| iOS trust-profile download (system Downloads) | available in installed app | write command is disabled in the portable build |

The launcher changes `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP` and `TMP` for
**its child process only**; no system or user environment variable is changed.
No registry key is written, no installer is run, and no existing user data is read
or modified.

## 6. Honest limitations

* No physical DS4, iPhone, Panasonic TV or streaming-DRM result is claimed. The only
  automated check is a bounded CI startup/shutdown smoke test, recorded in the
  manifest's `smoke` field.
* Hashes and the manifest are **not a digital signature**; they show that the bytes
  match the CI record, not who produced them.
* If WebView2 Runtime is missing the Tauri app exits without a visible UI. Run the
  preflight first; the build will not install anything for you.
* Redirecting `LOCALAPPDATA` means installed-app discovery (Playnite manifest,
  Apple Music stub) may not be visible in this profile. This is intentional for
  isolation; copy only synthetic test fixtures into the portable data root if a
  test needs them.
