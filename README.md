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

Instalator nie jest podpisany certyfikatem wydawcy. Windows może więc pokazać ostrzeżenie Microsoft Defender SmartScreen. Instaluj tylko plik pobrany z repozytorium NEXUS AUREA; jeśli świadomie kontynuujesz, wybierz **Więcej informacji** → **Uruchom mimo to**.

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
