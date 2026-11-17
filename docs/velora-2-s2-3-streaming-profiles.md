# S2.3 streaming profiles

The native registry is `tv_navigation::PROFILES`, profile version 1. All five profiles identify service, candidate strategies, stable automatic strategy, keyboard/media guidance, Back, scroll, fullscreen, limitations and official reference. `testedEnvironments` starts empty: implementation and unit tests do not establish a live service environment. Candidate-specific runtime evidence belongs in the Computer Use report and compatibility matrix.

Automatic mode currently selects a stable keyboard strategy. It does not probe a page and silently jump to pointer or spatial mode. Manual keyboard, spatial and pointer selection is exposed locally. A profile's supported strategy means the VELORA adapter exists, not that every control on every page works.

| Service | Profile policy | Media shortcut candidates | Limit |
| --- | --- | --- | --- |
| Netflix | Keyboard, opt-in UIA, bounded pointer | Space play/pause; arrows seek; F fullscreen | Player context and runtime effect required; account catalog may be unavailable |
| YouTube | Desktop site; keyboard, opt-in UIA, bounded pointer | K play/pause; J/L seek; F fullscreen; M mute | Search/results/menu/ad contexts differ; no ad or authentication bypass |
| Disney+ | Generic keyboard focus, opt-in UIA, bounded pointer | No assumed dedicated player shortcut | Use exposed player controls; provider coverage unverified |
| Max | Documented Tab/arrows/Enter focus behavior, opt-in UIA, pointer | No assumed dedicated player shortcut | Dynamic dialogs may need focused controls rather than browser Back |
| Prime Video | Keyboard, opt-in UIA, bounded pointer | Space play/pause; arrows seek; F fullscreen; M mute; C captions | Purchases, rentals, subscriptions and account controls are restricted test targets |

Back sends one bounded browser history command for the selected owned session. It is not claimed equivalent to closing every service overlay. Scroll is user-driven and requires an unobscured cursor in the owned client area. Fullscreen shortcuts are playback-gated; services without an established shortcut use explicit accessible/keyboard/pointer player controls.

Playback shortcuts require deliberate arming and a supported UIA check that focus is not an edit, combo box or password field. A provider error blocks the shortcut. Windows accepting the key does not establish a pause, seek or fullscreen effect. Unsupported media returns a visible result instead of sending several alternative commands.

Official references examined during S2.3:

- [Netflix keyboard help](https://help.netflix.com/en/node/24855): computer playback shortcuts.
- [YouTube keyboard help](https://support.google.com/youtube/answer/7631406): player shortcuts and focus caveats.
- [Prime Video keyboard help](https://www.primevideo.com/help?nodeId=GE4VW9VWJD7FM6DR): browser playback commands.
- [Max accessibility](https://help.hbomax.com/GB/Answer/Detail/000002553): keyboard navigation and exposed controls.
- [Disney+ accessibility](https://help.disneyplus.com/en-GB/article/disneyplus-en-tr-accessibility): the page returned no readable content to the research tool; no new shortcut is asserted from it.

The [YouTube supported-device guidance](https://support.google.com/youtube/answer/7582560) distinguishes computer viewing from TV devices. It does not establish `youtube.com/tv` as a supported native-TV interface on this Windows candidate. VELORA retains desktop YouTube without user-agent spoofing, browser modification or undocumented endpoint assumptions. The similarly named paid YouTube TV product is not a substitute for YouTube's television interface.

Authentication uses the service's ordinary existing browser session. No private account contents or credentials are collected. No profile changes DRM or protected playback behavior. Physical DS4 compatibility remains unverified until the MSI/laptop acceptance test.
