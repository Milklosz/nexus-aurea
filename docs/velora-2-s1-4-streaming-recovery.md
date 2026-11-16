# S1.4 Edge Cinema streaming recovery

## What changed

Edge Cinema now treats Netflix, Disney+, Max, Prime Video, and YouTube as five
independent services inside the existing `LaunchRegistry`. Each service has a
fixed app id (`edge-cinema:<service>`), its own stable Edge profile at
`%LOCALAPPDATA%/VELORA/EdgeCinemaServices/<service>`, and a non-secret marker in
that profile. The accepted URLs and service directory names come from a closed
native allowlist.

The former `VELORA-EdgeCinema` profile remains untouched. VELORA does not read,
copy, or migrate its cookies, credentials, or other profile data. Each new
service profile needs a one-time sign-in, after which that service's session
persists between launches.

## Session and window behavior

- Different services can remain active together. Launching a service already
  active selects its existing registry launch, updates `SessionContext`, and
  makes one bounded foreground request for its tracked window.
- If the target is missing or Windows denies focus, the launch stays tracked
  but the command returns a clear error instead of claiming the window came
  forward.
- The selected window is checked against its observed HWND, owning PID, and
  process creation time. Close requests use that exact launch and service
  marker and post `WM_CLOSE` to one validated window. VELORA never terminates
  Edge processes.
- The session projection follows `SessionContext.launch_id` while Cinema is
  selected. Outside Cinema it reports the latest active Cinema service, or
  the most recent terminal service record when none remain active.
- Recovery and marker cleanup are per profile. A stale report or close request
  cannot close or clear a sibling service's marker.

## Limits and verification

Software tests cover the fixed URL/service mapping, profile isolation,
same-service launch grouping, marker PID reuse, session selection, and foreign
or sibling-window rejection. Windows foreground arbitration, real Edge window
ownership, streaming playback, DRM, and controller interactions still need
physical validation; no hardware PASS is claimed.
