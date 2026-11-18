# VELORA 2.0 — S2.9 portable validation procedure for Luna

**Scope.** Physical acceptance on the MSI GP76 Leopard 11UG only. Engineering has not touched the
MSI, has not run an installer, and has not interrupted any streaming session. This procedure
produces the hardware evidence that engineering cannot produce. Do not claim a PASS for a gate you
did not execute.

## 0. Acquire and verify (no installation)

1. Download the artifact `VELORA-Portable-Windows-x64-<SOURCE_SHA>` and its
   `velora-portable-manifest.json` + `SHA256SUMS.txt` from the S2.9 Draft PR's portable workflow.
2. Verify with PowerShell:
   ```powershell
   Get-FileHash VELORA-Portable-Windows-x64.zip -Algorithm SHA256
   Get-Content SHA256SUMS.txt
   node scripts/portable-manifest.mjs verify --manifest velora-portable-manifest.json --base . --stage <extracted-stage> --package VELORA-Portable-Windows-x64.zip
   ```
   Confirm `source.sourceSha` is the exact commit named in the PR report and `verification.hardwareValidated` is `false`.
3. Extract to a folder outside `C:\Program Files`, run `Preflight-WebView2.ps1`, then launch
   `Run-VELORA-Portable.cmd --windowed`. Do not run any `.exe` installer.

## 1. Regression-critical PASS list — repeat all of these

- [ ] Portable launch works without installing or modifying VELORA 0.9.2.
- [ ] Startup, graceful shutdown, restart and windowed mode.
- [ ] Fullscreen on Panasonic TX-49EX610E at 3840x2160 / 60 Hz (F11 in/out).
- [ ] Public YouTube playback in the Edge Cinema window.
- [ ] Physical DS4 pointer movement and Cross/X click hit the intended targets.
- [ ] PS + Options restores VELORA Home.
- [ ] Pointer fallback works on public Netflix.
- [ ] Portable WebView2 profile and application-data stay under `VELORA-Portable-Data`;
      `%LOCALAPPDATA%\pl.nexus.aurea` for the installed app is unchanged (compare before/after).

## 2. S2.9 targeted checks

### A — streaming session continuity (first-run focus)
1. Start VELORA, open Netflix, **pause** it, press PS+Options to return Home.
2. Open YouTube; observe whether it is paused. Capture a diagnostics export before and after.
3. Repeat the full sequence twice more. Expected: first and repeated runs behave the same; YouTube
   remains paused; no stray Play/Pause is observed.
4. Note: VELORA intentionally disarms playback shortcuts at a session boundary; re-arm explicitly in
   TV Navigation settings before using a Play/Pause shortcut. This is by design.

### B — Windows state feedback
1. Open Control Center -> Cinema during / just after Control Service start-stop (e.g. toggle
   gaming mode rapidly). Expected: at worst "Backend Windows: nieznany" with a reason and a retry
   button — never a false "niedostępny" claim, no frozen UI.
2. Click "Ponów odczyt statusu Windows". Expected: status recovers to "dostępny".
3. Repeat the "Odśwież stan sterowania" action after a deliberately delayed backend. Expected: retry
   actually re-reads instead of silently doing nothing.
4. Confirm no new periodic polling was introduced (backend events drive recovery).

### C — iPhone Remote (hardware gate, NOT validated by engineering)
1. In Control Center -> iPhone Remote, tick the explicit consent checkbox, verify the displayed
   portable path is under `VELORA-Portable-Data\trust` and note the CA SHA-256 fingerprint.
2. Prepare the profile. Confirm the `.mobileconfig` exists **only** in the portable trust folder and
   nowhere in the system Downloads folder. No certificate is installed by the app.
3. Manually transfer the file to the iPhone (trusted channel), install it in
   Settings -> General -> VPN & Device Management, and enable full trust in
   Settings -> General -> About -> Certificate Trust Settings. Compare the installed CA fingerprint
   with the one shown in the UI. Do not bypass any Safari/HTTPS warning.
4. Start the HTTPS server with the `trust_confirmed` checkbox; connect the iPhone to the same
   private Wi-Fi; scan the QR; pair with the 60 s one-time code; send each allowlisted command.
5. Revoke one device and confirm it is refused; drop Wi-Fi mid-session, restore it, confirm fresh
   signed verification and that no command was replayed; revoke all.
6. Cleanup: use "Wyczyść dane zaufania", then manually remove the iOS profile and disable full trust
   on the iPhone. Confirm no files outside the portable root and that installed VELORA 0.9.2 is
   untouched.
   **Report as PASS only after these steps are actually executed on the physical iPhone.**

## 3. Remaining hardware gates

Carried from `docs/velora-2-s2-5-8-hardware-gates.md`: H1 DS4 Bluetooth reconnect, H2 Panasonic 4K
pointer accuracy, H3 iPhone LAN TLS/QR (detailed above), H4 streaming navigation across providers,
H5 display topology change, H6 streaming window close/crash focus restoration, H7 installer
upgrade/rollback (separate authorization — **not** part of this portable sprint), H8 accessibility,
H9 long soak on device, H10 startup/shutdown under load.

Out of scope: DRM/anti-bot circumvention, personal browser sessions/accounts, Windows system setting
changes, installing/replacing the stable app, merging to `main`.

## 4. Reporting

For each gate record PASS / FAIL / NOT-RUN with the exact steps executed, artifact source SHA,
diagnostics export, and timestamps. Engineering will not convert NOT-RUN into PASS.
