# VELORA — Sprint A: audyt architektury (stan kodu z `25097a3`)

Status dokumentu: **audyt, bez zmian w kodzie produkcyjnym**.
Baza: gałąź `feat/velora-single-instance` (= head PR #24, commit `25097a3`), na której stoi
też PR #23 (`889eed1`). Ten PR jest stacked na PR #24 i nie modyfikuje PR #23 ani #24.

Każdy wpis odnosi się do konkretnego pliku i linii. Gdzie wniosek jest tylko hipotezą,
jest to jawnie oznaczone jako **HIPOTEZA** i wymaga pomiaru na MSI.

Legenda statusów: **DONE** (zweryfikowane czytaniem kodu / testem), **PARTIAL** (częściowo),
**BLOCKED** (wymaga sprzętu lub zgody), **NOT RUN** (nie wykonane w tym przebiegu).

---

## 1. Środowisko i ograniczenia tego przebiegu

- Na maszynie, na której prowadzono audyt, **nie ma Node.js, pnpm ani Rust/cargo** → `pnpm test`,
  `tsc`, `cargo test`, `cargo check` **NOT RUN** lokalnie. Instalacja toolchainu to instalacja
  oprogramowania na MSI, więc wymaga zgody (zasada 7). Weryfikacja: GitHub Actions (`ci.yml`,
  `windows-latest` + `macos-latest`) — wynik CI podany w opisie PR.
- Brak dostępu do sprzętu (MSI, DualSense, Panasonic 4K, HDMI, autostart): wszystkie pomiary
  czasu, CPU i fokusu są **BLOCKED** do testu fizycznego.

---

## 2. Mapa aplikacji (potwierdzona w kodzie)

| Obszar | Plik(i) |
|---|---|
| Punkt wejścia Rust | `src-tauri/src/main.rs`, `src-tauri/src/lib.rs:28` (`run`) |
| Punkt wejścia React | `src/main.tsx`, `src/App.tsx` |
| Pojedyncza instancja | `src-tauri/src/single_instance.rs` (mutex `Local\…`) |
| Monitor snu/wybudzenia | `src-tauri/src/session_monitor.rs` (tick 1 s, `RESUME_GAP` 6 s, orphan check co 5 s) |
| Sesja (stan + zapis) | `src-tauri/src/session_orchestrator.rs`, `src-tauri/src/session_store.rs` |
| Rejestr uruchomień + watcher | `src-tauri/src/launch_registry.rs` (`ACTIVE_POLL_MS`=600, `IDLE_POLL_MS`=1000) |
| Fokus okien | `src-tauri/src/window_broker.rs` (`FOREGROUND_POLL_MS`=750) |
| Start aplikacji | `src-tauri/src/app_manager.rs`, `src-tauri/src/platform_launchers.rs` |
| Edge Cinema | `src-tauri/src/edge_cinema.rs` |
| Playnite / manifest | `src-tauri/src/playnite_library.rs`, `src-tauri/src/playnite_manifest.rs` |
| Apple Music / SMTC | `src-tauri/src/music_service.rs`, `src/App.tsx:261-269` |
| Monitor audio/ekranu | `src-tauri/src/display_audio.rs` (co 10 s) |
| Kontroler | `src/hooks/useGamepad.ts`, `src/services/controllerEngine.ts`, `src-tauri/src/gamepad_home.rs` |
| Uprawnienia Tauri | `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json` (CSP) |
| CI | `.github/workflows/ci.yml` (macOS + Windows, Node 22, pnpm 11.25.0, Rust stable) |

Skala: ok. 18,5 tys. linii Rust (bez testów w części modułów), 48 komend `#[tauri::command]`,
ok. 40 plików testów frontendowych (Vitest) i testy jednostkowe w modułach Rust.

---

## 3. Macierz problemów

Kolumny: Problem · Przyczyna · Wpływ · Priorytet · Ryzyko poprawki · Proponowane rozwiązanie · Sposób testowania.

### 3.1 Sesja „aktualizuje się kilka sekund po powrocie"

| | |
|---|---|
| **Problem** | Plik sesji i stan UI wyglądają na opóźnione o kilka sekund po powrocie na ekran główny. |
| **Przyczyna (kod)** | Zapis sesji **nie jest opóźniony czasowo**: `orchestrator.persist(...)` wywoływany jest synchronicznie po każdej transformacji (`session_orchestrator.rs:562`, `:592`). Opóźnienie wprowadza **detekcja zdarzenia**: watcher launchów co 600 ms przy aktywnym launchu / 1000 ms w spoczynku (`launch_registry.rs:19-20`), monitor fokusu co 750 ms (`window_broker.rs:9`). Wynikowe opóźnienie to ok. 0,6–1,4 s, nie kilka sekund. |
| **Wpływ** | Niski. Kilkusekundowe opóźnienie zaobserwowane na MSI nie wynika z zapisu pliku. Źródło trzeba zmierzyć (prawdopodobnie kombinacja detekcji + ponownego renderu UI). |
| **Priorytet** | P2 |
| **Ryzyko poprawki** | Średnie: zamiana poll → event (np. `SetWinEventHook` / `EVENT_SYSTEM_FOREGROUND`) zmienia logikę fokusu, która była już wielokrotnie łatana. |
| **Proponowane** | **Nie zmieniać przed pomiarem.** Dodać znaczniki czasu (timestamp) w logu przy: wykryciu launchu, zapisie `session_store::save`, emisji `SESSION_CHANGED_EVENT`, odbiorze w React. Dopiero wtedy decydować. |
| **Test** | BLOCKED (MSI): uruchomić grę/aplikację, wrócić do VELORY, odczytać znaczniki. |

### 3.2 Detekcja snu / wybudzenia

| | |
|---|---|
| **Problem** | Wykrywanie wybudzenia musi być niezawodne, bez WM_POWERBROADCAST. |
| **Przyczyna** | `session_monitor.rs`: monotoniczna luka między tickami ≥ 6 s → `handle_system_resume` w launch_registry, window_broker, session_orchestrator, edge_cinema. |
| **Wpływ** | Projekt poprawny i pokryty testami (`normal_ticks_do_not_report_a_resume`, `a_multi_second_gap_reports_a_resume`). Ryzyko: przy długim obciążeniu CPU próg 6 s może dać fałszywy alarm — świadomie przyjęty kompromis. |
| **Priorytet** | P3 (brak zmiany) |
| **Ryzyko poprawki** | — |
| **Proponowane** | Brak zmian. Ewentualnie dodać test scenariusza „zegar przeskoczył wstecz". |
| **Test** | BLOCKED (MSI): sen 5 min → wybudzenie → sprawdzić launcher i sesję. |

### 3.3 Pojedyncza instancja — aktywacja okna drugiej instancji

| | |
|---|---|
| **Problem** | Drugie uruchomienie wywołuje `SetForegroundWindow` z procesu, który właśnie wystartował. |
| **Przyczyna** | `single_instance.rs` (`activate_existing_window`). Windows ogranicza „kradzież" fokusu: wywołanie może się nie powieść, a okno zmieni tylko kolor paska zadań. Kod nie sprawdza wyniku `SetForegroundWindow`. |
| **Wpływ** | **HIPOTEZA** — przy drugim uruchomieniu okno może nie wyjść na wierzch. Mutex sam w sobie działa (poprawna klasyfikacja `183` = `ERROR_ALREADY_EXISTS`). |
| **Priorytet** | P1 (weryfikacja na MSI, bo to bezpośrednio dotyczy zaakceptowanej funkcji) |
| **Ryzyko poprawki** | Niskie-średnie: możliwe rozwiązania (`AttachThreadInput`, `FlashWindowEx` jako fallback, `AllowSetForegroundWindow`) wymagają testu. |
| **Proponowane** | 1) Sprawdzić wynik `SetForegroundWindow` i zalogować go. 2) Przy niepowodzeniu wywołać `FlashWindowEx`. Nie zmieniać przed testem MSI. |
| **Test** | BLOCKED (MSI): uruchomić VELORĘ, przejść do innej aplikacji, uruchomić VELORĘ ponownie (skrót Start i Startup). |

### 3.4 Pojedyncza instancja — czyszczenie mutexu po awarii

| | |
|---|---|
| **Problem** | Czy po awarii procesu blokada zostaje „na stałe"? |
| **Przyczyna** | Mutex jest zwalniany przez system przy zakończeniu procesu, także po crashu. Uchwyt jest trzymany przez cały czas życia procesu (`single_instance.rs`, komentarz przy `Claim::Primary`). |
| **Wpływ** | Brak problemu wg kodu. |
| **Priorytet** | P3 (DONE w ocenie kodu) |
| **Proponowane** | Brak zmian. |
| **Test** | BLOCKED (MSI): zabić proces w Menedżerze zadań i uruchomić ponownie. |

### 3.5 Monitor sesji — koszt periodycznych sprawdzeń

| | |
|---|---|
| **Problem** | Co 5 s wykonywane są `reconcile_orphaned_launch` i `reconcile_edge_marker`. |
| **Przyczyna** | `session_monitor.rs` (`ORPHAN_CHECK_INTERVAL`). `reconcile_orphaned_launch` (`session_orchestrator.rs:768`) to sprawdzenie w pamięci. `reconcile_edge_marker` (`edge_cinema.rs:692`) czyta plik markera, a gdy Edge działa — wywołuje `window_broker::windows_for_processes` (wyliczenie okien). |
| **Wpływ** | Niski. Koszt jest szacowany jako mały, nie zmierzony. |
| **Priorytet** | P3 |
| **Proponowane** | Brak zmian bez pomiaru CPU. |
| **Test** | BLOCKED: Menedżer zadań, 30 min w stanie spoczynku i w Edge Cinema. |

### 3.6 Odtwarzanie Apple Music / SMTC — polling z UI

| | |
|---|---|
| **Problem** | Stan muzyki jest odpytywany co 2,5 s. |
| **Przyczyna** | `src/App.tsx:261-269` (`setInterval(refresh, 2500)`), aktywne, gdy włączony jest panel diagnostyki, tryb tła muzyki lub ambient. Każde wywołanie tworzy `GlobalSystemMediaTransportControlsSessionManager::RequestAsync()` (`music_service.rs:225`) w `spawn_blocking`. Polling **nie jest wstrzymywany** przy ukrytym oknie. |
| **Wpływ** | **HIPOTEZA**: ciągły koszt WinRT w tle, gdy tryb tła jest aktywny. Ambient jest domyślnie wyłączony (`services/ambient.ts:7`). |
| **Priorytet** | P2 |
| **Ryzyko poprawki** | Niskie: wstrzymanie polla przy `document.hidden` i ustawienie 5–10 s to mała zmiana; event-driven SMTC (`SessionsChanged`) wymaga większej pracy. |
| **Proponowane** | Wstrzymać polling gdy `document.visibilityState === "hidden"` i odświeżać natychmiast po powrocie. Osobny PR. |
| **Test** | Vitest: test, że po ukryciu nie ma wywołań `getAppleMusicStatus`. Pomiar CPU na MSI: BLOCKED. |

### 3.7 Zegar — re-render całej aplikacji co sekundę

| | |
|---|---|
| **Problem** | Zegar aktualizuje stan co sekundę. |
| **Przyczyna** | `src/hooks/useClock.ts:14` (`setInterval(() => setNow(new Date()), 1000)`), użyte w `src/App.tsx:68` w komponencie root. Każda sekunda re-renderuje cały `App`. |
| **Wpływ** | **HIPOTEZA** — niepotrzebne rerendery drzewa, które zawiera duże stany. Nie zmierzone (React Profiler). |
| **Priorytet** | P2 |
| **Ryzyko poprawki** | Niskie: wydzielenie komponentu `Clock` z własnym stanem. Wymaga zachowania wyglądu (typografia zegara). |
| **Proponowane** | Wydzielić komponent zegara, który sam subskrybuje `useClock`. Osobny PR po pomiarze. |
| **Test** | React Profiler w dev (desktop), porównanie liczby renderów `App` na minutę. Wizualnie: BLOCKED (ekran 4K). |

### 3.8 Panikujące wywołania w kodzie produkcyjnym

| | |
|---|---|
| **Problem** | Wystąpienia `unwrap`/`expect` poza testami. |
| **Przyczyna / ocena** | `lib.rs:112` — `.expect("error while building VELORA")`: standard przy starcie, akceptowalny. `control_service.rs:99` — `expect` na stałej presetu, bezpieczny. `playnite_library.rs:171` — `expect("checked above")` na tej samej zmiennej lokalnej sprawdzonej `is_some()` linię wyżej: **nie może paniknąć**, ale wzorzec jest kruchy. |
| **Wpływ** | Brak realnego ryzyka wg kodu. |
| **Priorytet** | P3 |
| **Proponowane** | Opcjonalnie zamienić na `if let Some(pid) = already_running`. Nie ma wartości na tyle dużej, by robić to osobnym PR. |

### 3.9 Uruchamianie procesów zewnętrznych

| | |
|---|---|
| **Problem** | Aplikacje są uruchamiane przez `Command::new`. |
| **Przyczyna / ocena** | Miejsca: `app_manager.rs:282` i `:411`, `platform_launchers.rs:37`, `autostart.rs:533`, `edge_cinema.rs:516`, `playnite_library.rs:255` i `:271`. Argumenty są przekazywane jako `argv` (`.arg`/`.args`), **bez powłoki** → brak wstrzyknięcia poleceń przez powłokę. Identyfikator gry Steam jest wybierany z listy wczytanej z dysku (`app_manager.rs:383`), a identyfikator Playnite jest walidowany jako GUID (`playnite_manifest.rs:161`, `:527`). |
| **Wpływ** | Niski wg kodu. |
| **Priorytet** | P3 (DONE w ocenie kodu) |
| **Proponowane** | Brak zmian. Przy następnym audycie sprawdzić ścieżki z `platform_launchers.rs` (ścieżka `path` pochodzi z ustawień). |
| **Test** | NOT RUN: ręczny przegląd wszystkich 7 miejsc; test jednostkowy walidacji ścieżki. |

### 3.10 Uprawnienia Tauri i CSP

| | |
|---|---|
| **Problem** | Czy uprawnienia są zminimalizowane? |
| **Przyczyna / ocena** | `capabilities/default.json` przyznaje tylko `core:default`, zdarzenia, fullscreen, decorations, focus, minimize/unminimize oraz `opener:allow-open-url` z sześcioma wpisami (streaming + playnite.link). CSP (`tauri.conf.json:28`): `default-src 'self'`, `script-src 'self'`, `connect-src` ograniczone do IPC i `api.open-meteo.com`. |
| **Wpływ** | Dobra konfiguracja. |
| **Priorytet** | P3 (DONE w ocenie kodu) |
| **Proponowane** | Brak zmian. Zmiana wymaga przeglądu, czy `core:window:allow-set-focus` jest konieczne (zostawić, bo używane w fokusie). |

### 3.11 Powierzchnia IPC — 48 komend `#[tauri::command]`

| | |
|---|---|
| **Problem** | Każda komenda jest osiągalna z WebView. |
| **Przyczyna / ocena** | Webview ładuje tylko lokalny kod (CSP `script-src 'self'`), więc ryzyko zewnętrznego wstrzyknięcia jest ograniczone. Walidacja argumentów nie została przeczytana komenda po komendzie w tym przebiegu. |
| **Priorytet** | P2 (audyt do wykonania) |
| **Proponowane** | Osobny przegląd: każda komenda przyjmująca `String` (ID, ścieżka, URL) musi walidować wejście. |
| **Test** | NOT RUN. |

### 3.12 Kontroler — timer diagnostyki

| | |
|---|---|
| **Problem** | Diagnostyka kontrolera odpytuje co 100 ms. |
| **Przyczyna** | `src/components/GamepadDiagnostics.tsx:72`. |
| **Wpływ** | Niski, o ile komponent jest montowany tylko w panelu diagnostyki. Nie sprawdzono tego w tym przebiegu. |
| **Priorytet** | P3 |
| **Proponowane** | Potwierdzić montowanie warunkowe; w przeciwnym razie zatrzymać timer poza panelem. |
| **Test** | NOT RUN. |

### 3.13 Monitor audio/ekranu

| | |
|---|---|
| **Problem** | Co 10 s sprawdzane jest urządzenie wyjściowe/ekran. |
| **Przyczyna** | `display_audio.rs:15`. |
| **Wpływ** | Niski. Interwał jest rozsądny. |
| **Priorytet** | P3 (brak zmiany) |

### 3.14 Pogoda

| | |
|---|---|
| **Problem** | Odświeżanie pogody i timeout. |
| **Przyczyna / ocena** | `src/hooks/useWeather.ts:29` (abort po 10 s), `:48` (odświeżanie co 15 min). Odpowiednie dla aplikacji TV. |
| **Priorytet** | P3 (DONE w ocenie kodu) |

### 3.15 Wiele uruchomień i zakończenie procesu

| | |
|---|---|
| **Problem** | Czy po `RunEvent::Exit` zatrzymywane są wszystkie wątki? |
| **Przyczyna / ocena** | `lib.rs:117-123` wywołuje `mark_clean_shutdown`, `stop_watcher`, `stop_foreground_monitor`, `stop_monitor`, `session_monitor::stop`. Zatrzymanie jest flagowe; wątki kończą się przy następnym obrocie pętli. `MONITOR_STARTED` w `session_monitor.rs` nie jest resetowany — nie ma to znaczenia, bo proces kończy się wraz z aplikacją. |
| **Priorytet** | P3 (DONE w ocenie kodu) |

---

## 4. Co zostało zrobione w tym PR

- Dodany ten dokument (`docs/audit/SPRINT-A-AUDIT.md`).
- **Brak zmian w kodzie produkcyjnym i w testach.** Powód: wszystkie realne problemy (3.1, 3.3, 3.6, 3.7) to hipotezy wymagające pomiaru lub testu na MSI. Zmiana bez pomiaru naruszałaby zasadę „nie optymalizuj kosztem stabilności".

## 5. Rekomendowana kolejność dalszych PR (po weryfikacji na MSI)

1. Pomiar: znaczniki czasu dla sesji i fokusu (3.1), test aktywacji drugiej instancji (3.3).
2. Mały PR: wstrzymanie pollingu SMTC przy ukrytym oknie (3.6) + test Vitest.
3. Mały PR: wydzielenie zegara z `App` (3.7) — po pomiarze w React Profiler.
4. Przegląd komend IPC (3.11) — osobny PR, bez zmian zachowania.

## 6. Plan wycofania

Ten PR dodaje tylko plik dokumentacji. Wycofanie: zamknąć PR lub usunąć `docs/audit/SPRINT-A-AUDIT.md`. Nie ma wpływu na działającą wersję na MSI (`25097a3`).

## 7. Testy

| Test | Status |
|---|---|
| `pnpm test` (Vitest) | NOT RUN lokalnie (brak Node/pnpm). Wynik CI dla tego PR: zob. opis PR. |
| `cargo test` / `cargo check` | NOT RUN lokalnie (brak Rust). Wynik CI: zob. opis PR. |
| Test na MSI / DualSense / 4K / HDMI / autostart | BLOCKED (sprzęt, zgoda). |

## 8. Funkcje wymagające testów na MSI

- Druga instancja z Start i z Startup (3.3).
- Powrót do VELORY po Edge, Netflix, Disney+, YouTube (czas i fokus).
- Sen i wybudzenie (3.2), zmiana rozdzielczości, odłączenie HDMI.
- Pomiar CPU przy trybie tła muzyki (3.6).

## 9. Funkcje wymagające DualSense i telewizora

- Nawigacja kontrolerem, zachowanie fokusu po powrocie z aplikacji, Options/PS (3.12 i sprint B).
- Czytelność i fokus na Panasonic 4K (sprint C).
