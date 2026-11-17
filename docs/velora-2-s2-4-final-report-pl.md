# VELORA 2.0 — raport końcowy S2.4

Data: 17 listopada 2026 (Europe/Warsaw)\
Gałąź: `feature/velora-2-s2-4-true-tv-experience`\
Baza: `740f5964df4e2dc843f436b0e5e7a61af9cafc13` (S2.3 / Draft PR #62)\
Wersja kandydata: `0.12.0-rc.1`

## Zakres i decyzja

S2.4 kontynuuje istniejącą pracę na gałęzi z bazą S2.3. Zmiany źródłowe,
automatyczne walidacje i lokalny kandydat inżynierski są gotowe do przeglądu w
Draft PR. To nie jest akceptacja stabilnego wydania: rzeczywisty przebieg TV,
pełna obsługa serwisów, test fizycznego DS4 i pełna geometria kursora pozostają
otwarte.

## Naprawione i uzupełnione problemy

- Diagnostyka UI Automation zachowuje czas zapytania, liczbę kandydatów i
  powody odrzucenia również przy nieudanym zapytaniu. Wyniki są ograniczone,
  redagowane i eksportowane bez tekstu strony ani identyfikatorów sesji.
- Błąd przestrzenny nie jest automatycznie powtarzany jako kliknięcie.
  Bezpieczny fallback jest zmianą polityki na tryb wskaźnika z nową generacją;
  odrzucona aktywacja pozostaje odrzucona.
- Przekazanie fokusu między VELORA i dokładną zarządzaną sesją Edge jest
  sprawdzane przez natywny router. Home zachowuje istniejący mechanizm
  natywny; lokalne, ograniczone wyniki i pozostałe kroki mogą przetrwać
  odmontowanie diagnostyki. Po Home wymagane są gotowość natywna i jawne
  wznowienie.
- Geometria ekranów, fizyczne położenie, DPI okna, skala API, ułamkowe Hz,
  transport i adapter są raportowane osobno. Skala monitora 140% nie jest
  mylona z 144 DPI / 150% istniejącego okna.
- Ruch wskaźnika i scroll są ograniczone i skalowane względem geometrii 4K;
  precyzja drążka R3 ma mały krok wyłącznie w trybie wskaźnika.
- Dodano testy symulatora, sekwencji, trwałości w obrębie procesu, diagnostyki
  wyświetlania, nawigacji przestrzennej i fallbacku. Istniejące funkcje
  Claude Usage oraz iPhone Remote pozostały w kodzie i przechodzą swoje
  testy regresji.

## Testy i CI

| Sprawdzenie | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | PASS |
| `pnpm test` (Vitest) | PASS — 109 plików, 978 testów |
| `pnpm test:claude-usage` | PASS — 6/6 |
| `pnpm test:provenance` | PASS — 31/31 |
| `pnpm build` (TypeScript + Vite) | PASS |
| `cargo test --locked --manifest-path src-tauri/Cargo.toml --lib` | PASS — 450 passed, 0 failed, 3 ignored |
| `cargo check --locked --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-msvc` | PASS |
| `cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets` | PASS; 24 odziedziczone ostrzeżenia lint |
| `git diff --check` | PASS |
| `cargo fmt --check` | FAIL z powodu istniejących różnic formatowania całego repozytorium; nie formatowano niezwiązanych plików |
| GitHub Windows CI / NSIS / provenance | oczekuje na przebieg Draft PR |

Rust testy wymagały dostępu testowego do Windows Credential Manager oraz
krótkiego katalogu tymczasowego; pełny przebieg zakończył się powodzeniem.
Zestaw CI nie zawiera `cargo fmt --check`.

## Computer Use

Kandydat debug uruchomiono w odizolowanej tożsamości Tauri, bez odczytu/zapisu
danych aktualnej instalacji `0.9.2`. Kandydat wyświetlił się fullscreen na
aktywnym ekranie Panasonic-TV. Symulator był jawnie włączony tylko dla tej
sesji; żaden wynik symulacji nie jest dowodem na fizyczny pad.

Zaobserwowano uruchomienie publicznej strony YouTube i późniejsze otwarcie
publicznej strony Netflix. Netflix pokazał stronę startową i baner cookies;
baneru nie zaakceptowano ani nie odrzucono. Nie logowano się, nie wpisywano
wyszukiwania, nie uruchamiano chronionego tytułu i nie zmieniano konta.
Próbowano sterowania nawigacyjnego wobec wybranej Netflix-sesji, ale widocznego
efektu nie potwierdzono.

Użytkownik zatrzymał Computer Use klawiszem Escape przed kolejnymi
interakcjami. Nie potwierdzono kontrolerowej sekwencji
`VELORA → YouTube → Home → Netflix → Home`, widocznej gotowości Home po obu
serwisach ani trafiania kursorem w kontrolki. Rezultaty są wyłącznie
częściowym sprawdzeniem stron publicznych, nie pełną zgodnością.

Szczegółowa macierz: [`velora-2-s2-4-compatibility-matrix.md`](velora-2-s2-4-compatibility-matrix.md).

## Pięć serwisów

| Serwis | Wynik Computer Use | Chroniony katalog / odtwarzanie |
|---|---|---|
| YouTube | PARTIAL — publiczna strona otwarta z symulatora | BLOCKED — brak uwierzytelnionej sesji; bez testu playback |
| Netflix | PARTIAL — publiczna strona otwarta z symulatora | BLOCKED — brak uwierzytelnionej sesji; bez testu playback |
| Disney+ | NOT TESTED | NOT TESTED |
| Max | NOT TESTED | NOT TESTED |
| Prime Video | NOT TESTED | NOT TESTED |

## Panasonic 4K

Odczyt natywny Windows z 17.11.2026 wskazuje jeden aktywny ekran
`Panasonic-TV`, 3840 × 2160, położenie fizyczne (0, 0), HDMI przez NVIDIA RTX
3070 Laptop, 60 000 mHz. Kandydat S2.4 był widoczny fullscreen na tym ekranie.
Dowody: `docs/evidence/s2-4-display-audio-native.json` oraz
`docs/evidence/s2-4-window-dpi-native.json`.

`GetScaleFactorForMonitor` podał 140%; istniejące okno aplikacji raportowało
144 DPI (150%) w kontekście Per-Monitor V2. Tych wartości nie należy utożsamiać.
Nie zmieniono ustawień globalnych Windows. Rzeczywiste wyrównanie kursora,
trafianie w kontrolki oraz pełna akceptacja geometrii fullscreen nie zostały
wykonane w tej krótkiej sesji.

## Backlog i otwarte problemy

- Dodano B5 do [`velora-2.0-audit.md`](velora-2.0-audit.md): uproszczenie
  parowania iPhone przez Control Center i krótkożyciowy QR, z zachowaniem TLS,
  HTTPS, silnego uwierzytelniania, walidacji originu, limitów i możliwości
  unieważniania. QR nie może zawierać trwałego sekretu.
- Dokończyć pełny Computer Use po nowym, jawnie rozpoczętym przebiegu:
  Home, capture/wznowienie po Home, navigacja YouTube/Netflix, następnie
  publiczne wejścia Disney+, Max i Prime Video.
- Dokończyć UIA/pointer acceptance z rzeczywistym odczytem skutku i geometrii.
- Przeprowadzić playback wyłącznie na legalnie dostępnej sesji; fizyczny DS4
  pozostaje nieprzetestowany.
- Weryfikacja iPhone Remote na telefonie rzeczywistym nie była częścią tej
  sesji; automatyczne testy regresji przeszły.
- Pełna automatyczna wieloserwisowa sekwencja pozostaje ograniczona granicą
  Home i wymaga segmentowego wznowienia.

## Commit, Draft PR i instalator

- Commit S2.4: uzupełnię po zapisaniu zmian.
- Draft PR: uzupełnię po utworzeniu PR i odczycie CI.
- Instalator inżynierski NSIS x64: uzupełnię po czystym buildzie z commitu.
- SHA-256 i manifest instalatora: uzupełnię po weryfikacji artefaktu.
- Instalatora nie uruchamiano; stabilne wydanie nie było instalowane.

## Rekomendacja

Zachować Draft PR i nie promować S2.4 do stabilnego wydania. Następny krok to
dokończyć przerwane Computer Use na czystym kandydacie oraz zebrać lokalne,
obserwowalne wyniki Home/UIA/pointer i trzy brakujące strony usług.
