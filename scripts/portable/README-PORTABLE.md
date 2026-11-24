# VELORA 3.0 — First-frame recovery candidate (Windows x64)

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
| `Start-VELORA-Portable.ps1` | Optional PowerShell launcher where machine policy permits it. |
| `Preflight-WebView2.ps1` | Read-only prerequisite check. |
| `README-PORTABLE.md` | This file. |

## 2. Download and extract (verifiable procedure)

1. Open the GitHub Actions run linked from the validation report. Under **Artifacts**,
   download `VELORA-3-First-Frame-Windows-x64-<commit-sha>`.
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
  powershell.exe -NoProfile -File '.\Preflight-WebView2.ps1'
  ```

* Microsoft Edge is required only for Edge Cinema streaming; the preflight reports
  its status. No admin rights are needed for any step.
* If Windows policy blocks the optional preflight, use the CMD launcher. Native
  startup records whether the WebView2 loader detected a runtime.

## 4. Launch and shutdown

1. Double-click **`Run-VELORA-Portable.cmd`**.
2. For a windowed (non-fullscreen) validation session use:

   ```cmd
   Run-VELORA-Portable.cmd --windowed
   ```

3. The portable EXE initializes `VELORA-Portable-Data` beside itself, including
   when started directly or from a different working directory.
4. Close normally with the window close button or `Alt+F4`. The application runs an
   orderly shutdown (workers and single-instance guard are released). If the app
   hangs, end only the `nexus-aurea.exe` process started from this folder.

## 5. Isolation — what is protected

Changing the executable path alone would **not** isolate a Tauri app. This candidate
uses a dedicated build feature and initializes its profile before Tauri starts.

| Concern | Installed VELORA 0.9.2 | Portable candidate |
| --- | --- | --- |
| Tauri config/data/local-data/cache/log dirs | `%APPDATA%\pl.nexus.aurea`, `%LOCALAPPDATA%\pl.nexus.aurea` | `VELORA-Portable-Data` (Tauri `appDirectoriesOverride`) |
| Main WebView2 profile (localStorage, cookies, cache) | `%LOCALAPPDATA%\pl.nexus.aurea` | same isolated data root (Tauri points WebView2 at `app_local_data_dir`) |
| Remote state lock / checkpoint | `%LOCALAPPDATA%\VELORA\locks` | `VELORA-Portable-Data\Local\VELORA\locks` |
| Pairing secrets / device tokens (Credential Manager) | service `com.nexus.aurea.remote` | service `com.nexus.aurea.remote.portable-validation` |
| Single-instance mutex / window | `Local\pl.nexus.aurea.single-instance` / `VELORA` | `Local\pl.nexus.aurea.portable-validation.single-instance` / `VELORA (Portable Validation)` |
| Edge Cinema profiles | `%LOCALAPPDATA%\VELORA\EdgeCinemaServices` | isolated `Local\VELORA\EdgeCinemaServices` |
| Windows autostart (`HKCU\...\Run`) | available in installed app | write command is disabled in the portable build |
| iOS trust-profile download (system Downloads) | available in installed app | written only to `VELORA-Portable-Data\trust`, after explicit local approval |

The EXE redirects `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP` and `TMP` for
its own process. It exits before starting Tauri if WebView2 policy or an inherited
user-data override could redirect the profile outside the portable root.

## 6. Honest limitations

* `smoke-result.json` records whether a Windows CI runner found a visible native
  window, received the React startup event and observed orderly process exit.
  Physical DS4, iPhone, Panasonic TV and streaming-DRM results require separate tests.
* Hashes and the manifest are **not a digital signature**; they show that the bytes
  match the CI record, not who produced them.
* `VELORA-Portable-Data\startup-<pid>-<time>.log` records the last reached phase,
  commit, loader status and sanitized failure codes. A stopped process with no
  terminal marker may have terminated outside the Rust shutdown path. If no log
  exists, check whether the extracted folder is writable and record the exit code.
* To clean up, close the portable window and remove only this extracted test folder.
  Keep a copy of the startup traces if a launch failed.
* Redirecting `LOCALAPPDATA` means installed-app discovery (Playnite manifest,
  Apple Music stub) may not be visible in this profile. This is intentional for
  isolation; copy only synthetic test fixtures into the portable data root if a
  test needs them.

## 7. iPhone Remote — reversible portable trust-profile validation

This candidate supports a **manual, reversible** iPhone pairing test. It never
installs a certificate silently, never modifies a system trust store and never
weakens HTTPS/TLS.

### Setup (explicit approval required)

1. In the iPhone Remote panel, tick the unchecked-by-default approval checkbox.
   Before it can be ticked the UI shows the resolved path
   `VELORA-Portable-Data\trust\VELORA-LAN-Remote.mobileconfig` and the CA
   SHA-256 fingerprint (read-only preview, no file written).
2. Clicking **Przygotuj profil zaufania iPhone'a** issues a one-time, 120-second
   local IPC approval token and writes the `.mobileconfig` ONLY inside
   `VELORA-Portable-Data\trust`. An authoritative portable guard rejects any
   path outside the portable data root; the installed Downloads directory is
   never consulted in portable mode.
3. Compare the displayed SHA-256 fingerprint with the one shown by iOS. Transfer
   the profile manually over a trusted channel (e.g. AirDrop to your own device).
4. On the iPhone install it via Settings → General → VPN & Device Management,
   then enable full trust in Settings → General → About → Certificate Trust
   Settings. Keep the private CA key in the isolated Credential Manager service.
5. Keep the MSI and iPhone on the SAME private Wi-Fi network. Open the exact
   HTTPS address shown in Control Center. The QR code carries only the one-time
   code, host and short expiry in the URL **fragment** — no token, key or
   fingerprint. **Do not bypass Safari certificate warnings.**
6. Generate the one-time code in Control Center and enter it within 60 seconds.
   Commands remain HMAC-SHA256 signed, replay-protected and host/origin checked.

### Cleanup (reversible)

Tick the separate **Wyczyść dane zaufania (cofnij)** confirmation and click the
button. The local-only command (no LAN route) stops the server, removes the
generated `.mobileconfig` from the portable trust directory only, and revokes all
paired devices. It reports each step truthfully. On the iPhone, manually remove
the profile in Settings → General → VPN & Device Management and disable full
trust in Certificate Trust Settings. The installed app's profile and all system
trust stores are never touched.

### Validation status

Real-device pairing has **NOT** been validated on an iPhone or MSI. This is an
explicit hardware gate for Luna — do not report pairing as PASS from this
build alone.
