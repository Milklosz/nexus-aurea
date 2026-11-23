# VELORA 3.0 Genesis — Installer Upgrade & Rollback TEST PLAN (doc only, NOT executed)

- Branch: `genesis-e-ci` (workstream S3.5). Base: `ded73f4` (`feat/velora-3-genesis` tip).
- **No installer was run, no installed VELORA was touched, no registry/system change was made.** This document is a plan for the hardware-validation stage only.
- Scope: the Windows NSIS installer produced by `pnpm tauri:windows` (`src-tauri/tauri.conf.json` bundle config) on Windows 11 x64 (MSI GP76 target hardware).

## 1. Preconditions (all must hold before starting)

1. A machine with an **already installed** older VELORA build (e.g. 0.12.0-rc.1 from a previous release) whose version is recorded (`winreg` read of the uninstall key + the installed EXE SHA-256).
2. The new candidate installer (`VELORA-*-setup.exe`) plus its provenance manifest from the same CI run; verify with `node scripts/build-provenance.mjs verify-release --installer <exe> --manifest <json>` **before** running anything.
3. The portable candidate ZIP from the same commit as a **rollback / no-install fallback** (never run the installer if you only want validation).
4. A snapshot of the pre-upgrade user state: `%APPDATA%\pl.nexus.aurea` / `%LOCALAPPDATA%\pl.nexus.aurea` file list + hashes, the `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\VELORA` autostart entry (present/absent + command line), and the paired-iPhone-remote credential entry name (existence only, never its secret).
5. A second test iPhone (or a factory-reset one) for pairing tests; the device-wide root-trust caveat from `docs/iphone-remote-cert-audit.md` applies.

## 2. Upgrade test steps (installer path)

| # | Step | Expected result |
| --- | --- | --- |
| U1 | Run the verified installer as the normal (non-admin-promoted where possible) user. | Installer completes; SmartScreen warning (unsigned) is expected and documented — do NOT bypass silently; record the prompt. |
| U2 | After install, launch the new EXE. | App starts fullscreen (or `--windowed` for testing), single-instance mutex activates the existing window instead of a second instance. |
| U3 | Compare post-upgrade state vs the pre-upgrade snapshot. | Data directories preserved/migrated as designed; **paired remote devices and the remote trust profile survive** (re-pairing is NOT required); autostart entry (if enabled) now points at the new EXE path with identical arguments. |
| U4 | Functional smoke on the upgraded install. | Living Room Home renders the 8 dock apps; Control Center shows `Backend Windows: dostępny`; Playnite library read-only view loads (or the truthful "unavailable" notice); Edge Cinema launches one Netflix session and `request_edge_cinema_close` closes it **without killing any process**; iPhone remote pairs over HTTPS and a signed command executes exactly once. |
| U5 | Session lifecycle spot-check. | Launch a game via Playnite/Steam, return Home via pad chord, relaunch — assert **no duplicate launch** and bounded transition receipts in the Sessions panel. |
| U6 | Upgrade-over-upgrade (run the same installer again / repair). | Idempotent: no duplicate shortcuts, no duplicate Run entries, no orphaned old-version files in the install dir. |
| U7 | Record evidence. | Screenshots + `docs/evidence/` JSON with installer SHA-256, versions, timings, and every expected/actual above. |

## 3. Rollback test steps

| # | Step | Expected result |
| --- | --- | --- |
| R1 | Uninstall the new version via Settings → Apps (or the uninstall key). | Uninstaller removes the install dir and its shortcuts; **user data under `%APPDATA%`/`%LOCALAPPDATA%` is preserved** (never deleted by the uninstaller). |
| R2 | Reinstall the previously recorded older installer (its SHA-256 recorded in preconditions). | Older version starts; the preserved data root is accepted (or the documented downgrade path applies); paired remote devices still work if the credential service name is unchanged. |
| R3 | Rollback via portable fallback (no install). | `Run-VELORA-Portable.cmd` from the portable ZIP runs beside the installed build without touching it: disjoint `VELORA_PORTABLE_DATA_DIR`, disjoint credential service (`...portable-validation`), disjoint single-instance mutex, window title `VELORA (Portable Validation)`. Assert the installed instance is unaffected. |
| R4 | Autostart after rollback. | If autostart was enabled pre-upgrade, the Run entry points at the rolled-back EXE and launches it correctly after sign-out/sign-in (or reboot in the hardware lab). |
| R5 | Record evidence. | Same evidence format as §2; note any state that did NOT survive (each must be documented, none may be a secret). |

## 4. Abort criteria (stop the plan, do not improvise)

- Any installer step that would delete user data, touch another application's registry keys, or install a certificate system-wide.
- Any upgrade path that breaks the paired-remote credential namespace or the single-instance mutex (two VELORA windows must never coexist).
- Any fabricated success: a step whose expected result cannot be observed truthfully is recorded as NOT TESTED, never PASS.

## 5. Out of scope (explicitly NOT tested here)

- Fresh install on a machine without a previous VELORA (covered by the portable validation build instead).
- Downgrade of the on-disk data format (no format migration exists; documented).
- SmartScreen bypass, code signing, driver or Edge/WebView2 runtime installation (WebView2 Evergreen must already be present).
