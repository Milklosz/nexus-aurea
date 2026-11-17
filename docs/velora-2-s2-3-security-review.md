# S2.3 native navigation security review

This engineering review covers the changed native navigation, UIA provider, local simulator, profiles and their UI boundary. Live validation and exact-source tests are recorded in the release gate. It is not a claim of DRM, hardware, authenticated-LAN or whole-browser security certification.

## Trust boundaries

| Boundary | Enforcement |
| --- | --- |
| Physical input to VELORA | Existing PadHub parsing and hashed identity; bounded reports, neutral rearm and generation revocation; no new global hook or driver |
| VELORA to external window | Registry-owned active Cinema launch; exact HWND/PID/captured creation identity and foreground revalidation |
| Deliberate simulator recovery | Native-captured session only; no caller HWND/PID; unrelated foreground must not be silently controlled |
| External webpage to native app | Separate Edge process/window; no page injection, WebView bridge or remote Tauri capability grant |
| Simulator IPC | Native debug availability, local main WebView, closed actions, sequence/generation and bounded work; disabled in release |
| Production preference IPC | Local main WebView, closed mode and explicit session-bound playback arming |
| LAN remote | Existing HTTPS/HMAC/replay command allowlist; no simulator/coordinate/key/script endpoint; diagnostic controls deny remote selection |
| UIA provider | Exact target root and scoped ancestry; bounded traversal/cache; no text, name, value, URL or password content reads |
| Diagnostic export | Fixed fields/codes and public service IDs only; no raw session IDs, errors or page content; at most 64 receipts |

## Review corrections

The coordinating review found and requested correction of mutex re-locks in preference/capture/cancel status responses, missing production session selection for media arming, and an overly broad localhost origin predicate. These are implementation defects discovered during development, not inherited baseline failures. They were corrected before committing the candidate and covered by the completed-source automated checks. Capture/config/cancel generation changes prevent queued work crossing session changes; a caller timeout must revoke unexecuted work rather than allow a delayed invisible command.

The UIA specialist independently reviewed scoped element ancestry and final authorization. The provider rechecks candidate bounds, visibility, modal scope, exact foreground ownership and a router cancellation callback before SetFocus/Invoke. A provider error does not trigger an automatic alternate click or keyboard retry because the provider may already have acted.

## Media and pointer policy

There is one selected media mechanism per action. A playback arm is bound to an explicitly selected owned session. Editable/password/combobox focus detection fails closed; supported service keys still report effect unverified. Unsupported service media actions return an explicit error. Global current-player selection is not proof of ownership and is not used for a generic streaming toggle. System volume/mute is an explicit separate Core Audio operation with endpoint identity/readback.

Pointer movement is deliberate user intent, clamped to the owned client area and translated through the virtual desktop. Click and scroll additionally require an unobscured owned hit target. No content-driven autonomous click, fixed service-coordinate map, purchase sequence or private account traversal exists. The built-in simulator scenario has no Confirm/click. Manual confirmation still requires inspection of the real screen.

## Residual limitations

- A foreground change can occur after the last `SendInput` identity check; Windows provides no atomic scoped SendInput operation. UIPI denial remains a failure, never a reason to elevate or bypass protections. See [Microsoft's API contract](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
- UIA calls are synchronous cross-process provider calls. Cooperative budgets and provider timeouts do not guarantee a hard realtime deadline or cancel an operation already accepted by a provider. A final-check/provider-operation race remains.
- Custom web editable controls and HTML modals may not expose all UIA semantics. Playback arming and explicit fallback remain necessary; no sensitive values are read to compensate.
- A browser window's trusted launch identity is not a proof of the current document's origin after user navigation. VELORA authorizes the exact managed window for deliberate user input; it does not treat website text as instructions or native authorization.
- Closing a diagnostic panel or pressing Cancel cannot undo a click/key already accepted by Windows. The UI states this and never retries an unknown outcome.
- No physical DS4, Steam Input coexistence, elevated-window, authenticated-LAN, protected playback or installer-upgrade acceptance is inferred from source/unit tests.

No security features, browser packages, default audio endpoint, firewall, certificate trust, startup setting, service or installed VELORA executable is changed for this sprint. Candidate sessions and runtime settings are reversible by exiting the separate candidate. The installed executable's before/after hash and rollback are recorded in the delivery evidence.
