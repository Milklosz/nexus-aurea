# S2.0 streaming control candidate

Status: implemented, physically NOT TESTED. A successful `SendInput` return means Windows accepted events; it does not establish that the site navigated, selected content, or played protected media.

## Actual pipeline

The existing PadHub decodes a full semantic `Ds4Report`, including right stick and triggers. Its background route performs a nonblocking enqueue to `StreamingControl`. No React listener drives external applications. The process-lifetime bridge starts disabled and only enables while the native Home session gate is available. It installs no hook, driver, Steam mapping, service, browser extension or playback script.

The input queue holds eight reports. Button and D-pad edges are retained; unchanged reports are sampled at approximately 30 Hz. The worker discards packets older than 200 ms. Configuration and controller generations invalidate stale packets; every action checks both generations. Device/focus/target changes require neutral input before controller actions resume. A short deliberate tap pending inside the 33 ms limiter survives its release; sustained directions repeat at 160 ms. These are configured limits, not measured hardware latency or guaranteed delivery under overload.

The worker resolves only an active, distinct Edge Cinema service session with matching HWND, captured PID and captured process creation time. The ownership and foreground checks run again before Windows input. Existing unrelated browsers, desktop and games are excluded. Pointer clicks/scroll additionally require the cursor inside the owned client rectangle and an unobscured owned hit target. Modifier keys and mouse drags suspend synthetic input; taps include release events with bounded cleanup after a partial insertion.

`pointer_indicator` creates a small nonactivating, click-through native indicator while pointer mode is active above the owned foreground window. It hides independently on focus loss or stale controller feed. It creates no WebView and receives no user input. Visual rendering remains NOT TESTED; window-creation failure currently lacks a surfaced UI error.

## Mapping

| DS4 input | Candidate action | Limit |
|---|---|---|
| D-pad | Arrow keys | Site-dependent, often playback seek/volume rather than catalog focus |
| Cross | Enter; pointer mode: left click | Enter is not a universal playback toggle |
| Circle | Alt+Left | Browser history, not a guaranteed site-specific close/back action |
| Square | Tab | Focus next keyboard-accessible control |
| Touchpad click | Shift+Tab | Previous focusable control |
| Triangle | Toggle pointer mode | Rearms after neutral input |
| Right stick | Pointer motion | Only in pointer mode, bounded to owned client area |
| L2/R2 | Wheel scrolling | Only inside the owned unobscured window |
| Home gesture constituents | Suppress ordinary streaming actions | They do not become application keyboard actions |
| PS+Options / configured deliberate fallback | Native Home transaction | Physical observability and Windows activation still require acceptance |

Options opens Control Center on VELORA Home. A standalone Options press over a streaming site is reserved and does not currently open the panel; use Home then Options. No full keyboard/text-entry bridge to external website login fields is implemented. Service profiles may require one-time login; credential transfer is not attempted.

## Service evidence

| Service | Official reference examined | Candidate runtime result |
|---|---|---|
| Netflix | [Playback keyboard shortcuts](https://help.netflix.com/pl/node/24855) | NOT TESTED: catalog, login, playback, pointer and Home |
| Disney+ | [Accessibility](https://help.disneyplus.com/en-GB/article/disneyplus-en-tr-accessibility) documents keyboard navigation | NOT TESTED |
| Max | [Accessibility](https://help.hbomax.com/GB/Answer/Detail/000002553) documents keyboard operation | NOT TESTED |
| Prime Video | [Keyboard shortcuts](https://www.primevideo.com/help?nodeId=GE4VW9VWJD7FM6DR) | NOT TESTED |
| YouTube | [Keyboard shortcuts](https://support.google.com/youtube/answer/7631406) | NOT TESTED |

No site's Gamepad API support is assumed. Published keyboard/accessibility documentation is evidence for this choice of bridge, not verification of complete couch-only catalog navigation. No script is injected and no DRM behavior is changed.

## iPhone path

After the existing HTTPS/HMAC/sequence authorization, up/down/left/right/select/back may use the same owned-window native bridge. It is separately limited to 50 ms between accepted routing attempts and never accepts an arbitrary key, pointer coordinate, HWND or executable from the phone. A handled native command is not sent again to React. Volume/mute also use the native existing volume implementation. Home/menu/application-picker first use conservative native Device restoration; menu/picker then enqueue their explicit UI events. The subsequent remote Home UI reset does not make a second local restore request.

If streaming is disabled or there is no owned streaming foreground target, ordinary pilot navigation still addresses VELORA. iPhone pointer motion and typing into external websites are not implemented. Successful event enqueue is not a rendered-panel acknowledgement. Network interruption/reconnect, actual Safari pairing and playback control are NOT TESTED. No server is auto-enabled and no firewall rule is changed.

## Windows limits

[Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) is subject to UIPI; a lower-integrity candidate cannot control an elevated application. It does not report UIPI as a distinct failure cause. A foreground change between the last check and insertion is an unavoidable remaining race for global input synthesis; no injection or Windows protection bypass is used to eliminate it. Keep this candidate in Draft until real workflows establish acceptable behavior.
