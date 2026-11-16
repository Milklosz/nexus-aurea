# S2.0 architecture audit

Audit date: 2026-11-16. Source baseline: S1.4 `36dc8c1ca6bb2a61621d1541b68b721dd73b0765`. This is a source and restricted-host audit, not physical controller acceptance.

## Initial repository and installation

The parent checkout started on `codex/velora-2-s1-2-claude-usage` at `ec28205`. Its linked Git metadata is outside the writable workspace; fetch failed with permission denied. Terminal access to GitHub also failed DNS resolution. A clean local S1.4 repository was available under `work/s1-4`; the S2 integration worktree was created from its exact `36dc8c1` commit on `feature/velora-2-s2-living-room-os`. PR #57 remains a separate dependency. No main/dependency branch, installed executable, driver, firewall, display, audio route, autostart setting or Steam setting was changed by this audit.

Read-only executable metadata at the known installation path reports file and product version `0.9.2`. This proves the version of that file, not which binary a desktop user is running. Process-name queries returned no matching VELORA, Steam or Playnite processes in the tool context; that result cannot establish the complete interactive desktop state. CIM queries for HID devices and monitors were denied by the host (`Klient nie ma dostępu do zasobu CIM`). DS4 connectivity, Bluetooth transport and Panasonic HDMI attachment remain unknown.

## Existing responsibilities

| Responsibility | Actual module | Important boundary |
|---|---|---|
| Windows input acquisition | `pad_hub.rs`; native Win32 helpers in `gamepad_home.rs` | One process-wide hidden message window owns joystick/gamepad Raw Input registration and message dispatch |
| DS4 reports and identity | `ds4.rs` | Sony revisions, USB/Bluetooth report parsing, bounded identity tracking; public hashed labels rather than device paths |
| Background Home recognition | `pad_hub.rs`, `gamepad_home.rs` | S1.4 session-only explicit enablement; neutral rearm, chord timing, bounded worker dispatch |
| Frontend input ownership | `nativeControllerStore.ts`, `useNativeController.ts`, `useGamepad.ts`, `crossSourceGate.ts` | Healthy native DS4 owns navigation; browser fallback is reprised on handoff; WebView focus still required for UI actions |
| Semantic local navigation | `controllerEngine.ts`, `navIntent.ts`, `dialogNavigation.ts`, `App.tsx` | Shared repeat/hysteresis/action path; no claim that external websites receive these events |
| Session state and Home transaction | `session_orchestrator.rs`, `operation_registry.rs`, `session_store.rs` | Revision, TTL, deduplication and bounded operation/history semantics; state transition alone does not prove foreground restoration |
| Process/window lifecycle | `launch_registry.rs`, `process_table.rs`, `window_broker.rs` | Distinguishes launching process from final window; PID creation identity, window scoring, one bounded activation attempt |
| Streaming launch/resume/close | `edge_cinema.rs` | Independent service profiles/markers; tracked-window close, no whole-browser termination |
| Steam/Playnite/apps | `platform_launchers.rs`, `app_manager.rs`, `playnite_library.rs` | Allowlisted launch mechanisms, registry lifecycle and app-specific discovery |
| Control Center | `ControlCenter.tsx` plus existing service panels | Existing controller-navigable panel, not an OS-wide overlay above every third-party app |
| iPhone LAN remote | `remote_access.rs`, `remote_reliability.rs`, `remote_state_lock.rs`, `public/remote/` | Explicit start/pairing, HTTPS, signed allowlisted commands, replay protection and fail-closed vault |
| Volume/media | `music_service.rs` | System volume/media commands; no automatic audio output selection |
| Startup/recovery | `autostart.rs`, `single_instance.rs`, `session_monitor.rs` | Opt-in per-user Run entry, existing-instance activation, persisted recovery and bounded sleep-gap reconciliation |
| Display/audio observation | `display_audio.rs` | Read-only inventory/monitor; no automatic mode/route changes |
| Private data and diagnostics | `credential_store.rs`, `diagnostics.rs`, `claude_usage.rs` | Windows Credential Manager, sanitized reports, bounded local Claude status data |

## Root causes and inherited S1.4 repairs

1. Before S1.4, Home availability depended on the keyboard Control Service despite independent native DS4 navigation. S1.4 separates session Home opt-in from that service. Starting another React listener would not repair input delivery outside the WebView.
2. The existing native sink does receive/process reports independently of frontend focus by design; it deliberately suppresses ordinary frontend `State` events while VELORA is background. Background Home runs natively, while external streaming interaction was absent. Raw Input registration success is not evidence of observed background reports on this MSI.
3. A generic Edge Cinema identity previously prevented independent streaming launches. S1.4 assigns Netflix, Disney+, Max, Prime and YouTube distinct allowlisted identities, profiles and lifecycle markers. It does not supply website navigation.
4. Local physical controller intent previously shared conservative remote-device focus policy. S1.4 differentiates `LocalController` from `Device`, while keeping paired remote requests constrained. Windows may still deny foreground activation; source intent is not an OS bypass.
5. Native and virtual Gamepad API echoes can follow different timelines. S1.4 gives healthy native DS4 deterministic ownership instead of relying only on a narrow time window. Steam desktop keyboard emulation and real virtual-device coexistence remain physical tests.
6. No fallback physical Home gesture or native external-app interaction existed in S1.4. These are S2 engineering changes with separate automated and physical gates.

## Architecture choice

Retain the existing in-process PadHub native thread and hidden Win32 message window. It already centralizes the registration, drains actual `WM_INPUT` messages, handles arrival/removal and bounds subscribers/dispatch. A second sink risks replacing the process registration; a helper executable adds startup, crash supervision and authenticated IPC without measured need. No Windows service or administrator privilege is justified by the evidence.

## Measurement and evidence limits

Source-configured intervals are PadHub message wait 16 ms, held-state heartbeat 250 ms, foreground monitor 750 ms, launch registry 600 ms active / 1 s idle, display monitor 10 s and session monitor 1 s with a 6 s resume-gap threshold. These are scheduling constants, not measured input latency, CPU, memory or reconnect performance. The restricted process context did not provide a running candidate for credible performance measurements.

Follow the S2 hardware matrix before marking any couch workflow complete. Site login state, protected playback, DS4 button observability, Windows foreground policy, Steam Input and iPhone trust cannot be established by source inspection or mocked events.

## S2 integration follow-up

The integrated candidate retains the audited lifecycle modules and adds native fallback supervision, owned-foreground streaming interaction, a nonactivating pointer indicator, Control Center configuration and authenticated remote panel/application-picker commands. See the implementation documents and security review for actual behavior and remaining boundaries. These source changes close identified missing paths but do not convert blocked hardware rows to PASS. The pre-existing launcher WebView SmartScreen disable flag was removed. Independent review identified/corrected remote double-Home source escalation and partial-action acknowledgement; streaming device-epoch invalidation remains an exact-candidate verification item until its follow-up is integrated.
