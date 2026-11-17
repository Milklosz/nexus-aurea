# S2.3 accessibility-assisted spatial navigation

`src-tauri/src/spatial_navigation.rs` implements an opt-in Windows UI Automation provider. It operates only on a `StreamingWindowTarget` resolved by the existing Edge Cinema ownership registry. It does not discover, adopt or control arbitrary browser windows. Non-Windows platforms return an explicit unsupported error.

The native router calls the provider from a non-UI MTA worker. UIA COM objects remain on that thread. The provider creates `CUIAutomation8`, sets its connection and transaction timeouts to 100 ms, and disables automatic focus changes by Invoke. These timeout settings follow the supported [IUIAutomation2 interface](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nn-uiautomationclient-iuiautomation2). The thread arrangement follows Microsoft's [UI Automation threading guidance](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading).

## Discovery and selection

Discovery starts at the exact managed HWND and walks only its Control View subtree. The provider proves that current keyboard focus belongs to that root. When UIA exposes a modal Window pattern in the focus ancestry, discovery is scoped to that modal. HTML dialogs that do not expose this pattern cannot be assumed to have native modal semantics; this is an explicit compatibility limitation.

The traversal stops after 256 nodes, 32 levels or a cooperative 40 ms discovery budget. An additional 250 ms action work budget is checked through ancestry, property and final activation validation; exceeding it cancels the action. UIA calls themselves are synchronous provider calls: these budgets are checked between calls and are **not hard wall-clock deadlines**. A slow provider call can exceed them, up to the separately configured provider timeout or OS/provider behavior. No latency result is claimed from these constants. The provider uses no constant polling, event hooks, browser scripts or process injection.

Candidates must be enabled, visible, keyboard focusable and completely inside the current scope rectangle. Password controls are excluded. Only bounds and UIA control properties are read; names, values, page text, URLs and credentials are never read or stored. Cached candidates expire after 500 ms and are replaced when the session or modal scope changes. Failures discard all cached COM references. This intentionally trades some coverage for safe failure on moving, clipped or unavailable controls.

The scorer compares rectangle centers, excludes controls behind the requested direction, prefers overlapping rows or columns, penalizes lateral displacement, and resolves equal scores by stable traversal order. Negative screen coordinates are supported. Coordinates remain in native screen pixels supplied by UIA; the algorithm does not mix browser CSS pixels or apply a second DPI conversion.

Before SetFocus or Invoke, the provider rechecks the selected rectangle, visibility, enabled state and ancestry to the current scope; rechecks current modal scope; revalidates exact owned foreground HWND/PID/process creation identity through Edge Cinema; and checks the router's cancellation/generation callback. A stale or moved element produces an error with no click and no retry. There remains the inherent small race between the final OS identity check and the provider operation.

## Activation and feedback

Navigation calls UIA SetFocus and reports `focus-observed` only if CurrentHasKeyboardFocus confirms focus. Confirm requires the currently focused element to match a discovered candidate and expose a supported Invoke pattern. An accepted Invoke reports `invoke-accepted-effect-unverified`; it does not claim playback or another application effect. Missing patterns return a visible fallback reason. The provider never substitutes a guessed coordinate click.

There is no separate VELORA spatial overlay in this candidate. The service/browser's actual keyboard focus remains authoritative; VELORA does not draw an actionable outline around a control whose focus could not be confirmed. The existing pointer indicator is independent. A dedicated click-through spatial highlight remains a future enhancement requiring real service and fullscreen/subtitle validation.

`is_editable_focus` supports safe media routing. It checks focused Edit/ComboBox control type or IsPassword without reading contents. A failed provider/ancestry check returns an error, allowing shortcut routing to fail closed. UIA may not expose every web contenteditable control; service media behavior still needs live compatibility evidence.

## Failure and coverage

No infinite retry or automatic click follows a provider failure. The caller reports the failure and can offer explicit keyboard/pointer selection. Home remains owned by the pre-existing controller supervisor and does not depend on UIA. Offscreen virtualized items and scroll containers are not automatically scrolled or invoked; controller-driven scrolling and pointer mode remain the recovery paths. UIA discovery cannot establish service compatibility on its own.

Unit tests exercise directional selection, alignment, invalid geometry, visible containment, negative monitor coordinates and stable ties. Windows compilation, runtime provider behavior, authenticated catalogs and physical DS4 acceptance are recorded separately in the S2.3 test/release reports; this document makes no live verification claim.
