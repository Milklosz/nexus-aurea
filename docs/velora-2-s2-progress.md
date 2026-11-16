# VELORA S2.0 progress and release gate

**INCOMPLETE — engineering candidate; physical hardware acceptance blocked. No stable release, installation replacement or merge is authorized by this report.**

## Initial state and scope

The task checkout started on S1.2 `ec28205`, with unrelated untracked local folders preserved. Connected GitHub metadata confirmed Draft PR #57 at S1.4 `36dc8c1ca6bb2a61621d1541b68b721dd73b0765`. A preexisting local S1.4 checkout contained that exact clean commit, so S2 was branched from it into a separate integration worktree. The earlier branch, PR #57, main and installed VELORA 0.9.2 remain unchanged.

One Luna Max native implementation agent and separate application/streaming, UI, security/quality and pointer-indicator agents worked in isolated worktrees with separate file ownership. Changes were integrated in logical commits. Rust verification is serialized after integration because sharing the cached Cargo target across simultaneous test executables can cause linker locks.

## Root causes and delivered changes

1. Existing background Raw Input was already correctly centralized. Ordinary semantic frontend state was intentionally foreground-filtered; it could not drive an external browser. Added an opt-in bounded native streaming bridge without duplicating the sink.
2. Primary PS+Options lacked a physically observable alternate. Added a configurable, deliberate per-device L1+R1+Options hold candidate, disabled by default and explicitly unvalidated. It shares the existing Home permission/session pipeline and suppresses the primary recognizer while selected.
3. A pending Home edge could survive a brief silent controller interval. The native supervisor rearms on silence, device changes, session changes and configuration; streaming generations discard pre-reconnect queued reports.
4. Streaming identities and bounded native restoration introduced in S1.4 are retained. Managed apps now also resume exact captured owned windows, refuse reused/unknown identities and preserve sessions on denied activation. The UI no longer proposes Alt+Tab as the success path.
5. Remote Home formerly reissued a local unrestricted restore from React after native Device restoration. Remote Home now resets UI only. Panel/app-picker additions keep the existing signed allowlist and conservative native source. Streaming navigation and volume can execute natively while the WebView is backgrounded.
6. Control Center gains local session settings, a switching action, pointer mode, fallback timing and diagnostics. Existing volume/mute, pairing, startup opt-in, Cinema Minimal, clock/weather and Claude Usage paths are retained. Removed a preexisting argument that disabled WebView SmartScreen.

## Verification ledger

Results below distinguish implementation tests from hardware. Final delivery updates record exact commit/CI/candidate identity; interim counts must not be summed.

| Check | Observed result |
|---|---|
| Full frontend after managed resume + remote integration | 877 passed, 94 files; 20.58 s |
| TypeScript | Passed |
| Production frontend | Passed; final Vite bundle 297 ms in this environment |
| Provenance + Claude adapter Node checks | 37 passed (31 provenance + 6 adapter), 54.62 s |
| Initial integrated Rust before supervisor fixes | 363 passed, 32 failed, 2 ignored; 104.39 s |
| Initial Rust failure details | 31 Credential Manager access failures; 1 nested provenance fixture linker failure in long sandbox TEMP path |
| Integrated full Rust with short external TEMP | 379 passed, 31 failed, 2 ignored; 102.79 s. All failures are Credential Manager access; no fallback/streaming test failure |
| Final available Rust checks after generation fix and wire-contract regression | 373 passed, 0 failed, 2 ignored, 39 explicitly filtered; 5.17 s. Filtered Windows vault groups include the 31 unavailable tests plus 8 that passed in the full run; none is relabeled passed here |
| Clippy all targets | Passed with warnings; final check repeated after the generation fix |
| Formatting | Eleven modified native core modules pass rustfmt. Whole-crate formatting still fails in inherited modules; it is not reported as passed |
| Exact-head Windows/macOS/Playnite CI | Check the S2 Draft PR source SHA and checks; dependency PR #57 is not S2 evidence |
| Live desktop inspection | BLOCKED: `failed to launch codex app-server: program not found` |
| HID/HDMI detection | BLOCKED: Windows CIM access denied; connected hardware not inferred |
| Physical DS4/streaming/Steam/Playnite/reconnect/10x Home | BLOCKED; no hardware PASS claimed |
| Live Claude Usage/Cinema/clock/Zabrze weather | NOT TESTED; automated regressions do not establish live data |
| iPhone LAN pairing/reconnect/control | NOT TESTED; no firewall/server changes made |

## Performance

Only build/test durations above were measured. Live idle CPU, private working set, startup, physical HID event rate, UI responsiveness, actual focus-switch latency and reconnect time are BLOCKED by the unavailable desktop/hardware environment. Queue size, sampling cadence, repeat and timeout constants are engineering bounds, not measurements. No fabricated resource or latency claims are made.

Independent final review found a generation/reset publication race. The final implementation stores the controller generation in the runtime engine and rearms on every generation difference, without depending on a separately published reset flag. A behavioral regression proves that a held Cross cannot cross generations, while subsequent neutral/repress works. A native serialization regression also checks the exact Control Center fallback configuration/status wire contract. The engineering candidate is accepted for Draft delivery; stable S2 is rejected until real hardware acceptance.

## Startup and TV mode

Existing local opt-in autostart configuration, fullscreen startup, read-only display/audio diagnostics and recovery monitors were audited and retained. No autostart, display selection, HDMI mode, audio routing, firewall, driver or global Steam setting was changed. Current Panasonic attachment is unknown. TV disconnect/reconnect and startup controller readiness remain NOT TESTED. An installer or automatic crash-restart service is not added.

## Rollback and remaining release work

Exit the separately built candidate and reopen the unchanged installed 0.9.2 executable. Candidate and installed application share single-instance/data identity: stop one before starting the other, inspect BuildInfo source SHA, and do not treat a copied EXE as isolated credentials/session data. No installer has replaced the existing application.

Before stable release: verify the exact candidate's Windows/macOS/Playnite CI; complete every physical row in `velora-2-s2-hardware-validation.md`; validate PS/Options or the deliberate fallback with real buttons; verify service navigation/login/playback and real application resumption; measure runtime performance; test paired iPhone/network loss if available; resolve observed failures and rerun relevant checks. Keep the PR Draft while any mandatory gate is blocked.

Minimum initial user-assisted proof: run the separate candidate, enable session Home in Control Center, release the pad, open Netflix and try PS+Options. If Home fails, record FAIL and recover with a configured alternate remote or the keyboard for setup only; that attempt is not couch-only PASS. Locally select the provisional fallback, release all gesture buttons, and validate its deliberate hold; enabling it suppresses primary PS+Options. Then perform Netflix → Home → YouTube → Home, Steam → Home, Playnite → Home, reconnect, and ten Home cycles. Record actual foreground and diagnostics at each failure, not only a chord counter.
