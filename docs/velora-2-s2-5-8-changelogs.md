# VELORA 2.0 — sprint changelogs (S2.5–S2.8)

Engineering candidate `0.12.0-rc.1`. Evidence labels: **AUTOMATED**, **SOURCE**,
**HARDWARE NOT TESTED**. Only automated/source evidence is claimed here.

## S2.5 — Controller Intelligence

**Status: A/B/D integrated; C in progress.**

### S2.5-A — Navigation diagnostics
- Replaced fragile `error.contains(...)` classification in `spatial_navigation.rs` with an
  internal typed `NavigationError` and a closed `SpatialFailureKind` wire contract (16 camelCase
  variants) in `tv_navigation.rs`.
- Added `fallback_eligible()` and `display_label()`; ownership/authorization/target/platform
  failures are non-eligible **by exhaustive match**, not by a loose boolean.
- Preserved query duration, visited-node/candidate/rejection counters and denial information;
  error messages never carry element names or page text.

### S2.5-B — Automatic pointer fallback
- Fallback eligibility is now derived from the typed failure kind plus live authorization,
  target-currency, generation/epoch and Remote-source checks (`fallback_permitted`).
- Sticky fallback keeps `previous_mode = Keyboard`, resets the engine and bumps generation and
  controller epoch. The original failed action is never replayed as a pointer Move/Click: the
  dispatch returns a rejected receipt before any pointer action is constructed.
- Receipts now carry `modeChangedByFallback` / `fallbackNotice`; ControllerSimulator shows a
  persistent, non-alarming banner.

### S2.5-C — Home and session continuity
- Home completion reuse now requires full session identity (current session, revision, transition
  time and launch id), not revision + focus alone.
- Every authoritative real transition (`apply_transition`, `apply_transition_command`,
  `finish_launch_session_inner`) calls `streaming_control::invalidate_controller_streaming` exactly
  once, gated by the session-changed event; deduplicated, idempotent and rejected commands do not
  revoke streaming input.
- `controller_supervisor::on_session_changed()` forces neutral rearm; `pad_hub` detects real
  revision changes and no longer double-fires streaming invalidation on every tick.
- Frontend: monotonic browser-preview revision, `sessionRevisionToken`, explicit
  `establishControllerHomeReadiness` / `isControllerHomeReady` helpers, bounded native status
  reads with epoch invalidation. Remounted diagnostics cannot silently inherit readiness.

### S2.5-D — Panasonic 4K geometry
- `display_signature()` now serializes explicit ordered geometry fields; observational labels
  (adapter, connection, EDID, identity source) no longer invalidate a cached layout while
  position, mode, refresh, primary/HDR and effective DPI still do.
- Pure `physical_rect_to_logical_size` returns `None` unless DPI provenance is confirmed; no
  assumed 96 DPI. `VirtualDesktop` helpers handle negative origins.
- SystemDiagnosticsPanel shows a gated scale-vs-effective-DPI note and a separate neutral
  negative-origin note. Pointer scaling no longer hard-codes 1920×1080; it derives a bounded
  reference from `GetDpiForWindow` while keeping the `[1,2]` and `±64` clamps.

**UNVERIFIED:** live UIA provider behavior, real pointer motion, 4K accuracy and physical DS4.

## S2.6 — iPhone Remote 3.0

Status: in progress on `work/s2-6-iphone-remote-3`; changelog to be appended after integration.

## S2.7 — Cinema & Streaming Experience
- Deterministic, index-derived soak tests (64 iterations each) for repeated
  Home → launch → close/crash → restore → Home cycles. They assert exactly one `Ended` event per
  session (the single driver of one focus restoration), no resurrection after terminal, duplicate
  same-service launches collapsed into one group, recycled PIDs never adopted, cloaked windows
  never end a live session, and stale markers/HWNDs/foreign processes rejected.
- No production Rust hardening was needed: the soaks exposed no real gap, and the existing guard
  order already holds. An intentional `close_target_is_owned` behavior (process-identity based,
  revalidated by `window_broker`) was preserved rather than narrowed.
- Calm, honest error mappings for protected content, site changes and navigation failure in both
  TS adapters, explicitly stating that VELORA does not bypass DRM and does not guarantee service
  availability or compatibility.
- Tests pin exactly five official HTTPS-only web services and reject lookalike/untrusted URLs
  before launch. Lifecycle tests cover tampered→idle normalization, no duplicate launch,
  restoration predicates across repeated transitions and the absence of a second focus path.

**UNVERIFIED:** live Edge/app-mode windows, real close/crash, DRM/Widevine/PlayReady/HDCP,
site-specific navigation, authenticated YouTube, TV/HDMI/CEC and controller hardware. No
compatibility is claimed for any streaming service.

## S2.8 — Reliability & Release Engineering

- `diagnostics.rs::sanitize_text` redacts one-time pairing/bootstrap codes, device identifiers,
  HMAC/signature/nonce material, MAC-48 addresses, Windows SIDs and email-like account tokens.
  The browser-only preview mirrors these rules. Rust (9) and Vitest regressions cover the classes.
- Added `pnpm test:soak`: a deterministic 3000-transition soak of the real `CrossSourceGate`,
  asserting native-priority, cross-source dedupe and reset invariants on every accepted action.
  Wired as a dedicated CI step.
- Security review of remote pairing and session ownership added; preserve reviewed installer
  provenance chain and safe upgrade/rollback documentation.

No installer execution, stable release, Windows configuration change or hardware test was performed.
