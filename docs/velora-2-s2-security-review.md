# S2.0 security review

Scope: source review of S1.4 baseline `36dc8c1` plus integrated S2 streaming `04627eb`/`702de87`, remote `3b379a5`, pointer indicator `1f91d1e` and fallback supervisor `0135fcd`. This is not a penetration test or hardware acceptance. Exact final candidate tests/CI belong in the progress report.

## Retained protections

| Boundary | Existing implementation and review finding |
|---|---|
| Controller input | One read-only Raw Input owner; Sony report parsing, bounded tracking/queues, hashed public identity; no feature report writes, driver or global hook |
| Home action | Explicit session enablement and neutral rearm; local physical intent separated from remote-device policy; bounded dispatch and actual restoration outcomes |
| Process launch | Native argument arrays and allowlisted URLs/app identities rather than shell command concatenation; launch ownership tracked beyond spawn PID |
| Window control | HWND + live PID + process creation identity for owned streaming activation/close; browser processes are not killed to switch services |
| Network remote | Explicit HTTPS server start/pairing, local host/origin validation, JSON request/body cap, allowlisted commands, per-device HMAC-SHA256 verification, sequence/replay handling and rate limits |
| Remote credentials | Windows Credential Manager, UTF-16-aware size cap, serialized native store calls, cross-process transaction locks, rollback checkpoints, revocation and interrupted-recovery journal |
| Fail-closed recovery | Unavailable/damaged/rolled-back stores reject pairing/control; no automatic destructive trust rotation; user-initiated recovery only touches VELORA remote records |
| PWA | Strict CSP, same-origin request policy, no-store API responses, DENY framing and no-referrer; tokens/signatures must not enter logs |
| Claude Usage | Bounded local status-line schema/read, local path constraints, stale/unavailable states; no OAuth/API-token extraction or automatic configuration modification |
| Display/startup | Read-only display/audio observation; autostart confined to explicit per-user VELORA entry; no OS shell replacement or silent persistent changes |
| Diagnostics | Public reports must omit secrets, raw HID paths/packets, private window titles and viewing history; local numeric window/process evidence is not public diagnostic payload |

## Findings and release conditions

### External input injection must remain narrow

`SendInput` affects the actual foreground input stream, not a private browser channel. Therefore any S2 streaming action must require opt-in, a currently foreground VELORA-owned streaming window, live process/window identity revalidation immediately before dispatch, bounded rate and immediate key/button release. Do not authorize arbitrary HWND, key code, executable, script or shell input from the frontend/remote. A final focus-change race cannot be made atomic with global `SendInput`; record the limitation. Reject or suppress navigation during Home gestures and source/device handoff, and never route ordinary streaming actions into Steam, games, the desktop or unrelated browser windows.

### Remote extensions must preserve source identity

Only add enumerated actions through the existing signed protocol. Network callers must never select `HomeRequestSource::LocalController` or the equivalent unrestricted local restore policy. Existing paired-device Home intentionally refuses unsafe unrelated foreground. Authentication is not permission to turn the remote into arbitrary system input. App-switching actions must resolve allowlisted existing app identities locally.

### WebView protection restored

Baseline `src-tauri/tauri.conf.json` disabled `msSmartScreenProtection` without a documented compatibility need. The S2 remote/security integration removes that disable flag. This restores the default launcher WebView protection configuration; it does not establish external Edge playback compatibility or measured browsing protection behavior. No new browser-security bypass is introduced.

### Independent integration review

The streaming bridge is process-lifetime opt-in and requires native Home to be available. It uses a bounded queue of eight parsed reports, preserves button/D-pad edges and samples unchanged state at 33 ms. Identity resolution accepts only the exact currently foreground active allowlisted Cinema window, tied to launch identity, PID and captured process creation. Native dispatch revalidates foreground/creation time, rejects physical modifiers/drag, confines clicks/scroll to the owned client area and rejects a covering foreign window. Key/mouse taps are paired in a single call with bounded cleanup on partial insertion; no held generated key state is intentional. The final global-input focus race remains an explicit limitation.

The optional L1+R1+Options fallback is disabled by default, requires a deliberate 1500/2000/3000 ms hold, tracks each pad separately, and exposes `physicalMappingValidated=false`. Enabling it explicitly suppresses the primary PS+Options route for the session; this is an alternate configuration, not evidence that PS was observed on this MSI. Home constituent buttons suppress ordinary streaming interaction until neutral.

Independent review found and integration corrected two remote issues: Home's frontend event no longer issues a second local unrestricted restore after native paired-device restoration; failed Menu/SwitchApps event emission is no longer acknowledged as fully successful merely because native Home completed. Menu/SwitchApps still acknowledge native restore plus successful event enqueue, not a confirmed rendered panel. Their signed protocol, conservative Device policy and replay protection remain shared with the existing remote.

The pointer indicator uses a nonactivating, disabled native window with bounded latest-state publication, focus/staleness hiding and joined shutdown. Its visibility is not evidence of a website processing an action. Native window creation failure is not a hardware PASS and must not be concealed by UI claims.

Reliability review additionally required streaming generation invalidation on device arrival/removal, silence recovery and queue loss, plus prompt per-action cancellation. These hooks are integrated. The engine stores its last controller generation and resets on a generation difference rather than a separate reset flag, closing the first-packet publication race. A queued report's 200 ms age cap alone is not used as disconnect invalidation.

Focused integration Vitest on `702de87` plus then-pending remote changes passed 65 tests across five files: remote security invariants, permissions, PWA, command routing and living-room adapters (1.69 s). This is working-tree unit evidence, not final committed CI and not physical validation.

### State/installation isolation is limited

A separate EXE does not create separate Credential Manager entries, browser/session state or single-instance identity. Candidate testing must not overwrite the installation or silently migrate/delete credentials. Stop the installation before the candidate and verify source BuildInfo. Existing profiles are retained, service profiles are independent, and rollback must never delete user credentials or browser data.

### Credential/test limits

Host restrictions can deny Credential Manager and CIM access. Do not interpret such failures as an empty credential vault, an absent DS4, an absent TV, or successful recovery. Native credential tests use synthetic records and are separate from user credential operations. Every ignored/skipped/failed test must remain visible in the final evidence; green CI from PR #57 cannot validate the new S2 head.

## Security acceptance checklist

Final integration adds a controller generation separate from configuration generation. Device changes, silence recovery and bounded queue loss invalidate queued streaming state; both generations are checked before every generated action and immediately before Windows insertion. The authenticated pilot's native streaming route accepts only six named navigation actions; volume/mute reuse the existing native volume implementation without emitting a duplicate frontend action. Live effect and network interruption remain unverified.

- Exact candidate passes meaningful owned-window/foreground-denial, HID/chord/reconnect/arbitration and remote whitelist/signature/replay tests.
- Streaming state is process-lifetime opt-in, bounded and cleared on disable/disconnect/focus handoff; no retained modifiers or desktop pointer movement from stale input.
- No automatic firewall, driver, Steam Input, autostart, display/audio-route or installed-binary change.
- Public diagnostics do not reveal private titles/device paths/tokens; new status fields are sanitized.
- Source provenance identifies the exact tested binary and commit; Windows/macOS/Playnite CI are checked on that commit rather than inherited from the dependency.
- Physical Home/fallback, owned streaming interaction and Steam coexistence remain incomplete until actual observations exist.

No active secret access, exploitation, driver installation, firewall edit or input injection into a real third-party app was performed by this review.
