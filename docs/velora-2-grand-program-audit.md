# Grand Living Room audit and shared interfaces

Audit date: 2026-11-16. Engineering candidate only.

## Source and preservation

Original checkout: branch `codex/velora-2-s1-2-claude-usage`, HEAD `ec28205c97cc278290f45dc020d9da8c03618a0e`; untracked `.codex/` and `target-int/` preserved. Its Git directory is outside the writable workspace. Terminal DNS and Git fetch are unavailable. A separate repository under `work/grand` imports GitHub source blobs, checks each Git object SHA, reconstructs the complete tree and exact source commit `05f7235bb4680df03f9147bad055bb542cd6524e`, and uses a shallow boundary there. Existing local objects are read through Git alternates. PR #58 remains an open Draft based on S1.4. Installed executable metadata reports 0.9.2; this does not prove running source.

## Architecture gate A

Reuse LaunchRegistry as the sole launch/process ownership authority, WindowBroker as the sole window activation authority, SessionOrchestrator for Home transitions, PadHub and controller supervisor unchanged. Do not build another process tracker or native input sink. Session Manager 2.0 is a sanitized projection of existing registry state with explicit actions, not a competing lifecycle authority.

Application identity is the existing streaming service ID at Home; map managed IDs only at existing launch boundaries. Recents store only successful VELORA launches. Native sessions use existing launch IDs, exact owned HWND/PID/process creation checks and bounded lifecycle state. No persisted live HWNDs. Smart Home persists versioned IDs only. Native audio reuses current Core Audio support. Remote extends existing HTTPS/HMAC/nonce checks and DOM permission routing; no new unauthenticated endpoint. TV mode changes only the VELORA window through explicit local action. Autostart stays opt-in; no system setting changes during development.

## Workstream ownership

A: Smart Home state, standalone panel and tests. Root integrates App.tsx.
B: native session projection, standalone sessions panel, service, lifecycle tests.
C: native audio and standalone audio panel. Root registers commands and integrates Control Center.
D: existing remote assets and remote regression tests; no auth weakening.
E/F: GamingHub enhancements and standalone TV panel/native commands. Root integrates controls.
Quality: independent read-only security review followed by root verification.

Agents must not edit App.tsx, ControlCenter.tsx, lib.rs, package versions or shared global CSS concurrently. Return exact registration/integration instructions. No agent commits or pushes shared state.

## Reuse, gaps and risks

Already present: Steam local discovery, Playnite extension/manifest, installed/running app inventory, owned streaming resume, Core Audio read and volume hotkeys, display/audio diagnostics, autostart registration, single-instance handling, persisted Home recovery, authenticated remote PWA, sanitized diagnostics and provenance. Main gaps: discoverable persistent favorites/recents, consolidated session presentation, absolute volume/mute status controls, practical TV window selection, remote reconnection UX and game collections.

Existing overlap between cinema session, launch registry and high-level session state requires projection, not replacement. Native foreground denial must remain visible. Browser previews cannot prove native ownership, volume, device discovery or controller behavior. Never claim success from launch requests alone.

Computer Use initialization imports @oai/sky, but list_apps fails: `failed to launch codex app-server: program not found`. The documented entry point is used; no custom helper or unrelated system installation is attempted. CU scenarios are BLOCKED pending a working helper. Physical DS4/iPhone/TV checks remain BLOCKED by intentional deferral. No installer replacement is authorized.
