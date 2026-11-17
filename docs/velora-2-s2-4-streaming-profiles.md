# S2.4 — streaming profiles and navigation policy

Evidence: **SOURCE** unless a separate exact-build Computer Use receipt and observed effect are cited. Five profiles remain part of the same native normalized route. A documented shortcut is not catalog compatibility or a playback-state acknowledgment.

## Strategy selection

Automatic directional navigation uses bounded UIA rather than treating desktop page arrows as proof of tile focus. Keyboard section traversal and supported, explicitly armed media shortcuts remain single-command paths. Explicit Keyboard mode remains available. Spatial failure can switch the mode to Pointer, with a visible state change and a rejected current action; it must not replay that action as a click or send a second alternative command. Pointer remains selected until deliberately changed. Home stays on the existing independent orchestrator.

UIA counters contain provider/focus availability, visits, rejection categories, discovery time, candidate count, cache and budget state. They contain no text, names, values, URLs or credentials. Query budgets are cooperative bounds on traversal and provider calls; they cannot make a third-party synchronous provider instantly cancellable.

## Player commands — primary documentation checked 2026-11-17

| Service | Candidate keyboard route | Boundary |
| --- | --- | --- |
| YouTube | K play/pause; J/L seek; F fullscreen; M mute; C captions where enabled in the native allowlist | Player context matters. Entering search text is not supplied by the simulator. [YouTube keyboard help](https://support.google.com/youtube/answer/7631406) |
| Netflix | Space play/pause; arrows seek; F fullscreen; M mute | These are player commands, not profile/catalog navigation. Authentication may block runtime testing. [Netflix keyboard help](https://help.netflix.com/en/node/24855) |
| Prime Video | Space play/pause; arrows seek; F fullscreen; M mute; C captions | Never exercise purchases, rentals or membership controls. [Prime Video keyboard help](https://www.primevideo.com/help?nodeId=GE4VW9VWJD7FM6DR) |
| Disney+ | No generic player shortcut added without verification | Prefer explicitly focused/exposed controls or reviewed pointer actions. Protected workflows remain blocked without a legitimate session. |
| Max | No generic player shortcut added without verification | Dynamic catalogs/modals require real focus/geometry validation. Public surfaces do not prove protected playback. |

Native media commands require explicit arming for the exact managed session and a non-editable focus check. Changing sessions disarms the old target. The guard intentionally rejects uncertain providers and search/login/editable focus rather than typing a media letter into a form. No global media broadcast or volume adjustment of unrelated application sessions is added.

## Pointer and keyboard boundaries

Pointer movement and clicks are restricted to the unobscured owned client area, with physical virtual-desktop coordinate normalization, negative monitor origins and a final process/foreground check. Simulator cursor persistence prevents the mouse used to click simulator controls from becoming the next click target. A successful pointer send still needs an observed hit-test effect.

Tab/Shift+Tab section actions can be used to inspect native browser focus. Browser-history Back is not interchangeable with every site's dialog dismissal. No automatic chain of Escape/Back/Enter alternatives is sent.

The simulator has no arbitrary text, URL, key-code, process or window-handle command. Consequently a complete external-service search query cannot be claimed from a search box focused by navigation alone. Record text entered with ordinary Computer Use as intervention. A future external text-entry design requires its own scoped interaction model, rather than exposing unrestricted native typing over LAN.

Actual results and open gates: [compatibility matrix](velora-2-s2-4-compatibility-matrix.md), [validation protocol](velora-2-s2-4-validation-protocol.md). Physical DS4 remains deferred; no shortcut documentation or simulated action closes that gate.
