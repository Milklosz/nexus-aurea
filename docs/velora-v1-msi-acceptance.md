# VELORA 1.0 — MSI Acceptance Test Plan

Target: **MSI GP76 Leopard 11UG**, Windows 11 x64, HDMI → **Panasonic TX-49EX610E**.
Status: **NOT RUN**. Every row is a hardware/manual check; CI results do not
replace it. Fill the result column with `PASS`, `FAIL` or `BLOCKED` and attach
evidence (screenshot/log) where useful.

Build under test:

- Installer: `VELORA_<version>_x64-setup.exe` from the Draft PR Windows job
- SHA-256: `____________________________________________________________`
- Commit: `____________________________________________________________`
- Windows build: `____________________________________________________________`
- Edge version: `____________________________________________________________`
- Playnite version: `____________________________________________________________`
- GPU driver: `____________________________________________________________`

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
| D3 | PS + Options Home | During a managed game/cinema session, press PS+Options. | One Home transition, one focus restore, no duplicate toast. | |
| D4 | Chord debounce | Press PS+Options twice quickly. | No double command/session event. | |
| D5 | Controller loss | Disconnect controller during a session. | Game input unaffected; diagnostics report disconnect; no forced Home. | |
| D6 | Reconnect | Reconnect controller. | Diagnostics update; no stale device duplicate. | |
| D7 | Steam Input coexistence | Enable Steam Input for a game, repeat D3. | No input blocking; Home chord behavior documented (may be hidden by Steam Input; fallback `Ctrl+Alt+N`). | |
| D8 | External app input | Play a game with the controller. | VELORA does not inject/block inputs; no global hook. | |

## E. Playnite

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| E1 | Playnite detected | Install Playnite; open Gaming Hub. | Detection is explicit; no invented games. | |
| E2 | Manifest export | Install/run the VELORA Playnite extension (if a compiled DLL is available). | Manifest appears at `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`. | **BLOCKED until C# extension is built on Windows** |
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
| F7 | VELORA restart while Edge open | Close VELORA (or crash it) while the Cinema window is open, restart VELORA. | VELORA starts at Home; does not silently claim Edge. A new tile click adopts the existing dedicated-profile window instead of opening a duplicate. | |
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
| H5 | Navigation | Use arrows/select/back/home. | UI responds once per command; Home returns to VELORA. | |
| H6 | Duplicate command | Send the same signed command twice (retry/duplicate). | Exact duplicate gets 204 ACK with no second side effect. | |
| H7 | Replay/different command | Reuse a sequence with a different command. | Rejected (401); no execution. | |
| H8 | Network loss | Disable Wi-Fi during a command. | PWA reports no automatic retry; no false success. | |
| H9 | Reconnect | Restore Wi-Fi. | Status recovers; commands require a fresh sequence. | |
| H10 | Revoke device | Revoke the iPhone in Control Center. | Next command rejected; PWA requires re-pairing. | |
| H11 | Host/Origin guard | Send a request with a wrong Host/Origin (test tool). | 403; no command execution. | |
| H12 | Body limit | Send >4096 bytes. | Rejected; no crash. | |
| H13 | Secret hygiene | Inspect logs/diagnostics. | No token, signature, pairing code or key material. | |

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
| J5 | Foreign fullscreen app | Launch an unmanaged fullscreen app, then use Home. | User gesture may request focus, result verified; no foreign window closed. | |

## K. Diagnostics and security

| # | Test | Steps | Expected result | Result |
|---|---|---|---|---|
| K1 | System diagnostics | Open diagnostics, export report. | Build SHA, sessions, launches, windows, display/audio, controller state present. | |
| K2 | Secret scan | Search exported report/logs for token/key/pairing/credential strings. | None present. | |
| K3 | Capabilities | Inspect Tauri capability behavior. | Main window only; no broad filesystem/shell permission added. | |
| K4 | Edge allowlist | Verify native rejection outside the five URLs. | Rejected before spawn. | |
| K5 | Registry scope | Audit `HKCU`/`HKLM`/Winlogon/shell. | Only the explicit HKCU Run value changes after opt-in. | |
| K6 | No hidden repair | Break autostart/session state and restart. | No automatic system repair; only read-only reporting. | |
| K7 | Process privacy | Check diagnostics for raw window titles/paths. | No raw window titles; only safe application labels/errors. | |
| K8 | Uninstall security | Uninstall and audit leftover services/firewall/registry. | No unexpected service/firewall rule; documented leftovers only. | |

## L. Final gate

| Criterion | Result |
|---|---|
| All required modules present | |
| P1 iPhone Remote fixes preserved | |
| One session owner; no competing state machine | |
| Edge Cinema lifecycle verified on hardware | |
| Playnite launch verified on hardware | |
| Playnite C# extension built and loaded | |
| DualSense USB/BT verified | |
| 4K 60 Hz / HDR / audio verified or explicitly limited | |
| Autostart/recovery verified | |
| NSIS installer SHA-256 recorded | |
| No secret leakage in diagnostics/logs | |
| Known limitations documented | |

**Overall result:** `PASS / FAIL / BLOCKED` — `______________________`

Tester: `______________________` Date: `______________________`
