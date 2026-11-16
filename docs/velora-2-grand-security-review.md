# Grand Living Room security review

Review date: 2026-11-16. Scope: source inspection of exact S2.0 baseline and the Grand Living Room changes. This document is a source review, not a penetration test, hardware acceptance, signature verification or proof of live Windows behavior. Automated test/build results are recorded separately by the integration owner.

## Threat boundaries retained

- The main Tauri window runs bundled code with a restrictive CSP. The opener capability accepts only the named official streaming sites and Playnite download site. External streaming remains in separately launched owned Edge windows, not a newly IPC-enabled remote Tauri webview.
- The LAN remote uses HTTPS bound to a selected private IPv4 address. Native request middleware validates Host and Origin, sets no-store/no-referrer/nosniff/frame denial/CSP headers and limits request bodies to 4096 bytes. Pairing must be initiated locally; its code expires after 60 seconds and is consumed on success. Attempts and paired-device counts are bounded.
- Commands are a fixed enum, authenticated by HMAC over device/sequence/action. The server serializes authentication, reserves sequence state durably through the existing Credential Manager and cross-process vault lock, then performs the side effect. Exact completed retries can be acknowledged without executing twice; ambiguous or changed replays are denied. There is no new arbitrary native-command endpoint, caller-provided process ID, window handle, key injection payload or shell command.
- Existing window action paths compare captured process creation identity with live PID ownership before activation/close. Safe close means a scoped WM_CLOSE request; it does not prove the window closed and never grants authority to kill all browser processes.
- Autostart remains a local explicit action scoped to the current user's VELORA Run value. The installer does not enable it, replace Explorer or create a watchdog. Audio/display changes must be explicit user actions and must not alter global display topology or default audio output automatically.
- Application identity and current-user NSIS upgrade hooks remain the existing identity. Existing settings are not deleted by these changes. Installation and rollback still require the documented user-controlled procedure.

## Findings and review obligations

### GSEC-01: remote admin precedence (inherited hardening gap)

`canRemoteSelect` in the baseline allowed a `data-remote-allow` ancestor to override an administrative marker, despite its comment stating that admin always denies. Existing tests explicitly expected this override. A newly nested broad allow panel could unintentionally grant paired-phone access to local-only controller, trust or startup controls. **Corrected in the integrated source:** any admin ancestor denies activation; regression cases cover allow inside admin and admin inside an allowed panel, including outside dialogs. New lifecycle and TV controls carry the recognized admin marker.

### GSEC-02: diagnostics redaction is deliberately limited

The existing typed report omits remote credentials and private window titles, bounds export size, and redacts common profile paths/control characters. **Strengthened in the integrated source:** credential-key patterns, authorization/bearer material, HTTP(S) URLs, IPv4 and standalone IPv6 details redact the entire affected line. The new remote diagnostic summary contains only booleans and a count, excluding device names, origins, secrets and certificate paths. The string sanitizer still is not a universal secret detector. New modules emit fixed, non-sensitive diagnostics and must not pipe arbitrary page text or authentication payloads into public reports. The session projection uses fixed labels and fixed failure messages. No local machine report is included in this public source review.

### GSEC-03: runtime trust and signing remain external gates

Local source review cannot validate real Credential Manager availability, certificate installation/trust on iPhone, foreground restrictions/UIPI, HDMI topology or physical controller routing. The Computer Use helper fails before enumeration with `failed to launch codex app-server: program not found`; no live success is claimed. An integrity hash verifies bytes against a manifest but does not sign a Windows installer or prevent SmartScreen prompts. Do not disable or bypass Windows security to run the candidate.

## Incoming implementation review

Initial Session Manager inspection: it projects LaunchRegistry rather than introducing a new authority; frontend commands supply a bounded launch ID only. The native adapter resolves live ownership. Resume calls the exact owned activation path and reports Windows denial. Close delegates to the existing service marker/identity adapter and describes acceptance as a request, not proof of exit. Raw HWND/PID/title/URL/path and external error text are omitted from its presentation.

Initial Smart Home inspection: persisted configuration contains only an allowlisted application ID list with version and bounded recents/favorites; malformed/oversized data has a safe fallback and newer-version data is preserved. Storage failure remains visible. No streaming account history is read. Final review must confirm the integration records successful launches only.

Audio review: the native command validates finite 0–100 percent values and a bounded hashed endpoint identity. The existing Core Audio apartment/device helpers are reused. Writes target the endpoint the user observed and fail if the current default differs; there is no default-device switch or per-app volume override. Reads and changes use blocking worker dispatch. UI writes follow explicit button actions and report failure.

TV review: IPC accepts a canonical hashed display ID and fullscreen flag, then resolves the monitor against actual enumeration. Caller-supplied geometry, process identity and global topology commands are absent. Stored state contains a version, display hash and fullscreen preference. Placement changes only VELORA's main window. Saved selection loss falls back to the primary display in windowed mode; `--windowed` wins over saved fullscreen. The hash includes monitor name, position and resolution, so topology changes may require explicit reselection. Restore uses a nonblocking configuration lock to avoid overriding a concurrent user choice.

Gaming review: new collections store only bounded numeric Steam IDs; visible entries intersect the actual installed-game inventory. Names/paths/URLs are not persisted by collections. Game launch remains behind the existing native allowlisted Steam-ID route and local library verification. Existing Playnite manifest support remains its separate validated integration; the new Steam collections do not invent Playnite data or account ownership.

Desktop recovery review: the new native exit/restart commands take no executable or arbitrary command argument, preserve clean-shutdown metadata, and operate only VELORA. Their UI is local-only with an admin marker. No persistent service, Explorer replacement or restart loop is added.

Remote final review: the existing command enum/HMAC transport and native server authority are unchanged. Reconnect/status reads do not resend commands. The 401 path invalidates its in-memory credential before storage cleanup, attempts removal or a non-secret rejection tombstone, and keeps the current page fail-closed. A cache-delivery issue found during review was corrected: service-worker revision `command-6` triggers a new shell cache, and non-GET plus `/api/` requests explicitly bypass shell caching. No new unauthenticated app, library or window metadata response was added. Client connection state means HTTPS reachability; it does not independently prove that a stored key is still authorized until a signed command is accepted.

Residual reliability limit: two PWA tabs sharing the same stored device credential can race the inherited read/increment/write sequence flow. The native sequence checks fail closed rather than granting duplicate authority; ambiguous or rejected commands may require a manual connection check or re-pairing. This review does not claim concurrent same-credential-tab acceptance. Separate paired device IDs remain separate authenticated sequences.

## Gate E conclusion

**SOURCE REVIEW PASS for this engineering candidate:** no unresolved critical/high issue was identified in the reviewed new source. GSEC-01 and the remote shell cache revision issue were corrected before this conclusion. This is a bounded source assessment, not a claim that all defects have been ruled out. Native Credential Manager, real LAN/TLS/browser trust, Windows foreground behavior, installer execution and physical devices remain their separate automated/live/hardware gates.

The integration owner reports focused integration and adapter/provenance checks passing and available native tests passing with vault-dependent cases explicitly filtered. This reviewer did not substitute those filtered cases with a source inspection or mark the unavailable live checks as passed. Final exact test counts, inherited failures and artifact hashes belong to the integrated progress/release evidence.
