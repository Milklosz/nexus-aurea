# VELORA 1.0 — MSI Acceptance Test Plan

Target: **MSI GP76 Leopard 11UG**, Windows 11 x64, HDMI → **Panasonic TX-49EX610E**.
Status: **CONDITIONAL GO for a limited test installation**; hardware rows are
**NOT RUN**. CI results do not replace the MSI checks. Fill the result column with `PASS`, `FAIL` or `BLOCKED` and attach
evidence (screenshot/log) where useful.

Build under test:

- Installer: `VELORA_<version>_x64-setup.exe` from the Draft PR Windows job
- SHA-256: `____________________________________________________________`
- Commit: `____________________________________________________________`
- Windows build: `____________________________________________________________`
- Edge version: `____________________________________________________________`
- Playnite version: `____________________________________________________________`
- GPU driver: `____________________________________________________________`


## Final hardening delta (branch `fix/velora-v1-final-hardening`)

The following defects were fixed before hardware testing. CI proves compilation
and automated behaviour only; the hardware rows below remain authoritative.

| Finding | Status | Change to verify on MSI |
|---|---|---|
| CONC-01 | FIXED | Home and launch share one session transaction gate. A Home queued behind a newer launch is rejected as `supersededHome`; its focus restore never runs. |
| CONC-02 | FIXED | Launch transition path is validated and applied before LaunchRegistry publishes the launch. A failed Home→target fallback does not leave an active launch without a session. |
| CONC-03 | FIXED | DualSense Home and the local return hotkey are dispatched to a dedicated Home worker; WM_INPUT and Ctrl+Alt+F12 keep being pumped during a restore. |
| CONC-04 | FIXED | A Home operation is committed before its transition; a late cancel returns `null` instead of falsely reporting `Cancelled`. |
| CONC-05 | FIXED | Startup recovery is one-shot and cleared by the first real session transition. |
| CONC-06 | FIXED | Diagnostics no longer expire an in-flight committed ReturnHome operation. |
| REM-01 | FIXED | Sequence reservation + per-command gate + receipt/ambiguous protocol. Parallel duplicates return one result, failed execution returns 409 without unpairing. |
| REM-02 | FIXED | Remote `select` is default-deny inside dialogs; admin controls require `data-remote-allow` and admin zones are blocked. |
| REM-03 | FIXED | Gamepad/iPhone Home uses a conservative `deviceRequest` focus policy; foreign foreground windows are never stolen. |
| EDGE-01 | FIXED | Adoption requires the marker URL to equal the requested allowlisted service. |
| NAV-01 | FIXED | Up/Down on the single-row dock no longer jumps to the first/last item. |
| AUTO-01 | FIXED | `reg.exe` stderr/paths never cross IPC; only a numeric code may be shown. |
| PRIV-01 | FIXED | Edge IPC exposes `VELORA-EdgeCinema`, never the full `%LOCALAPPDATA%` path. |
| PLAY-01 | FIXED (build) | `PlayniteSDK 6.18.0` + `OnApplicationStartedEventArgs`; Windows CI builds the DLL. Playnite load test remains manual. |
| REM-04–REM-10 | OPEN / MITIGATED | See “Residual risks” at the end; no TLS redesign in this sprint. |

### New regression scenarios

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| R1 | Home vs. launch race | Start a game/cinema and press Home within the same ~200 ms. | No Home focus restore after the new session starts; log shows one session owner. | |
| R2 | Stale Home | Queue Home, immediately launch a second game of the same target. | Home is rejected as superseded; the new game keeps focus. | |
| R3 | Multi-step launch | Enter Desktop or Ambient, then launch a game. | Home→target path completes; no orphan active launch on failure. | |
| R4 | DualSense during restore | Press PS+Options twice and Ctrl+Alt+F12 during the first restore. | The second intent is deduped; emergency shortcut is processed without waiting for the restore. | |
| R5 | Cancel timing | Press Home, call `cancelSessionOperation` after the transition. | Cancel returns null or does not relabel the completed Home as cancelled. | |
| R6 | Recovery clearing | Restart after an unexpected session, enter Cinema, open diagnostics. | Startup recovery is not shown as the current state after the transition. | |
| R7 | Remote parallel duplicate | Send the same signed command twice at once. | Exactly one side effect; both requests end with 204/ACK or the second waits; no 401 unpair. | |
| R8 | Remote execution failure | Send Home while a launch supersedes it. | 409; iPhone stays paired and can send a fresh sequence. | |
| R9 | Remote admin select | Open Control Center → iPhone Remote, focus “Wyłącz serwer LAN”, press remote Select. | Toast denial; server remains enabled. Repeat for revoke and autostart. | |
| R10 | Single-row dock | On Home, press remote Up/Down. | Selection does not jump; Left/Right still move and clamp. | |
| R11 | Mixed-service adoption | Open Netflix Cinema, restart VELORA, choose Disney+. | No Netflix adoption; clear message; no second window. Choose Netflix to verify adoption. | |
| R12 | Edge privacy | Inspect `get_edge_cinema_status`/session JSON. | `profileDir` is `VELORA-EdgeCinema`; no `C:\Users\...`. | |
| R13 | Autostart privacy | Force `reg.exe` failure (deny/rename) and toggle autostart. | UI shows a stable message with an optional numeric code; no raw stderr/path. | |
| R14 | Playnite extension | Build artifact on Windows, copy DLL + extension.yaml, start Playnite, run VELORA menu item. | Manifest appears at `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`; VELORA reads it read-only. | |

## A. Installation and uninstallation

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| A1 | Fresh install | Run NSIS x64 installer as the normal user. | Install completes; shortcut exists; app starts. | |
| A2 | First start | Launch VELORA from the shortcut. | Home renders; no console window; no automatic app launch. | |
| A3 | Upgrade install | Install the new build over the previous one. | Settings/session state remain readable; no duplicate shortcuts. | |
| A4 | Uninstall | Apps → VELORA → Uninstall. | App files/shortcut removed; user session file may remain or be removed according to installer; no HKLM/Winlogon leftovers. | |
| A5 | Registry audit | `reg query HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v VELORA` before/after toggling autostart. | At most one value; no HKLM/Winlogon/shell changes. | |
| A6 | Reinstall after uninstall | Reinstall and start. | Clean Home; no stale external session is claimed. | |

## B. HDMI, resolution, refresh and display

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| B1 | HDMI detection | Connect MSI → Panasonic via HDMI, start VELORA. | Both/expected displays visible in diagnostics. | |
| B2 | 4K 60 Hz mode | Set Windows to 3840×2160 @ 60 Hz, start VELORA. | VELORA renders; diagnostics report 3840×2160, ~60 Hz. | |
| B3 | Refresh change event | Change refresh rate in Windows while VELORA runs. | `velora-display-changed` updates diagnostics; no automatic mode change by VELORA. | |
| B4 | HDR read-only | Toggle Windows HDR on/off. | Diagnostics report HDR best-effort or an explicit error; VELORA never toggles HDR. | |
| B5 | HDMI unplug/replug | Unplug HDMI, wait, reconnect. | App remains stable; display diagnostics refresh; no crash or forced mode. | |
| B6 | TV sleep/wake | Put TV/AV receiver to sleep and wake. | Display state recovers or reports an explicit error; no unintended session action. | |

## C. Audio

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| C1 | HDMI audio endpoint | Select the TV/AV endpoint in Windows, open diagnostics. | Endpoint listed, default flag correct, volume/mute read-only values shown. | |
| C2 | Default device change | Change default audio device while VELORA runs. | Diagnostics update; no automatic audio change by VELORA. | |
| C3 | Volume actions | Use Control Center volume +/−/mute. | Windows volume changes; UI reports success or a clear error. | |
| C4 | Unplug audio | Disconnect HDMI audio. | Endpoint disappears/unplugged; no stale success. | |

## D. DualSense and Steam Input

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| D1 | USB detection | Connect DualSense by USB, start Control Service. | Controller count and Sony count update; no driver install. | |
| D2 | Bluetooth detection | Disconnect USB, pair by BT, start Control Service. | Controller detected; diagnostics show connection/model. | |
| D3 | PS + Options Home | During a managed game/cinema session, press PS+Options. | One Home transition, one focus restore, no duplicate toast; RAW INPUT pump remains responsive. | |
| D4 | Chord debounce | Press PS+Options twice quickly. | No double command/session event. | |
| D5 | Controller loss | Disconnect controller during a session. | Game input unaffected; diagnostics report disconnect; no forced Home. | |
| D6 | Reconnect | Reconnect controller. | Diagnostics update; no stale device duplicate. | |
| D7 | Steam Input coexistence | Enable Steam Input for a game, repeat D3. | No input blocking; Home chord behavior documented (may be hidden by Steam Input; fallback `Ctrl+Alt+N`). | |
| D8 | External app input | Play a game with the controller. | VELORA does not inject/block inputs; no global hook. | |

## E. Playnite

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| E1 | Playnite detected | Install Playnite; open Gaming Hub. | Detection is explicit; no invented games. | |
| E2 | Manifest export | Install the CI-built `VeloraLibraryExporter.dll` + `extension.yaml` in Playnite 10, start it, run the VELORA menu item. | Manifest appears at `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`. | **BUILD VERIFIED; LOAD TEST PENDING** |
| E3 | Invalid manifest | Replace manifest with malformed JSON. | Library falls back to `unavailable`; no invented data; no crash. | |
| E4 | Fullscreen launch | Click Playnite Fullscreen. | Playnite opens; SessionOrchestrator = `playnite`; VELORA hidden. | |
| E5 | Game launch | Click an installed game with a valid manifest URI. | Only the canonical `playnite://playnite/start/<guid>` is used; game starts or a clear error is shown. | |
| E6 | Fullscreen → Desktop handoff | Exit/return from game to Playnite Desktop mode. | Session remains `playnite`; no duplicate session owner. | |
| E7 | Exit Playnite | Close Playnite. | One focus restore to VELORA Home; exactly one Home event. | |
| E8 | Playnite restart | Close and reopen Playnite from VELORA. | New launch ID; old terminal session retained without stealing focus. | |
| E9 | No Playnite | Uninstall/rename Playnite and click the tile. | Clear “not installed” message; no crash, no fake launch. | |
| E10 | Data integrity | Compare Playnite data folder before/after. | No VELORA writes to Playnite DB/files; no token copies. | |

## F. Edge Cinema

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| F1 | Launch Netflix | Click Netflix in the dock. | Dedicated Edge app window opens fullscreen with the VELORA profile; session = `cinema`. | |
| F2 | Profile persistence | Sign in, close Edge, relaunch the same service. | Login persists in `VELORA-EdgeCinema`; no default-profile takeover. | |
| F3 | Duplicate guard | Click the same/another streaming tile while Cinema is active. | No second Edge Cinema window; clear duplicate message. | |
| F4 | Close window | Close the Edge app window. | Session ends once; VELORA returns Home with one focus attempt. | |
| F5 | Edge background process | Verify Edge helpers may remain. | Session still ends on window close; no process kill. | |
| F6 | Edge crash | Kill the Edge browser process in Task Manager. | Session ends safely; VELORA returns Home; no orphan watcher. | |
| F7 | VELORA restart while Edge open | Close VELORA (or crash it) while the Cinema window is open, restart VELORA. | VELORA starts at Home; does not silently claim Edge. A click on the **same** service adopts the existing dedicated-profile window; a different service is rejected instead of adopting it. | |
| F8 | Foreign Edge windows | Open normal Edge windows before/after. | They are never adopted, focused or closed by VELORA. | |
| F9 | Missing Edge | Rename/block `msedge.exe` and click a service. | Clear “Edge not found” message; no crash. | |
| F10 | Focus denial | Use another app to hold foreground, then return Home. | VELORA reports the real Windows denial; no retry loop. | |
| F11 | Allowlist | Attempt to invoke a non-allowlisted URL (dev console/automation). | Native rejection; no Edge process spawned. | |

## G. Streaming services (within Edge Cinema)

For each service: launch from the dock, verify playback page loads in the
dedicated profile, close and return Home.

| # | Service | Expected result | Result |
|---|---|---|---|
| G1 | Netflix `https://www.netflix.com/pl/` | Official page; no URL rewriting/injection. | |
| G2 | Disney+ `https://www.disneyplus.com/pl-pl` | Official page. | |
| G3 | HBO Max `https://www.hbomax.com/pl/pl` | Official page. | |
| G4 | Prime Video `https://www.primevideo.com/-/pl_PL/?tr=pl` | Official page. | |
| G5 | YouTube `https://www.youtube.com/` | Official page. | |
| G6 | DRM/HDCP honesty | Play protected content where allowed. | VELORA makes no DRM/4K/HDR guarantee; failures are reported as service/DRM limitations, not bypassed. | |
| G7 | 4K/HDR playback | Check service playback info. | Record actual result; do not mark PASS based on VELORA claims alone. | |

## H. iPhone Remote

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| H1 | Trust profile | Control Center → prepare trust profile. | Profile path and CA fingerprint shown; key stays in Windows Credential Manager. | |
| H2 | Install trust | Install profile on iPhone and manually trust it. | Safari accepts the VELORA HTTPS origin. | |
| H3 | Pairing | Generate a one-time code and pair. | Pairing succeeds only after server confirmation; `confirmedByServer` is true. | |
| H4 | Pairing timeout | Generate a code and wait > 60 s. | Code expires; pairing rejected; no false success. | |
| H5 | Navigation | Use arrows/select/back/home. | UI responds once per command; Home returns to VELORA without killing the external game/Edge process; a second Edge launch is reported as a duplicate until that window is closed. | |
| H6 | Duplicate command | Send the same signed command twice (retry/duplicate), including concurrently. | Exactly one side effect; exact duplicate gets 204 ACK (or waits for the first result). No 401/unpair. | |
| H7 | Replay/different command | Reuse an older sequence with a different command. | Rejected (401); no execution; PWA requires re-pairing only for genuine auth/replay rejection. | |
| H8 | Network loss | Disable Wi-Fi during a command. | PWA reports no automatic retry; no false success. | |
| H9 | Reconnect | Restore Wi-Fi. | Status recovers; commands require a fresh sequence. | |
| H10 | Revoke device | Revoke the iPhone in Control Center. | Next command rejected; PWA requires re-pairing. | |
| H11 | Host/Origin guard | Send a request with a wrong Host/Origin (test tool). | 403; no command execution. | |
| H12 | Body limit | Send >4096 bytes. | Rejected; no crash. | |
| H13 | Secret hygiene | Inspect logs/diagnostics. | No token, signature, pairing code or key material. | |
| H14 | Failed execution keeps pairing | Force a Home request to be superseded by a launch. | 409; iPhone remains paired; next fresh sequence works. | |
| H15 | Admin select denial | Focus a revoke/stop/autostart control in a dialog and press remote Select. | Denied with a clear message; no state change. | |
| H16 | Single-row navigation | Press remote Up/Down on Home. | No selection jump; Left/Right move normally. | |

## I. Autostart and recovery

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| I1 | Enable autostart | Toggle on with `--windowed`. | One HKCU Run value; value quotes the current exe and adds `--windowed`. | |
| I2 | Disable autostart | Toggle off. | Exactly the VELORA value removed; no other Run entries touched. | |
| I3 | Login start | Sign out/in. | VELORA starts windowed; Home; no app takeover. | |
| I4 | Stale path | Rename/move the exe, then open diagnostics. | Stale entry reported; no automatic repair. | |
| I5 | Refresh entry | Toggle autostart off/on after update. | Value points at the current exe. | |
| I6 | Crash recovery | Kill VELORA during a game/cinema session, restart. | Home + recovery report; no silent re-claim; one safe focus attempt. | |
| I7 | Clean restart | Close VELORA normally during a session, restart. | Home + clean-restart notice. | |
| I8 | Sleep/wake | Sleep during a game/cinema, wake. | No unintended launch/close; missing process gets a fresh grace window; session reconciles safely. | |
| I9 | Restart loop guard | Corrupt/deny the session state file, restart twice. | Corrupt state rejected; Home each time; no restart loop. | |

## J. Focus and window behavior

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| J1 | Return Home | Gamepad/remote/UI Home. | One restore attempt; honest result; no retry loop. | |
| J2 | Windows denial | Hold focus in an unrelated app, then automatic return. | `blockedUnsafeForeground`/denial code; VELORA does not steal focus. | |
| J3 | Alt+Tab | Alt+Tab away/back. | UI focus states remain usable; no forced foreground. | |
| J4 | Minimized VELORA | Minimize, then return Home. | Restore or explicit denial; no crash. | |
| J5 | Foreign fullscreen app | Launch an unmanaged fullscreen app, then use DualSense/iPhone Home, then local UI Home. | Device Home reports `blockedUnsafeForeground` and does not steal focus; explicit local UI Home may request it; no foreign window closed. | |

## K. Diagnostics and security

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| K1 | System diagnostics | Open diagnostics, export report. | Build SHA, sessions, launches, windows, display/audio, controller state present. | |
| K2 | Secret scan | Search exported report/logs for token/key/pairing/credential strings. | None present. | |
| K3 | Capabilities | Inspect Tauri capability behavior. | Main window only; no broad filesystem/shell permission added. | |
| K4 | Edge allowlist | Verify native rejection outside the five URLs. | Rejected before spawn. | |
| K5 | Registry scope | Audit `HKCU`/`HKLM`/Winlogon/shell. | Only the explicit HKCU Run value changes after opt-in. | |
| K6 | No hidden repair | Break autostart/session state and restart. | No automatic system repair; only read-only reporting. | |
| K7 | Process privacy | Check diagnostics and Edge IPC for raw window titles/paths. | No raw window titles or user profile paths; Edge exposes only the profile label. | |
| K8 | Uninstall security | Uninstall and audit leftover services/firewall/registry. | No unexpected service/firewall rule; documented leftovers only. | |

## L. Final gate

| Criterion | Result |
|---|---|
| All required modules present | |
| P1 iPhone Remote fixes preserved | |
| One session owner; no competing state machine | |
| Edge Cinema lifecycle verified on hardware | |
| Playnite launch verified on hardware | |
| Playnite C# extension built (CI) and loaded on MSI | |
| DualSense USB/BT verified | |
| 4K 60 Hz / HDR / audio verified or explicitly limited | |
| Autostart/recovery verified | |
| NSIS installer SHA-256 recorded | |
| No secret leakage in diagnostics/logs | |
| Known limitations documented | |

## Residual risks before MSI (REM-04–REM-10 as assessed in this sprint)

These are accepted for a **limited, trusted-LAN test installation** only. They
are not release blockers for the quick hardening sprint because each requires a
protocol/UX/trust redesign that was explicitly out of scope.

| ID | Risk | State | Mitigation / MSI action |
|---|---|---|---|
| REM-04 | CA private key and device HMAC tokens share one Credential Manager blob (cert audit R1). | OPEN (High) | Keep the MSI account trusted; do not export the vault; remove/rotate the profile after testing. |
| REM-05 | Device-wide root CA has no name constraints / EKU scoping (R2). | OPEN (High) | Requires a new profile and manual iOS re-trust; do not widen the SAN or bypass warnings. |
| REM-06 | Per-start 90-day leaf is bound to one private IPv4; DHCP/VPN changes break the origin (R3). | MITIGATED | Restart the HTTPS server after a network change; never click through a certificate warning. |
| REM-07 | No programmatic pinning; `caFingerprint` is a human comparison only (R4). | OPEN (High) | Compare the Control Center SHA-256 with the installed profile; test only on the private LAN. |
| REM-08 | Revocation clears device tokens but not the iOS trust anchor; no CRL/rotation (R5). | OPEN (Medium–High) | Manually remove the profile after tests or loss; rotation is future work. |
| REM-09 | `trust_confirmed` is a checkbox; the PWA does not perform a signed hello before trusting a stored pairing (R6). | OPEN (Medium) | Pairing stays manual; a real 401 clears the PWA record; command auto-replay remains disabled. |
| REM-10 | Non-Home commands are acknowledged after the WebView event emit, not after JavaScript execution; a hidden/suspended WebView can make 204 optimistic. | OPEN (Low–Medium) | Keep VELORA foregrounded for remote tests; do not auto-retry side-effecting commands; an ack-aware UI protocol is future work. |

**Overall result:** `CONDITIONAL GO for limited MSI tests / PASS / FAIL` —
`______________________________________`


Tester: `______________________` Date: `______________________`
