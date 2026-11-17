# VELORA 2.0 — prioritized hardware validation gates (S2.5–S2.8)

These gates are **NOT TESTED** in this engineering session. No GUI was launched for hardware
testing, no desktop focus was taken, no installer was run, no Windows setting was changed and no
physical device was operated. Automated tests establish logic, contracts and sanitized diagnostics
only. This list is the hand-off to a separately authorized hardware validation session on the MSI
GP76 Leopard / Panasonic TX-49EX610E.

## P0 — blocks the couch-only product goal

| # | Gate | Concrete check | Current status |
|---|---|---|---|
| H1 | Physical DualShock 4 over Bluetooth | Pair, navigate Home and Control Center, Home chord, reconnect after sleep/disconnect, neutral rearm, no stale input after reconnect | HARDWARE NOT TESTED |
| H2 | Panasonic 4K pointer accuracy | At 3840×2160 / effective DPI 144 (150%) / API bucket 140%, verify owned-window click/scroll hit targets; negative desktop origin if extended; F11 fullscreen and return | HARDWARE NOT TESTED |
| H3 | iPhone Remote over LAN with TLS | Real Safari trust of runtime CA, QR scan of short-lived code, prefill + manual fallback, live countdown, signed paired-state verification, Wi-Fi interruption recovery, no command replay, revoke individual/all | HARDWARE NOT TESTED |

## P1 — required before any release candidate acceptance

| # | Gate | Concrete check | Current status |
|---|---|---|---|
| H4 | Streaming service navigation | Netflix, YouTube, Disney+, Max, Prime Video with legitimate sessions; per-service conservative keyboard/UIA/pointer behavior; protected-content and site-change failure messages. No DRM bypass. | HARDWARE NOT TESTED |
| H5 | Display topology change | HDMI disconnect/reconnect, monitor move, scale change → signature change, window recovery, no stale geometry; read-only audio endpoint identity | HARDWARE NOT TESTED |
| H6 | Streaming window close/crash | Foreground ownership, no focus theft, VELORA focus restoration exactly once, no duplicate launch, PID reuse rejection | HARDWARE NOT TESTED |
| H7 | Installer upgrade / rollback | Only after explicit approval: retained installer, current-user identity, no data deletion, verified artifact hash. Existing docs: `velora-2-grand-release-gate.md`, `velora-2-s2-3-release-gate.md`, `velora-migration-v0.9.2.md` | NOT TESTED / NOT AUTHORIZED |

## P2 — quality and endurance

| # | Gate | Concrete check | Current status |
|---|---|---|---|
| H8 | Controller-first accessibility | Couch-only reachability of Home, Control Center, Resume and diagnostics; readable TV touch targets; controller feedback banners | HARDWARE NOT TESTED |
| H9 | Long-running transition soak on device | Repeated Home/session/controller/display transitions over an extended period; memory and epoch counters remain bounded | HARDWARE NOT TESTED (automated bounded soak passed) |
| H10 | Startup/shutdown under load | Single-instance behavior, clean shutdown metadata, restart guard, no focus theft from active media playback | HARDWARE NOT TESTED |

## Explicitly out of scope

Bypassing DRM, anti-bot controls or streaming restrictions; accessing personal browser sessions,
credentials or streaming accounts; changing Windows display/audio/firewall/startup/security
settings; installing or replacing the stable VELORA application; merging to `main` or publishing a
stable release.
