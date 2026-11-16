# S2.1 — iPhone Remote

## Changes

- The remote shows distinct checking, reconnecting, connected, LAN-server-off, offline, unreachable, and pairing-required states. A manual connection check appears when the LAN server is off or unreachable. Controls stay disabled while status is being checked.
- The lower navigation controls sit in a fixed thumb-area dock with iPhone safe-area insets. The page keeps enough scroll space for pairing, volume, profiles, and connection details.
- An HTTP 401 invalidates the saved device authorization, clears its key when storage allows, and requires a new pairing. If deletion fails, the client writes a non-secret rejection marker when possible and blocks the rejected key in the current page.
- An HTTP 409 is shown as an uncertain command result. The user is told to check the current device state before manually repeating an action. The PWA does not queue, replay, or resend commands after a timeout or reconnect.
- The service worker caches only same-origin GET shell assets. It bypasses non-GET requests and `/api/` paths, and its cache version is bumped so installed clients receive the update.

## Existing action and security boundary

The page continues to send only the existing `RemoteCommand` values. **Aplikacje** uses the existing `switch-apps` route; choosing a tile remains in VELORA's existing Home flow and its remote-selection permission checks. The PWA adds no direct favorite-launch action, arbitrary app target, or native command. It also adds no touchpad or pointer input because the existing remote allowlist has no secure native pointer action.

HTTPS trust, HMAC-SHA256 signatures, non-exportable WebCrypto keys in IndexedDB, monotonic persisted sequence numbers, server pairing nonce/code checks, and `credentials: "omit"` remain unchanged. Connection status remains the existing read-only response; no app, library, or window details are exposed. The pairing code expires; a saved device key is treated as invalid only when the server rejects it or the user revokes it.

## Validation

`src/__tests__/remotePwa.test.ts` covers the reconnect affordance, safe-area dock, cache revision and API bypass, rejected authorization, command ambiguity messaging, and the absence of automatic command replay. Physical iPhone and live Windows-host checks remain separate validation tasks; this change does not claim those checks ran.
