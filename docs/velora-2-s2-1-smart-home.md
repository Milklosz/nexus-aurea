# S2.1 Smart Home

IMPLEMENTED: a compact `SmartHomePanel` opens Favorites and Recently Opened on deliberate selection, preserving the existing dock and Cinema Minimal background. Native buttons expose the existing `data-remote-allow` permission marker. Users can pin/unpin, move favorites earlier/later, and restore defaults. The optional `unavailableIds` prop disables known unavailable apps; removed identities are omitted. Keyboard and remote navigation use the host panel's existing focus handling. Physical controller input is NOT TESTED.

`services/smartHome.ts` is the shared external store. Local storage key `velora.smartHome` contains only `{version:1,favorites:[appId],recents:[appId]}`. It does not collect browser history, URLs, window titles, cookies or account data. IDs are whitelisted against VELORA services. Recent IDs are unique, bounded to eight and ordered by most recent successful launch/resume. No timestamps or video progress are inferred.

Integration: render `<SmartHomePanel onLaunch={id => ...existing openService path...}/>`; call `recordSmartHomeLaunch(service.id)` only after successful native launch/resume. Clicking the panel never records a recent app before the launch result. This component does not establish live session state; the native Session Manager owns Resume.

Storage supports migration of version 0 `{favorites,recentApps}` to version 1 on the next explicit change. Corrupt, oversized and unknown data safely fall back. Newer versions are protected against overwriting; edits remain in memory with a visible warning. Storage read/write denial similarly keeps the current session usable and shows that changes are unsaved. Subscribers share one stable snapshot; cross-window local storage events refresh the store.

AUTOMATED TEST coverage: successful-launch MRU persistence, identity filtering, favorites editing/reordering/defaults, version migration, corrupt/oversized input, unavailable storage, future-version preservation, stable snapshots and subscription lifetime; panel disclosure, launch identity and unavailable-app controls.

COMPUTER USE VERIFIED: BLOCKED by the unavailable Computer Use app-server. PHYSICAL HARDWARE VERIFIED: BLOCKED / deferred. Automated test results are reported in the program test log, not inferred from implementation.
