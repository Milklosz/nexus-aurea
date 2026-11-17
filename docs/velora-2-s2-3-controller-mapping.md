# S2.3 controller mapping

The external-streaming mapping is separate from VELORA's existing Home-screen focus grid. Input still enters through PadHub and the existing supervisor. Physical delivery is **NOT TESTED** for this candidate.

| Input | External streaming intent |
| --- | --- |
| D-pad / left analog | Directional navigation using the selected mode |
| Cross / X | Confirm; click in pointer mode |
| Circle | Browser Back; it may differ from a site's dialog Back |
| Square | Play/pause, subject to the playback gate and service profile |
| Triangle | Toggle the explicit pointer strategy |
| Right analog | Pointer movement in pointer mode; scrolling otherwise |
| L1 / R1 | Physical buttons reserved for the unchanged fallback Home chord; simulator focus probes use Shift+Tab/Tab |
| Touchpad click | Next keyboard focus (Tab); simulator previous/next focus uses Shift+Tab/Tab |
| L2 / R2 | Scroll up/down |
| Options | Reserved for safe Control Center recovery; no key sent to website |
| PS + Options | Existing primary Home, when enabled and fallback not selected |
| L1 + R1 + Options held | Existing optional fallback Home, only when deliberately enabled |

The existing fallback's selected gesture and 1.5/2/3 second hold policy are not silently changed. PS delivery is not assumed across APIs. Home stays outside spatial/keyboard/pointer selection and does not depend on a working accessibility provider.

Use keyboard section traversal when a desktop catalog does not implement arrows. Pointer clicks are deliberate X actions, never automatic selections based on page content. There is no native-TV or complete five-service compatibility claim. Text entry and account authentication remain subject to the site's normal controls; the simulator never captures passwords.

The active strategy and the explicit playback shortcut gate are visible in navigation settings. Playback commands use only the profile's allowlisted mechanism; one accepted input does not fan out through keyboard, UIA and system media simultaneously. Receipts distinguish dispatch acceptance from an observed playback effect.

See the architecture, simulator and Computer Use results for exact implementation boundaries and evidence. No physical DS4 result can be inferred from simulator button labels.
