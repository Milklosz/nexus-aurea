# VELORA by Milklosh Studio — v0.9.2 · Grand Cinema

VELORA is the current product name for the Grand Cinema desktop launcher. The visual style and entertainment layout remain part of Grand Cinema.

## Windows installation and data compatibility

The Windows build produces one per-user NSIS installer. When it finds the existing NEXUS AUREA installation, the installer updates that program folder in place and keeps the Tauri identifier `pl.nexus.aurea`. This preserves the existing stable profile at `%LOCALAPPDATA%\pl.nexus.aurea`; the identifier and executable filename remain legacy compatibility details.

The separate Test profile at `%LOCALAPPDATA%\NEXUS-AUREA-Test` is not imported or deleted. The installer does not merge WebView profiles.

### GitHub Actions artifact

1. Open the repository's completed CI run.
2. Download `VELORA-Windows-x64-<SHA>` and extract the ZIP.
3. Run the `VELORA_<version>_x64-setup.exe` installer.

The workflow builds one Windows installer artifact. It does not create a GitHub Release unless a version tag is pushed.

### SmartScreen

The installer is not publisher-signed, so Microsoft Defender SmartScreen may show an unknown-publisher warning. Use only a verified installer from this repository. Do not disable Windows security protections to bypass warnings.

## Uruchomienie developerskie na Macu

Wymagane są Node.js 22.12 lub nowszy, Rust stable oraz narzędzia kompilacyjne Xcode.

```sh
pnpm install
pnpm tauri dev
```

Przydatne polecenia:

```sh
pnpm test
pnpm build
pnpm tauri:windows
```

## GitHub Actions

Workflow `CI` uruchamia się po pushu, pull requeście oraz ręcznie. Na macOS i Windows/MSVC instaluje zależności z zamrożonego `pnpm-lock.yaml`, uruchamia testy, buduje frontend React/TypeScript i sprawdza backend Rust. Windows buduje rzeczywisty instalator NSIS x64 i przesyła go jako artefakt; macOS kompiluje aplikację bez tworzenia pakietu. Zależności pnpm i pliki kompilacji Rust są buforowane.

Workflow ma domyślne uprawnienie `contents: read`; tylko job publikujący tagowane Releases otrzymuje `contents: write`. Nie są wymagane sekrety ani token zapisany w repozytorium.

## Aplikacja

- Zegar w formacie 24-godzinnym dla strefy `Europe/Warsaw`.
- Bieżąca pogoda Zabrza z Open-Meteo, odświeżana co 15 minut. Błąd sieci pokazuje czytelny status, zachowuje ostatni poprawny odczyt i nie blokuje interfejsu.
- Nawigacja strzałkami, klawisz `X`, Enter przez natywną aktywację przycisku oraz Gamepad API (kierunki, przycisk 0 i menu 9).
- Pięć oficjalnych stron usług otwieranych w domyślnej przeglądarce. Aplikacja sprawdza HTTPS i dokładną nazwę hosta, a Tauri ogranicza uprawnienie openera do tych domen.
- Wspólny punkt wejścia nawigacji dla klawiatury i pada, do którego można później podłączyć sterowanie LAN.

## Poza zakresem v0.3

Automatyczne aktualizacje, AirPlay, pilot iPhone/LAN oraz test fizycznego pada nie są jeszcze skonfigurowane. Instalator nie jest podpisany. Projekt graficzny Grand Cinema i działające funkcje aplikacji pozostają bez zmian.

Podgląd web uruchomisz przez `pnpm dev`; Vite udostępnia go pod `http://127.0.0.1:1420/`.

## v0.3.1 — fullscreen, version and controller diagnostics

The desktop app starts in native Tauri fullscreen without decorations. Esc restores a decorated window; F11 toggles fullscreen. Alt+F4 remains the Windows exit shortcut. If the web UI cannot respond, close the app and start `nexus-aurea.exe --windowed` (or add `--windowed` to a shortcut target). This recovery option does not change persistent settings.

The Tauri version comes from `package.json`; the desktop footer reads `getVersion()` from the running app. Browser previews use package metadata. CI checks that the Rust crate version matches.

Open controller diagnostics with F2, Options (standard-mapped controller), or the diagnostics button. The modal shows API availability, connected devices, IDs, mapping, raw button values and axes. Press a controller button with NEXUS focused to let the browser expose the device. Windows device detection alone does not confirm Gamepad API support. Diagnostics do not activate launcher items. Launcher polling only acts while NEXUS is focused and visible and only interprets standard-mapped devices. Nonstandard devices remain visible as raw values. No global input hook, driver, controller emulator or physical controller is required for CI.

### Return from external services: limitation

Services still open through the system opener in the user's default browser. The opener does not expose the lifecycle of a browser tab or an existing browser process. NEXUS therefore cannot reliably detect tab closure or guarantee automatic foreground focus. No process watcher, forced foreground loop or browser termination is used. When Windows or the user returns focus to NEXUS (for example with Alt+Tab), NEXUS restores the selected dock button. True automatic return requires a separately designed managed browser/window integration and is not implemented here.

### Validation and MSI smoke test

CI runs frontend tests, TypeScript/production build and locked Rust checks on Windows/macOS, and uploads the Windows x64 NSIS installer on successful Windows builds (30-day retention). Tests use synthetic controller samples and a DOM environment, including analog values, unsupported API, disabled polling, relative navigation and native window recovery calls. These do not prove hardware or Windows foreground behavior.

After installing on MSI: confirm the footer version; verify no title bar at startup; use Esc then F11; test `--windowed`; open diagnostics without a controller; later test PlayStation buttons/axes and reconnect; launch YouTube and return via Alt+Tab, checking the dock selection. Native fullscreen and physical controller acceptance remain manual hardware checks.

## v0.4.0 — controller engine and optional Windows launchers

The controller engine accepts standard Gamepad API mappings and an explicit PlayStation raw profile. Automatic mode uses the browser's standard mapping, or a PlayStation raw layout when the device ID identifies a DualShock, DualSense, or Wireless Controller. Diagnostics show raw buttons, axes, the selected profile, and whether NEXUS currently has focus. The profile can be cycled and is saved locally.

Left/right D-pad and left stick move through every dock tile and wrap at each end. Axis activation uses 0.55 and release uses 0.35; directional input is debounced for 40 ms, repeats 420 ms after the first move, then every 135 ms. ✕ confirms, ◯ returns to the first tile or closes the Options panel, and Options toggles diagnostics. Polling only triggers actions while the NEXUS window is focused and visible. Unsupported mappings remain visible in diagnostics and keyboard control remains available.

The Options/diagnostics panel can launch Steam Big Picture or Playnite Fullscreen when their executables are found in common Windows installation folders. Launching is an explicit user action; missing applications are reported and never installed. Steam receives its fixed Big Picture URI, and Playnite receives the documented **--startfullscreen** argument ([Playnite command-line documentation](https://api.playnite.link/docs/manual/advanced/cmdlineArguments.html)). [Steam Big Picture](https://help.steampowered.com/en/faqs/view/3725-76D3-3F31-FB63) remains a separate external application. NEXUS does not monitor or terminate either process, force foreground focus, or claim to detect when an external browser tab closes. When Windows returns focus to NEXUS, the selected tile is restored.

Grand Cinema artwork, layout, streaming destinations, and their HTTPS allowlist are unchanged. NEXUS continues to open official service pages and does not alter DRM or streaming protections. CI runs the controller and launcher tests, performs frontend and Rust checks, builds the Windows x64 NSIS installer, and uploads it as a 30-day Actions artifact. No release is created by this change.

### Manual Windows acceptance checks

Hardware tests remain required for each PlayStation controller over USB and Bluetooth: compare the standard and raw profiles; verify D-pad and analog left/right; confirm ✕, ◯, and Options; hold a direction to check repeat; traverse all five tiles in both directions; open and close the Options panel with the controller; and test Windows focus return after launching each installed platform. These checks are not represented by synthetic CI tests.

## v0.5.0 — NEXUS Control Service (safe prototype)

The first native Control Service prototype runs in the signed-in user's desktop session. It uses only Windows user-mode APIs and requires no driver, administrator access, shell replacement, password access, or global keyboard hook. It is **off by default** and starts only after the user presses **Włącz monitoring sesji** in controller diagnostics.

While enabled, it enumerates HID device metadata to report Generic Desktop gamepads/joysticks and Sony VID `054C`; it does not read button reports. It reports only the foreground executable name, not the window title or full path. `Ctrl+Alt+N` requests a return to NEXUS. `Ctrl+Alt+F12` unregisters the hotkeys and stops the worker. Game mode unregisters the return shortcut and leaves only the emergency stop active. If hotkey registration or HID enumeration fails, activation is rejected or the worker shuts down. A shortcut already owned by another app is reported and not taken over.

The existing Steam Big Picture and Playnite Fullscreen buttons remain explicit, fixed allow-list launch actions. NEXUS restores its selected tile when Windows returns focus; this prototype does not watch or close external apps and does not force foreground focus after a process or browser tab exits.

Global gamepad button mapping, cursor movement, Windows actions, volume, automatic game detection, and process-close focus restoration are intentionally not active in this prototype. Focused NEXUS continues to use the existing Gamepad API locally. The next step is a separately tested Windows input backend that can identify DualShock/DualSense reports and suspend itself for games or Steam Input before enabling any global actions.

Synthetic tests cover the disabled default, Sony HID classification, hotkey bridge state, game-mode shortcut behavior, emergency-stop UI updates, focus restoration after closing diagnostics, controller reconnects, and keyboard traversal across the five dock tiles. They do not prove HID enumeration, global hotkey delivery, HDMI/fullscreen behavior, Steam Input coexistence, or controller mapping on the MSI. These remain manual MSI acceptance checks before any global button mapping is added.

For the first MSI acceptance pass, open diagnostics and start the service manually; confirm USB and Bluetooth pad enumeration, switch to another app and test `Ctrl+Alt+N`, enable game mode and confirm that shortcut is released, then test `Ctrl+Alt+F12` and verify the status returns to disabled. Repeat once with Steam Input active to confirm the prototype observes device metadata without consuming controller reports. No v0.5 installer is to be installed automatically.

## v0.6.0 — App Manager and Cinema Mode

The diagnostics panel includes Cinema, Gaming, and Desktop profiles and a fixed Windows application allowlist for Steam Big Picture, Apple Music, Playnite Fullscreen, Chrome, Edge, and Firefox. Discovery checks known per-user and Program Files locations; Apple Music uses its WindowsApps execution alias. Launch requests use fixed executable paths and fixed arguments. The process diagnostic uses `tasklist` with an exact image-name filter, has a two-second timeout, and does not read window titles or process command lines. Existing applications are reported rather than launched a second time when their process is already visible to that check. NEXUS never terminates an application.

Only a Playnite Fullscreen process started directly by NEXUS is monitored for exit. Focus is requested only if Windows has returned to Explorer or NEXUS; Steam, Apple Music, and browsers may delegate to existing processes, so their lifecycle is reported as unsupported. Windows can still deny foreground activation. Profiles are saved in local WebView storage. Cinema requests NEXUS fullscreen and Desktop requests a decorated window; Gaming only activates the existing Control Service game mode if that service was already explicitly enabled. No service is enabled on startup, and Gaming does not add global controller mapping. No HDR, resolution, HDMI, or audio-device setting is changed.

### v0.6 validation status

- PASS locally: React/TypeScript unit tests, production TypeScript/Vite build, and whitespace checks.
- CI REQUIRED: Rust unit tests, Windows/MSVC backend check, macOS backend check, and Windows NSIS build.
- NOT TESTED: Steam/Apple Music/Playnite/browser discovery and launch on the MSI; app window lifecycle and Windows foreground permissions; profile switching with the PlayStation controller on the Panasonic display.

Known v0.5 limitations remain: Control Service detects HID metadata and provides return/emergency keyboard shortcuts, but global controller mapping and system volume control are not implemented. The v0.6 manager does not expose an unrestricted custom executable path, and Playnite focus restoration requires hardware acceptance before it can be considered reliable on the MSI.

## v0.7.0 — NEXUS Music and Windows audio controls

NEXUS Music requests Windows Global System Media Transport Controls (SMTC) sessions and accepts metadata only from a session whose app user model ID matches Apple Music. When available, it reports title, artist, album, playback state, and timeline position, then routes play/pause/next/previous to that Apple Music session. If Windows does not expose the Apple session or denies SMTC access, track fields remain empty and transport controls remain disabled; the explicit fallback opens the installed official Apple Music app. NEXUS never sends media commands to another app's session.

Music Mode presents the available track data in a full-screen AUREA-styled overlay. Background Mode is opt-in and remembered locally; it displays an optional mini-player while the Grand Cinema home screen stays in place. Controller transport is available from the diagnostics panel; the home-screen mini-player also has mouse/keyboard buttons. In Gaming profile NEXUS disables track transport controls while leaving already-playing audio alone. The album art thumbnail is intentionally not read in this prototype, so the UI states that it is unavailable rather than showing sample art.

System audio buttons send standard Windows volume-up, volume-down, and mute keyboard events. They affect the current Windows default output and do not read a numeric volume value, choose an endpoint, pair Bluetooth devices, or change audio settings. If the user selects JBL PartyBox Encore as the Windows default device, these buttons follow that routing. The current device name and Bluetooth latency are not reported by this prototype.

### Apple and Windows integration limits

Microsoft documents SMTC as exposing only sessions that integrate with those APIs, and marks `globalMediaControl` as a capability needed by some session APIs. The current NEXUS build is an unpackaged NSIS desktop installer, so SMTC access can vary by Windows build and package identity; runtime access failures are surfaced and use the official-app fallback. Album-art byte extraction and system-device enumeration are not implemented. See [Microsoft SMTC sessions](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssession), [the SMTC session manager](https://learn.microsoft.com/en-us/uwp/api/windows.media.control.globalsystemmediatransportcontrolssessionmanager), and [Windows app capability declarations](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/app-capability-declarations).

MusicKit / Apple Music API is a future option for catalog and personal-library features, not part of v0.7. Apple requires a signed ES256 developer token; personalized library requests also require a Music User Token. MusicKit on the Web manages subscriber authorization for web apps, but NEXUS has no configured Apple Developer signing key or user authorization flow and does not claim WebView2 playback support. No Apple ID password, private key, token, DRM content, or subscription data is collected by NEXUS. See [Apple Music API](https://developer.apple.com/documentation/AppleMusicAPI), [developer-token requirements](https://developer.apple.com/documentation/AppleMusicAPI/generating-developer-tokens), and [MusicKit user authentication](https://developer.apple.com/documentation/applemusicapi/user-authentication-for-musickit).

`src/services/musicBridge.ts` is the narrow frontend boundary for SMTC status, track transport, and system-volume actions. Future MusicKit, iPhone PWA, iCloud Calendar, and System Manager modules can each add explicit services and native commands behind focused UI entry points. No generic plugin registry or automatic background integration is introduced.

### v0.7 validation status

- PASS locally: React/TypeScript tests, production frontend build, and whitespace checks.
- CI REQUIRED: Windows and macOS Rust checks, including the native Windows SMTC code, and the Windows NSIS installer artifact.
- NOT TESTED: Apple Music SMTC metadata/commands, full-screen media presentation, JBL volume routing, Bluetooth latency, PlayStation navigation through Music Mode, Panasonic display rendering, and any Apple Music/MusicKit authentication or playback.
- NOT IMPLEMENTED: album artwork, lyrics, current endpoint name, endpoint selection, Bluetooth pairing/latency, and an Apple Music-specific MediaKit streaming client.
