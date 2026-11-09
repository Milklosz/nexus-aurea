# NEXUS AUREA v0.2

Projekt React + TypeScript + Tauri oparty bezpośrednio na zatwierdzonym prototypie AUREA · Grand Cinema. Oryginalny plik jest zachowany w `design/aurea-prototype.html`, a arkusz `src/styles.css` został z niego przeniesiony bez zmiany bazowego układu, kolorów ani animacji.

## Uruchomienie na Macu

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

Workflow `CI` uruchamia się po każdym pushu i pull requeście, a także ręcznie. Na macOS i Windows/MSVC instaluje zależności z zamrożonego `pnpm-lock.yaml`, uruchamia testy, buduje frontend React/TypeScript, sprawdza backend Rust i kompiluje aplikację Tauri. Kompilacja CI nie podpisuje aplikacji ani nie pakuje instalatorów.

Sam podgląd web uruchomisz przez `pnpm dev`; Vite udostępnia go pod `http://127.0.0.1:1420/`.

`tauri:windows` jest przygotowany dla kompilacji na Windows 11 z targetem MSVC. Tauri wymaga tam narzędzi Microsoft C++ Build Tools; WebView2 jest standardowo dostępny w Windows 11. Konfiguracja Windows nie była tu uruchamiana.

## Co działa w v0.2

- Zegar w formacie 24-godzinnym dla strefy `Europe/Warsaw`.
- Bieżąca pogoda Zabrza z Open-Meteo, odświeżana co 15 minut. Błąd sieci pokazuje czytelny status, zachowuje ostatni poprawny odczyt i nie blokuje interfejsu.
- Nawigacja strzałkami, klawisz `X`, Enter przez natywną aktywację przycisku oraz Gamepad API (kierunki, przycisk 0 i menu 9).
- Pięć oficjalnych stron usług otwieranych w domyślnej przeglądarce. Aplikacja sprawdza HTTPS i dokładną nazwę hosta, a Tauri ogranicza uprawnienie openera do tych domen.
- Wspólny punkt wejścia nawigacji dla klawiatury i pada, do którego można później podłączyć sterowanie LAN.

## Zakres poza v0.2

Nie ma tu odtwarzacza ani osadzania usług, lokalnego AI, zmian firmware telewizora ani obejść DRM. Pilot iPhone/LAN oraz test fizycznego pada pozostają kolejnymi etapami. Na tym Macu nie wykonano kompilacji Tauri ani Windows.
