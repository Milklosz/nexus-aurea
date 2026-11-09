# NEXUS AUREA v0.3

Projekt React + TypeScript + Tauri oparty bezpośrednio na zatwierdzonym prototypie AUREA · Grand Cinema. Oryginalny plik jest zachowany w `design/aurea-prototype.html`, a arkusz `src/styles.css` został z niego przeniesiony bez zmiany bazowego układu, kolorów ani animacji.

## Instalacja na Windows 11

NEXUS AUREA jest budowany jako instalator NSIS `.exe` dla Windows x64. Instalator domyślnie instaluje aplikację dla bieżącego użytkownika, bez konieczności instalacji systemowej.

### Artefakt z GitHub Actions

1. Otwórz [przebiegi CI](https://github.com/Milklosz/nexus-aurea/actions/workflows/ci.yml) i wybierz ukończony przebieg z gałęzi `main`.
2. W sekcji **Artifacts** pobierz `NEXUS-AUREA-Windows-x64-<SHA>` i rozpakuj pobrane archiwum ZIP.
3. Uruchom plik instalatora `NEXUS AUREA_0.3.0_x64-setup.exe`.

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
