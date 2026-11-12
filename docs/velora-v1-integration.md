# VELORA 1.0 — Grand Integration

`integration/velora-v1` is the single integration line for Core, System
Intelligence, Experience and Ecosystem. It is prepared for independent review
and MSI testing, not declared production-ready.

## 1. One session owner

`SessionOrchestrator` is the only authoritative owner of:

`veloraHome`, `game`, `playnite`, `cinema`, `desktop`, `ambient`.

Every external launch now flows through one chain:

```text
UI / iPhone Remote / DualSense Home
        │
        ▼
SessionOrchestrator (revision, transition table, idempotency)
        │
        ▼
LaunchRegistry (launchId, phase, PID identity, watcher lifecycle)
        │
        ▼
WindowBroker (HWND identity, foreground denial, safe restore)
        │
        ▼
ProcessTable (shared, bounded snapshot)
```

There is no second global session machine. `EdgeCinemaSession` and
`PlayniteManifestView` are read-only projections; they never transition
sessions themselves.

### Transitions

```text
veloraHome → game | playnite | cinema | desktop | ambient
game       → veloraHome | playnite | cinema | desktop | ambient
playnite   → veloraHome | game | cinema | desktop | ambient
cinema     → veloraHome | game | playnite | desktop | ambient
ambient    → veloraHome
desktop    → veloraHome
```

`launchId`, `sessionRevision`, `commandId`, `expectedRevision` and
`issuedAtMs` are preserved. Commands are idempotent by `commandId`, stale
revisions are rejected, expired commands are rejected, and an older event can
never clear a newer launch context (`finish_launch_session` checks ownership).

## 2. Edge Cinema

Implemented in `src-tauri/src/edge_cinema.rs`:

- exact five-URL HTTPS allowlist, checked natively;
- dedicated persistent profile `%LOCALAPPDATA%\VELORA\VELORA-EdgeCinema`;
- fixed launch flags, no kiosk/incognito/DRM-bypass/GPU flags;
- `LaunchRegistry` launch kind `cinema`, target session `cinema`;
- window tracking through `WindowBroker` (the Edge browser root window counts,
  not only renderer descendants);
- window-close completion even if Edge keeps a background process alive;
- 20-second start deadline instead of a 60-second stuck Cinema session;
- duplicate guard owned by `LaunchRegistry`, not an adapter variable;
- non-secret `.velora-edge-session.json` marker for restart adoption;
- adoption only when PID creation time, `msedge.exe` image name and a visible
  window all match; a recycled PID is rejected;
- confirmed close posts `WM_CLOSE` to the one tracked HWND; no process kill;
- no foreign Edge windows are adopted or closed;
- DRM/HDCP/4K/HDR are never changed or guaranteed.

Flow:

```text
Home → openStreamingService → launch_edge_cinema
     → LaunchRegistry(Cinema) → WindowBroker(window/focus)
     → Edge window closes or Edge exits
     → LaunchRegistry ends launch → restore VELORA → Home
```

## 3. Gaming and Playnite

`LaunchRegistry` tracks Steam, games, Playnite and managed apps with:

- shared `ProcessTable` snapshots (350 ms cache; forced refresh for baselines);
- PID identity (creation time) and PID-reuse detection;
- HWND identity filtering (a recycled PID plus stale HWND is ignored);
- baseline windows so a pre-existing Steam window cannot become a game;
- one watcher thread, one poll loop, bounded retained sessions;
- explicit `Ended`/`Failed`/`Cancelled` terminal states.

Playnite:

- `get_playnite_library` reads only the explicit manifest
  `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`;
- `launch_playnite_game` validates the GUID and requires the canonical
  `playnite://playnite/start/<guid>` URI; games not marked `installed` are
  rejected with a clear message instead of guessing a launcher;
- the URI is opened through the Windows shell, never through a raw executable
  path or stored launcher arguments;
- if Playnite is already running, the session attaches to its process; if it is
  not, VELORA starts Playnite Fullscreen and waits a bounded 8 seconds;
- Playnite Fullscreen → Desktop process handoff remains one Playnite session
  (`Playnite.FullscreenApp.exe` and `Playnite.DesktopApp.exe` are one group);
- VELORA never opens or edits Playnite's database and never copies tokens.

The C# exporter is pinned to `PlayniteSDK 6.18.0` for Playnite 10 (`net462`).
It compiles locally with 0 warnings/errors and the Windows CI job rebuilds and
uploads `VeloraLibraryExporter.dll`. Loading it in Playnite and writing a real
manifest is still a manual MSI check (E2); compilation is not runtime proof.

## 4. iPhone Remote

P1 behavior is preserved:

- HMAC-SHA256 over `NEXUS-AUREA-REMOTE-V1\ndeviceId\nsequence\ncommand`;
- monotonic sequence replay protection;
- Host/Origin validation, JSON content type, 4096-byte body limit;
- TLS with an explicitly trusted certificate profile;
- pairing timeout and `confirmedByServer` on the PWA;
- no false success, no `no-cors`, no certificate bypass, no secrets in logs.

Server-side idempotency and failure semantics (final hardening):

- the sequence is reserved before the side effect, but the whole transaction
  (authentication → reservation → execution → receipt) is serialized;
- a parallel duplicate waits, then receives `204` from the receipt; it never
  executes the signed command twice;
- a duplicate request with the same device, sequence and command is answered
  `204` without a second side effect;
- the same sequence with a different command is rejected;
- an interrupted sequence without a receipt is `409 Ambiguous` (the phone keeps
  its pairing and may use a fresh sequence), never executed twice;
- a failed execution rolls the reservation back and returns a conflict;
- receipts are not persisted and contain no token, signature or body;
- the PWA still never auto-retries a command with side effects;
- `Home` performs the native `return_home` transition before the `204` with a
  conservative device focus policy, so a hidden WebView cannot fake success and
  a foreign foreground app is not stolen.

## 5. DualSense and couch control

- Raw Input listener stays inside Control Service (opt-in start).
- PS + Options chord is debounced and followed by `return_home` through
  `SessionOrchestrator`; it does not become a second session owner.
- Controller disconnect/reconnect diagnostics are retained.
- The listener installs no driver, global hook or emulator and does not block
  game input.
- No claim of full DualSense support inside external apps without MSI tests.

The Ecosystem `appControl` reducer remains a typed prototype and is not mounted
in `App.tsx`. It does not own sessions.

## 6. Autostart and recovery

- opt-in only; no automatic repair;
- exactly one `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` value named
  `VELORA`;
- no HKLM, Winlogon, shell replacement or Startup folder writes; the NSIS
  installer hook was audited and no longer renames a legacy Startup shortcut;
- `--windowed` is the only optional startup flag;
- stale/updated-path diagnostics are read-only and recommend toggling autostart
  again;
- startup never closes or takes over existing applications;
- crash recovery restores Home and reports the previous session; it never
  silently re-claims an external window;
- `velora-session.json` contains no tokens, pairing data, window titles or
  user paths.

## 7. Display and audio

`display_audio.rs` remains read-only:

- monitors, current resolution, refresh rate, bit depth;
- HDR best-effort with an explicit error, never a guarantee;
- audio endpoints and default-device diagnostics;
- HDMI/display signature change events;
- no automatic resolution/HDR/audio changes.

The TypeScript types now live in `src/contracts/display.ts`; the service
re-exports them, so a future Scene Engine has one stable contract.

## 8. Security boundaries

| Area | State |
|---|---|
| iPhone HMAC | Implemented, tested |
| Replay protection | Implemented (sequence + exact receipt ACK) |
| TLS | Rustls, explicit trust profile; no bypass |
| CSP / headers | `default-src 'none'`, no-store, nosniff, DENY, no-referrer |
| Tauri capabilities | Main window only; existing opener allowlist unchanged |
| Edge allowlist | Exactly five HTTPS URLs, native + frontend |
| Edge close | `WM_CLOSE` on one tracked HWND; no kill, no foreign window |
| Playnite | Read-only manifest; canonical GUID URI only |
| Windows registry | HKCU Run /v VELORA only, explicit opt-in |
| Diagnostics | No tokens, pairing secrets, raw window titles or credentials |
| Session state file | No secrets; bounded and versioned |

## 9. Known limitations

- **REQUIRES MSI:** real Edge app-window identity, profile persistence,
  DRM/HDCP, 4K/HDR, Panasonic HDMI behavior.
- **REQUIRES MSI:** DualSense USB/BT, PS+Options, Steam Input coexistence.
- **BLOCKED:** Playnite C# extension build (Windows + Playnite SDK + .NET
  Framework 4.6.2). SDK version `6.0.0` is still a placeholder in the csproj.
- **PARTIAL:** Playnite game launch is implemented against the documented URI,
  but no real Playnite installation was exercised here.
- **TESTED WITH MOCKS:** Edge window close, PID/HWND reuse, concurrent Home,
  remote duplicate ACK, restart recovery, sleep/wake.
- **NOT GUARANTEED:** 4K/HDR/HDCP in streaming services; VELORA reports and
  observes only.
- **DELIBERATE:** Home from an active external session returns VELORA to Home
  without closing the game/Edge process. Edge Cinema remains open and a second
  launch is rejected as a duplicate; the user can Alt+Tab back. VELORA never
  kills or closes an external window without a confirmed close request.
- **NOT IMPLEMENTED:** new frontend redesign, Scene Engine actuation, automatic
  display/audio changes.

## 10. Verification

Local commands and results are recorded in
`docs/velora-v1-msi-acceptance.md` and the final PR report. Windows behavior is
only claimed after the GitHub Actions Windows job and MSI tests pass.
