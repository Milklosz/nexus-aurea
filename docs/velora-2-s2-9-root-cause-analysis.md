# VELORA 2.0 — S2.9 root-cause analysis (source-based)

Baseline: PR #71 `d50ed79251698b803b399c1d82bc84c5b3f81ac9` (portable validation).
Target hardware: MSI GP76 Leopard 11UG, Windows 11, Panasonic TX-49EX610E 3840x2160/60,
DualShock 4 Bluetooth, iPhone Remote.

**Evidence disclaimer.** Every finding below is derived from static source inspection and
deterministic tests. No physical device was operated, no streaming session was observed, and no
DRM-protected playback state was read. Hardware acceptance remains a separate gate performed by
Luna on the MSI.

## Workstream A — first Netflix -> VELORA -> YouTube lost paused state

Observed: the first transition lost YouTube's paused state; a repeated run preserved it.

Cause (ranked, source-supported):

1. **First-launch lifecycle asymmetry.** `launch_edge_cinema` has three paths. Adopting an active
   launch (`edge_cinema.rs` ~811-816) or a live marker (~867-872) resolves the owned window and
   runs an identity-checked `activate_owned_window` / `require_edge_window_focus`. A brand-new
   service (no marker) takes the spawn path (~884-929), which called only
   `grant_foreground_handoff` and never explicitly activated/verified the new window. The first
   pass is therefore less deterministic than every subsequent pass.
2. **Blind-toggle media control with residual arming.** Streaming playback control is a toggle,
   not a state command: `service_media_key` maps Play/Pause to Space for Netflix/Prime and `K` for
   YouTube (`streaming_control.rs` ~2361-2375). There is no playback-state readback for these
   services (SMTC in `music_service.rs` tracks only Apple Music). `invalidate_controller_streaming`
   (~1392) bumped `controller_epoch`/`generation` but left `media_controls_armed`,
   `media_target_session`, `media_target_service_id`, `simulator_target` and the input engine
   armed/primed; engine re-arm was lazy (~1199). A single stray Play/Pause edge around the first,
   less deterministic focus transition flips paused -> playing. On a repeated run the focus path is
   deterministic and the stray edge lands harmlessly.

Ruled out as primary causes: a second injected Play/Pause (Cross-source gate, generation rechecks,
exact `launch_id` arming and one-shot Home chord make an unsolicited second toggle unlikely), and a
webview-side Space/Enter injection (none found; `navIntent.ts` maps `x` to select, not Space).

Fix: a full session-boundary quiesce (disarm media control + neutral input engine + generation/epoch
bump), one sanitized receipt per real transition only, and identity-checked best-effort focus on
first launch. No provider playback state is read, persisted or "restored"; no key is injected to
repair playback; DRM is untouched.

## Workstream B — intermittent "error reading Windows state"

Observed: Cinema Panel intermittently reported an error reading Windows state.

Source trace: `CinemaPanel.tsx` itself is a presentational profile switcher with no IPC. The exact
message is in `ControlCenter.tsx` `readControlStatus` (~287-311): `withTimeout(getControlServiceStatus(),
8_000, "Status Windows")` (`withTimeout.ts`). Its catch overwrote the last known status with
`disabledControlServiceStatus` — falsely reporting "Backend Windows: niedostępny" — and showed one
generic message, swallowing the real reason.

Cause: the Rust command `get_control_service_status` (`control_service.rs` ~380-388) is infallible
but runs on `spawn_blocking`; `status()` locks a worker mutex held across `recv_timeout(5s)` plus
join during Control Service start/stop (~293-318). A cold start or a start/stop race can exceed the
8 s UI deadline. The failure was then *mislabelled* as "backend unavailable" instead of "state
unknown, retryable". Two other reads (`App.tsx::changeCinemaProfile` ~502 and
`ControlServicePanel.tsx` ~52) had no timeout at all, and `SessionControllerControls.refresh`
released its single-flight reservation from the underlying promise, so after a hung IPC the retry
button was enabled but the action returned immediately.

Fix: typed degraded state (`unknown` vs `ready`), truthful reason text, last-known status retained,
bounded timeouts on all three reads, epoch-guarded single-flight that is released when the bounded
race settles (so retry works), and event-driven recovery from the existing 750 ms
`control-service-status` events — no new polling.

## Workstream C — portable iPhone pairing blocked by missing trust profile

Observed: portable pairing could not proceed because the trust profile was unavailable; LAN server
stayed disabled.

Cause: `prepare_remote_trust_profile` (`remote_access.rs` ~2493-2508) refused in portable mode
because the inherent write path used `app.path().download_dir()`, which the portable launcher
cannot redirect. Since `trustProfilePath` stayed null, the UI never rendered the QR/start block.
A **concrete isolation bypass** was also found: `RemoteAccess::start` (~816) called the unguarded
inherent `prepare_trust_profile`, so a direct `start_remote_access(true)` in portable mode could
still write to the real Downloads folder.

Fix: a single resolver chooses the output directory — portable: `<VELORA-Portable-Data>\trust`;
installed: Downloads — and both the local command and `start()` go through it. The write path has
an authoritative `is_portable()` + `starts_with(root)` guard. Generation requires a one-time,
120 s, single-use local approval token issued over Tauri IPC only (never over LAN), plus the
existing unchecked-by-default UI checkbox and the unchanged `trust_confirmed` gate at server
start. A portable-only, approval-gated cleanup command stops the server, removes only the generated
file from the portable root, and revokes all devices, reporting each step truthfully. The operator
transfers and installs the `.mobileconfig` manually; nothing installs a certificate or changes a
system trust store. TLS (rustls), HMAC signed commands, replay protection, Host/Origin checks,
rate limits, credential isolation, local-only recovery and the LAN route allowlist are unchanged.

## Workstream D — regression protection

The S2.9 work was based on the exact PR #71 source, isolated in three worktrees, integrated
sequentially, and verified with the full frontend, Rust, provenance, portable-manifest and Windows
MSVC checks. The portable artifact is produced by the existing `portable-windows.yml` workflow
from a PR (push to the validation branch is deliberately not required), so its manifest names the
exact pushed commit. Installed VELORA 0.9.2 isolation is preserved by the existing launcher env
redirection, `AppDirectoriesOverride::Root`, disjoint credential/mutex/window identity and the
CI smoke assertion `installedProfileCreated: false`.
