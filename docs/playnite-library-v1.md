# Biblioteka gier Playnite — VELORA 1.0 (obszar C)

Status: **adapter + jawny fallback**. Panel jest gotowy do montażu, ale w tym buildzie
VELORA nie ma bezpiecznego, udokumentowanego API metadanych Playnite, dlatego
interfejs domyślnie pokazuje stan `unavailable` i **nie wyświetla żadnych wymyślonych gier**.

## 1. Granica adaptera (frontend)

Cała komunikacja z danymi gier przechodzi przez jeden interfejs w
`src/services/playniteLibrary.ts`:

```ts
interface PlayniteLibraryAdapter {
  read(): Promise<PlayniteLibrarySnapshot>;
}
```

- `readPlayniteLibrary(adapter = createTauriPlayniteAdapter())` — jedyny punkt wejścia UI.
  Każdy błąd adaptera (odrzucenie, uszkodzona odpowiedź, brak komendy) kończy się
  snapshotem `unavailable` z polskim komunikatem. **Nigdy** nie generujemy przykładowych danych.
- `createTauriPlayniteAdapter()` — wyłącznie do odczytu: `invoke("get_playnite_library")`.
  W podglądzie webowym (`isTauri() === false`) nie woła `invoke` w ogóle i deleguje do fallbacku.
  Odpowiedź jest walidowana: tylko źródło `playnite-api` może nieść listę gier,
  a `readOnly: true` jest wymuszane niezależnie od tego, co zwróci warstwa natywna.
- `createFallbackPlayniteAdapter()` — zawsze zwraca `unavailable` z komunikatem:
  _„Brak bezpiecznego, udokumentowanego API Playnite. VELORA nie odczytuje plików bazy danych Playnite ani nie zgaduje jej struktury.”_

`PlayniteLibrarySnapshot.source` przyjmuje trzy wartości:

| `source` | Znaczenie | `available` | Metadane gier |
| --- | --- | --- | --- |
| `playnite-api` | udokumentowane, bezpieczne API (przyszłość) | `true` | dozwolone |
| `playnite-detected` | wykryto sam plik wykonywalny Playnite na Windows | `false` | **brak** |
| `unavailable` | brak bezpiecznego źródła / błąd odczytu | `false` | **brak** |

`readOnly: true` jest częścią typu: VELORA nie modyfikuje metadanych Playnite.

## 2. Warstwa natywna (Rust)

`src-tauri/src/playnite_library.rs` udostępnia komendę
`#[tauri::command] pub fn get_playnite_library() -> PlayniteLibrarySnapshot`.

- `playnite_api_is_configured()` to w VELORA 1.0 stałe `false` — nie ma bezpiecznego API.
- `unavailable_snapshot()` / `detected_snapshot()` to czyste konstruktory stanu.
- Opcjonalnie, **tylko na Windows** i **tylko do odczytu**, `Path::is_file()` sprawdza
  znane lokalizacje pliku wykonywalnego Playnite (wzorzec z `app_manager.rs::playnite_path`).
  Wynik może ustawić `source: "playnite-detected"`, ale **nadal bez listy gier**.
- Na macOS/Linux odpowiadający helper ma wariant `#[cfg(not(target_os = "windows"))]`
  zwracający `false`, więc `cargo check` kompiluje się bez zależności Windows.
- Moduł używa wyłącznie `std`, `serde` (derive `Serialize` z `rename_all = "camelCase"`)
  i `tauri`. Nie dodaje żadnych crate'ów.

### Czego moduł NIE robi (twarde ograniczenia)

- **Nie otwiera, nie parsuje i nie zgaduje bazy danych Playnite** (SQLite, pliki biblioteki,
  `database.json`, jakikolwiek nieudokumentowany układ plików). Test
  `source_never_references_udocumented_library_files` czyta własny plik źródłowy
  i potwierdza brak odwołań do takich ścieżek / crate'ów.
- **Nie zapisuje** niczego do danych Playnite, nie zmienia ustawień systemu Windows,
  nie instaluje niczego na MSI.
- **Nie implementuje logowania** do GOG, Epic, EA App ani Ubisoft Connect. Logowanie,
  integracje i launchery pozostają w Playnite i jego oficjalnych dodatkach. VELORA nie
  uruchamia gier z tego panelu i nie odczytuje stanu kont ani własności gier.

## 3. Okładki

`sanitizeCoverSource()` przepuszcza wyłącznie:

- `data:image/(png|jpeg|webp|gif);base64,...`
- `asset:` (protokół assetów Tauri)
- `http://asset.localhost/` (protokół assetów Tauri)

Odrzuca `javascript:`, `file:`, dowolne zdalne hosty `http(s)://`, cudzysłowy,
białe znaki i znaki sterujące. Gdy okładka jest niedostępna lub odrzucona, panel rysuje
**placeholder AUREA** (gradient + inicjały tytułu) zamiast ładować zewnętrzny zasób.
VELORA nigdy nie konstruuje ścieżki do plików bazy Playnite.

## 4. Ulubione i „Ostatnio grane" — stan LOKALNY VELORA

`readFavorites`, `toggleFavorite`, `readRecentlyPlayed`, `noteRecentlyPlayed` operują
**wyłącznie na `localStorage` WebView VELORA** (klucze `velora.v1.playnite.favorites`
i `velora.v1.playnite.recentlyPlayed`):

- bezpieczny odczyt JSON (uszkodzone dane → pusta lista),
- `try/catch` dla zablokowanego storage,
- historia ograniczona do 12 pozycji, najnowsze pierwsze, bez duplikatów,
- wstrzykiwalny storage (`Pick<Storage, ...>`) — wzorzec z `cinemaMode.ts`.

To **nie są metadane Playnite i nie jest to zapis do Playnite**. „Ostatnio grane" oznacza
„ostatnio wybrane w interfejsie VELORA"; panel nie zna historii rozgrywek z Playnite.
Listy sekcji pokazują wyłącznie gry potwierdzone przez bieżący snapshot — nie wymyślają
nazw dla identyfikatorów, których nie ma w źródle.

Siatka okładek: przyciski z roving `tabIndex`, `data-aurea-focus` i `aria-current` na
aktywnej karcie oraz 2D nawigacja strzałkami przez czysty helper `moveGridFocus`.
Stan ładowania i błędy są ogłaszane przez `role="status"` / `aria-live="polite"`.

## 5. Co musi zarejestrować integrator

Panel **nie jest nigdzie zamontowany** w tym obszarze. Integrator w `GamingHub.tsx`
wstawia `<PlayniteLibrary />` (import z `../components/PlayniteLibrary`), a w
`src-tauri/src/lib.rs` dopisuje:

```rust
mod playnite_library;                       // obok pozostałych modułów
// ... w invoke_handler(tauri::generate_handler![ ... ]):
playnite_library::get_playnite_library,
```

Nie są potrzebne żadne zmiany w `capabilities/default.json`, `tauri.conf.json`, CSP,
`Cargo.toml` ani nowe zależności — to komenda aplikacji, nie wtyczki, i jest dozwolona
przez istniejący `invoke_handler`.

## 6. Lista kontrolna do sprawdzenia ręcznego na MSI (Windows)

Do wykonania na maszynie MSI z zainstalowanym Playnite, po wdrożeniu integratora:

1. **Uruchom build Windows** (`pnpm tauri:windows`) i otwórz Control Center → Gaming.
2. **Stan domyślny:** panel pokazuje polski komunikat `unavailable` oraz notatkę,
   że dane pojawią się dopiero po udostępnieniu bezpiecznego API. Nie ma żadnych gier,
   okładek ani nazw „przykładowych".
3. **Wykrycie Playnite:** jeśli plik wykonywalny jest w standardowej lokalizacji,
   `source` może być `playnite-detected` — sprawdź, że **lista gier nadal jest pusta**
   i że widoczny jest komunikat o braku API metadanych.
4. **Tylko do odczytu:** w katalogu danych Playnite nie pojawiają się nowe pliki ani
   zmiany po otwarciu panelu, kliknięciu karty, togglu „Ulubione" ani odświeżeniu.
   (VELORA zapisuje wyłącznie do swojego `localStorage`.)
5. **Ulubione:** kliknij „Ulubione" na kilku grach (gdy snapshot testowy zawiera gry) —
   `aria-pressed` przełącza się, sekcja „Ulubione" aktualizuje się, a po restarcie
   aplikacji wybory są zachowane (pamięć WebView).
6. **Ostatnio grane:** wybierz karty — sekcja „Ostatnio grane" pokazuje maks. 12
   pozycji, najnowszą na górze, bez duplikatów.
7. **Nawigacja:** klawisze strzałek przesuwają fokus w 2D po siatce okładek;
   aktywna karta ma widoczny `data-aurea-focus` / `aria-current`; klawisz Tab
   wchodzi tylko na jedną kartę (roving tabIndex).
8. **Okładki:** bezpieczne `asset:`/`data:image` renderują się; brak okładki daje
   gradient + inicjały; źródło `javascript:`/`file:`/zdalne jest odrzucane (placeholder).
9. **Bez logowania:** panel nie prosi o hasła GOG / Epic / EA / Ubisoft i nie otwiera
   żadnego okna logowania. Wszystkie integracje pozostają w Playnite.
10. **Czytnik ekranu / a11y:** sekcja ma etykietę „Biblioteka Playnite", status ładowania
    i błędy są ogłaszane (`aria-live="polite"`), przyciski mają polskie etykiety,
    a informacja „Dane gier są tylko do odczytu…" jest widoczna.
11. **Podgląd webowy (macOS/Linux, bez Tauri):** panel pokazuje ten sam jawny fallback
    i **nie wywołuje** `invoke` (brak błędów w konsoli o niedostępnej komendzie).
12. **Brak ingerencji w system:** nie są tworzone wpisy rejestru, skróty, usługi ani
    pliki instalacyjne; VELORA nie instaluje Playnite ani dodatków.
