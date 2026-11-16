# Session Manager 2.0

## Implementation

`velora_session_manager.rs` is a bounded, sanitized projection of the existing LaunchRegistry. It does not add a competing lifecycle registry, process watcher, persistent window handles or restart loop. Registry events and window-focus notifications refresh the panel; inventory is also manually refreshable. The existing registry watcher owns exit/crash reconciliation. Up to 20 retained sessions are projected with launch ID, fixed application identity/name, application type, lifecycle state, launch timestamp, latest observation timestamp, capabilities and a generic recoverable failure. Latest observation is not falsely labeled playback progress or last activation time.

States distinguish launching, running, foreground, background, unavailable, exited and failed. Not-running applications are absent; their normal launch actions remain on Home. Missing/recycled owners and pending exits suppress Resume. A live HWND owner must match captured process ID **and process creation time**. IPC accepts a bounded launch ID, never HWND/PID, shell text or a URL. Resume reuses the existing orchestrator selection transaction and WindowBroker's exact-owned activation check. Windows focus refusal is an error, not successful resume. No new window is launched by Resume.

Close requires explicit confirmation and delegates the existing Edge Cinema close adapter. That adapter validates the selected service marker, current active launch, exact window and captured identity before posting WM_CLOSE to one owned window. Other applications do not expose Close. A close receipt reports a request; only the native watcher can subsequently report termination. No browser processes are killed. Streaming video timestamps, account data, private window titles and arbitrary native errors are not projected.

`SessionsPanel` uses accessible native buttons and the existing `data-remote-allow` route. Controller/remote input reaches the same controls through the application's current focus router; physical behavior remains unverified. The user sees a second confirmation before closing a service. No additional network endpoint is added.

## Integration

Register module `velora_session_manager` and commands `get_managed_sessions`, `resume_managed_session`, `close_managed_session` in `lib.rs`. Place `<SessionsPanel />` in Control Center. Frontend service: `src/services/veloraSessionManager.ts`.

## Verification and limits

Tests cover stale/terminal lifecycle, PID-reuse suppression, diagnostic redaction, malformed IDs, exact IPC payloads, browser preview refusal, focus denial and explicit close confirmation. Live Windows session switching and unrelated-window preservation require Computer Use; currently BLOCKED because its app-server helper cannot launch. Physical controller and iPhone validation are deferred. This feature resumes application windows, not streaming content or game save state. Session metadata remains owned by existing registry/storage; no second persisted session file is introduced.
