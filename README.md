# NEXUS AUREA v0.5.0

Projekt React + TypeScript + Tauri oparty bezpośrednio na zatwierdzonym prototypie AUREA · Grand Cinema. Oryginalny plik jest zachowany w `design/aurea-prototype.html`, a arkusz `src/styles.css` został z niego przeniesiony bez zmiany bazowego układu, kolorów ani animacji.

## Instalacja na Windows 11

NEXUS AUREA jest budowany jako instalator NSIS `.exe` dla Windows x64. Instalator domyślnie instaluje aplikację dla bieżącego użytkownika, bez konieczności instalacji systemowej.

### Artefakt z GitHub Actions

1. Otwórz [przebiegi CI](https://github.com/Milklosz/nexus-aurea/actions/workflows/ci.yml) i wybierz ukończony przebieg z gałęzi `main`.
2. W sekcji **Artifacts** pobierz `NEXUS-AUREA-Windows-x64-<SHA>` i rozpakuj pobrane archiwum ZIP.
3. Uruchom instalator `NEXUS AUREA_<wersja>_x64-setup.exe` z pobranego artefaktu.

Artefakt jest tworzony po udanym buildzie Windows przy każdym ukończonym pushu na `main`. GitHub przechowuje go przez 30 dni. Pobranie artefaktu wymaga zalogowania do GitHuba i dostępu do repozytorium.

### GitHub Release

Tag w formacie `v*` uruchamia pełne CI. Po pomyślnym zakończeniu testów, buildów macOS i Windows oraz przesłaniu instalatora workflow publikuje GitHub Release z plikiem `.exe`. Wydanie pobierzesz z [zakładki Releases](https://github.com/Milklosz/nexus-aurea/releases).

### SmartScreen

Instalator nie jest podpisany certyfikatem wydawcy, więc Microsoft Defender SmartScreen może ostrzec, że wydawca jest nieznany. Instaluj tylko plik pobrany z repozytorium NEXUS AUREA. Jeśli standardowy ekran ostrzeżenia pokazuje opcję kontynuacji, użyj jej tylko po sprawdzeniu źródła. Na urządzeniach z aktywnym Smart App Control Windows 11 może zablokować niepodpisany plik bez możliwości uruchomienia go mimo ostrzeżenia; nie wyłączaj zabezpieczeń, aby to obejść. [Microsoft opisuje wpływ podpisu na SmartScreen i Smart App Control](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Windows 11 zwykle ma WebView2 wymagany przez aplikację. Przy pierwszym uruchomieniu aplikacji system może potrzebować połączenia internetowego, aby pobrać brakujący składnik WebView2.

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
