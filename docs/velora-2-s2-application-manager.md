# S2.0 application and window management

VELORA retains its existing application-management stack rather than introducing another independent lifecycle store. `app_manager.rs` and `platform_launchers.rs` discover/launch apps; `edge_cinema.rs` handles streaming sessions; `launch_registry.rs` tracks launches; `session_orchestrator.rs` manages entertainment session state; `window_broker.rs` owns window observation/restoration.

## Session identities

| User entry | Lifecycle identity | Resume/close boundary |
|---|---|---|
| Netflix | Service-specific Edge Cinema app ID/profile/marker | Only validated owned service window |
| Disney+ | Independent Disney service identity/profile/marker | Same |
| Max | Independent Max service identity/profile/marker | Same |
| Prime Video | Independent Prime service identity/profile/marker | Same |
| YouTube | Independent YouTube service identity/profile/marker | Same |
| Steam | Platform launch + tracked client/game lifecycle | Client discovery and process/window evidence; no blanket process termination |
| Playnite | Platform/library launch + tracked lifecycle | Installed client/manifest support required |
| Apple Music | Existing music service and managed-app discovery | Preserved existing integration; not silently treated as an Edge streaming profile |

The state-machine `Cinema` category remains shared, while `SessionContext.app_id` and registry launches distinguish providers. This is category reuse, not provider identity collapse. Session markers bind launch identity, service identity and process creation evidence. Profiles are separate from the legacy profile and may require one-time site login; credentials/cookies are not copied.

## Launch, Home, switch and close

1. A controller launch preflight checks native Home readiness before the user leaves VELORA. Cancellation/timeout invalidate the pending launch; late status replies cannot launch an app after cancellation.
2. A launch captures baseline process/window evidence and creates a bounded registry entry. Process creation time protects against PID reuse; final windows are discovered instead of blindly equating the spawn PID to the browser HWND.
3. Home submits an explicit return transaction, validates/recovers the VELORA window, performs one bounded foreground request and reports its actual outcome. It does not close the external app.
4. Selecting an already active streaming provider attempts validated window resume. Selecting another provider uses its independent session identity. If Windows denies focus, the session remains tracked and the refusal is returned rather than falsely reporting successful switching.
5. Close is a distinct owned-window operation. It validates HWND/PID/creation time against session ownership and posts a window close request. It does not kill all Edge/browser processes. Invalid/recycled identity is rejected.

## Focus policy

Explicit local UI/controller gestures and remote-device gestures have different policies. A physical local-controller Home uses local user intent; paired iPhone/DualSense `Device` requests remain conservative around unrelated foreground applications. Automatic process-exit recovery is bounded to session ownership. Windows foreground denial is a supported reported outcome, not a reason to use infinite focus loops, `AttachThreadInput` hacks or global policy changes.

The broker observes visibility/minimized state, restores/shows as needed, calls `SetForegroundWindow` once and briefly observes foreground. Its configured observation polls are not performance claims. A later third-party focus steal still requires hardware evidence and separate diagnostics.

## Recovery and limitations

S2 extends the registry's captured active process identities to managed applications as well as Cinema. Launch watches are scoped to the captured root and descendants; root HWNDs are eligible where the application itself owns the window. `launch_managed_app` first attempts exact captured-window resume for an active app session, verifies live PID/creation identity immediately before activation, and reports `resumed` only after actual foreground acceptance. A denied activation preserves the tracked session and produces a visible failure. The existing App Manager now exposes **Wznów** rather than instructing the user to use a keyboard shortcut. Untracked or ambiguous preexisting application windows are not silently adopted.

The registry explicitly reselects the resumed launch into the session orchestrator. Streaming services retain independent profiles/launch IDs from S1.4. Returning Home does not close them; reopening the same service resumes a validated owned window when available. These are implemented paths with policy/UI tests, not evidence that Steam/Playnite/Edge focus actually changed on the MSI.

Registry start/exit deadlines, process/window disappearance, marker reconciliation and orphaned session recovery are already present. On a detected sleep/resume scheduling gap, VELORA reconciles launch, window and session state. Controller reconnect is handled by native input lifecycle and frontend neutral rearming, not by restarting browser processes.

No real Netflix → Home → YouTube, Steam → Home or Playnite → Home success is established by this source audit. Installed Playnite availability and browser site login are external prerequisites. Native streaming interaction is documented separately and must use the same owned foreground target rather than an arbitrary browser window.
