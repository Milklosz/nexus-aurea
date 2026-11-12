# VELORA 1.0 — Ecosystem / MODUŁ B: Edge Cinema Lifecycle 2.0

> **Status: ADAPTER + TYPOWANE ZDARZENIA (prototyp).** To **NIE jest WindowBroker**
> ani uruchomiona integracja produkcyjna. VELORA nie wyszukuje okien (brak HWND /
> `EnumWindows`), nie odpytuje ich wątkiem watchera i **nie zabija żadnego procesu**.
> Moduł przygotowuje stabilny stan sesji i kontrakt zdarzeń dla **przyszłej**
> integracji z `WindowBroker` / `SessionOrchestrator` (dziedzina DeepSeek).

Powiązane: [docs/edge-cinema-v1.md](./edge-cinema-v1.md),
[docs/velora-v1-experience.md](./velora-v1-experience.md).

## Co dodano (zakres zmian)

| Warstwa | Plik | Zmiana |
| --- | --- | --- |
| Rust | `src-tauri/src/edge_cinema.rs` | addytywnie: `EdgeCinemaSession`, `EdgeCinemaSessions` (in-memory `Mutex`), 3 ładunki zdarzeń, czyste helpery przejść stanu, modyfikacja `launch_edge_cinema` (duplikat + pid + emit), 4 nowe komendy, 8 nowych czystych testów |
| TS | `src/services/edgeCinemaLifecycle.ts` | **nowy**: deskryptor `prototype: true`, `normalizeCinemaSession`, mapowanie błędów, 4 funkcje `invoke`, 2 adaptery (Tauri + fallback), `setVeloraFullscreen`, `shouldRestoreVeloraOnExit`, `shouldBlockDuplicateLaunch` |
| Testy | `src/__tests__/edgeCinemaLifecycle.test.ts` | **nowy**: pokrycie normalizacji, komend, adapterów, zdarzeń, błędów, fullscreenu |
| Integracja | `src-tauri/src/lib.rs` | **LEAD** (już wykonane): `.manage(edge_cinema::EdgeCinemaSessions::default())` + rejestracja 4 komend w `generate_handler!` |

Brak nowych zależności (npm / cargo), brak zmian w `Cargo.lock` / `pnpm-lock.yaml`,
brak nowych feature'ów crate `windows`. Kod systemowy Windows pozostaje w
`#[cfg(target_os = "windows")]`; na macOS moduł się kompiluje, a `launch_edge_cinema`
zwraca stały błąd dostępności.

### Backward compat (zachowane bez zmian)

`EDGE_CINEMA_PROFILE_NAME`, `profile_directory_name()`, `is_allowed_streaming_url()`,
`edge_cinema_arguments()` (**dokładnie 6 flag, dokładnie jeden `--user-data-dir`**),
`edge_cinema_notes()`, `EdgeCinemaStatus`, `EdgeCinemaReceipt` (pola i derive'y),
kształt `get_edge_cinema_status()`, **wszystkie 7 istniejących testów Rust** oraz
wszystkie istniejące testy TS. Po stronie JS `launch_edge_cinema` wciąż przyjmuje
`{ url }` i zwraca ten sam `EdgeCinemaReceipt`. Jedyna zmiana sygnatury dotyczy
**Rust**: `launch_edge_cinema(url, sessions: State, app: AppHandle)` — `State` i
`AppHandle` wstrzykuje Tauri, frontend ich nie przekazuje.

**Nowe komendy Tauri** (zarejestrowane przez LEAD-a w `lib.rs`):

- `edge_cinema::get_edge_cinema_session`
- `edge_cinema::request_edge_cinema_close`
- `edge_cinema::report_edge_cinema_exit`
- `edge_cinema::reset_edge_cinema_session`

## Maszyna stanów sesji

`EdgeCinemaSession.state` jest jednym z sześciu stanów (mirror kontraktu
`SessionStatus` w `src/contracts/session.ts`):

```
idle ──launch──▶ active ──close-request──▶ closing ──exit──▶ exited
  │                 │                                        ▲
  └─────────────────┴──────── error ─────────────────────────┘
```

| Kategoria | Stany | Helper (Rust / TS) |
| --- | --- | --- |
| **ACTIVE** | `launching`, `active` | `session_is_active` / `isActiveSession` |
| **CLOSED** | `exited`, `error` | `session_is_closed` / `isClosedSession` |
| przejściowe | `idle`, `closing` | — |

Przejścia (`mark_closing`, `mark_exited`, `mark_error`) są **niemutowalne** —
zwracają NOWY rekord, oryginał pozostaje niezmieniony. `last_error` jest zawsze
sanitized (bez znaków sterujących, max 240 znaków, bez surowego stosu / ścieżek).

Rekord zawiera wyłącznie bezpieczne dane diagnostyczne: `sessionId`, `state`,
`appId` (`edge-cinema`), `pid`, `windowTitle`, `profileDir`, `url`, `launchedAt`,
`lastError`, `managedByVelora`. **Brak uchwytów HWND i surowych ścieżek systemowych.**

## Zapobieganie duplikatom uruchomienia

`launch_edge_cinema` **jako pierwszy krok** (w wydzielonym bloku, blokada mutexa
zwalniana PRZED `spawn`) sprawdza `should_reject_duplicate(current)`. Ponowne
uruchomienie jest odrzucane wyłącznie, gdy bieżąca sesja jest **ACTIVE**
(`launching` | `active`):

```
Err("Okno Edge Cinema jest już uruchomione. VELORA nie uruchamia duplikatu.")
```

Po udanym `spawn` zapisywany jest `pid` (przed `drop(child)`), budowany jest rekord
`begin_session(...)`, stan trafia do `Mutex`, a VELORA emituje
`velora://cinema-session-changed`. `EdgeCinemaReceipt` pozostaje identyczny.

Po stronie TS `shouldBlockDuplicateLaunch(session)` jest **niewiążącą, wczesną
wskazówką dla UI** — ostateczna decyzja zawsze należy do warstwy natywnej (Rust).

## Bezpieczne wykrycie zamknięcia — ADAPTER, nie WindowBroker

`report_edge_cinema_exit` to **bezpieczny adapter wykrycia zamknięcia**: waliduje
`sessionId` zgodny z bieżącą sesją, wykonuje `mark_exited`, zapisuje stan i emituje
`velora://cinema-exited` (`reason: "closed"`). Zakłada się, że w przyszłości wywoła
go broker / obserwator pierwszoplanowy. **VELORA sama nie odpytuje okien, nie
trzyma wątku watchera i nie zabija procesu Edge.**

`request_edge_cinema_close(sessionId, confirm)`:

- **wymaga `confirm == true`** (inaczej `unconfirmed_close_error`),
- waliduje zgodność `sessionId` z bieżącą sesją **oraz** `managedByVelora == true`
  (inaczej `unmanaged_close_error`),
- wykonuje `mark_closing`, zapisuje stan, emituje
  `velora://cinema-close-requested` (`confirmed: true`),
- **NIE kończy żadnego procesu** — to wyłącznie typowane zdarzenie dla przyszłego
  `WindowBroker` (DeepSeek).

`get_edge_cinema_session` (read-only) i `reset_edge_cinema_session` (recovery po
restarcie VELORA, czyści do `idle`, wyłącznie pamięć) domykają diagnostykę.

## Trwały profil — bez zmian

Profil `VELORA-EdgeCinema` (`<LOCALAPPDATA>/VELORA/VELORA-EdgeCinema`), allowlista
5 adresów HTTPS, dokładnie 6 flag (w tym `--start-fullscreen`, `--no-first-run`,
`--no-default-browser-check`) i odłączanie procesu (`spawn` + `drop`) pozostają
**dokładnie takie jak w v1**. Logowania do serwisów są trwałe między uruchomieniami.
Nowy moduł nie zmienia żadnej flagi, nie dodaje flag i nie dotyka ustawień systemu.

## Obsługa błędów Edge

`edgeCinemaLifecycleErrorMessage(cause)` mapuje surowe błędy natywne na czyste,
polskie komunikaty **bez wycieków** (`C:\`, `os error`, `0x`, stos wywołań):

| Sytuacja | Komunikat |
| --- | --- |
| duplikat uruchomienia | „Okno Edge Cinema jest już uruchomione. VELORA nie uruchamia duplikatu." |
| brak potwierdzenia zamknięcia | „Zamknięcie okna Edge Cinema wymaga potwierdzenia." |
| sesja niezarządzana / zły `sessionId` | „Tej sesji Edge Cinema nie można zamknąć z VELORA — okno nie zostało uruchomione przez aplikację." |
| nie-Windows (macOS) | „Edge Cinema jest dostępne tylko w natywnej aplikacji Windows." |
| błąd `spawn` | „Nie udało się uruchomić okna Edge Cinema. Spróbuj ponownie." |
| nieznany | ogólny komunikat bez surowego tekstu |

`getEdgeCinemaSession()` przy błędzie `invoke` zwraca sesję w stanie `error` z
`sanitized` `VeloraError("edge-error", ...)`. `requestEdgeCinemaClose()` zwraca
`ActionAck` (`executed` / `rejected`) z deterministycznym `idempotencyKey`.

## Diagnostyka sesji

`normalizeCinemaSession(value)` to **ścisła, bezpieczna normalizacja** wire →
`CinemaSession`: nigdy nie rzuca, przyjmuje wyłącznie dozwolone `state` (wstrzyknięty
`state` spoza whitelisty → `idle`), weryfikuje typy, sanityzuje `lastError`, a przy
braku danych zwraca bezpieczne defaulty (m.in. `managedByVelora: false` dla
nieznanej sesji — VELORA nie zakłada, że zarządza obcym oknem). `EdgeCinemaSessionWire`
jest camelCase lustrem struktury Rust (`state` → TS `status`).

## Pełny ekran — co VELORA kontroluje, a czego nie

- `setVeloraFullscreen(enabled)` ustawia pełny ekran **WYŁĄCZNIE własnego okna
  VELORA** przez istniejący helper `windowMode(enabled)` z `src/services/windowMode.ts`
  (plik tylko czytany, nie modyfikowany; w module nie ma osobnej eksportowanej
  funkcji `setFullscreen` — używamy `windowMode`).
- Pełny ekran **okna Edge** to wyłącznie flaga `--start-fullscreen` nadana przy
  uruchomieniu (v1). VELORA nie steruje pełnym ekranem Edge po starcie.
- **VELORA nie gwarantuje i nie zmienia** DRM / Widevine / PlayReady, HDCP, 4K, HDR,
  możliwości GPU, subskrypcji ani dostępności usługi. **Brak jakichkolwiek flag
  omijających / osłabiających DRM, HDCP lub zabezpieczenia przeglądarki.**

## Plan powrotu do VELORA (return-to-VELORA) — NIE zaimplementowany

`shouldRestoreVeloraOnExit(session)` zwraca `true` wyłącznie dla sesji
**CLOSED + `managedByVelora`**. To **predykat / plan**, nie uruchomione okablowanie:

Po otrzymaniu `velora://cinema-exited` dla zamkniętej, zarządzanej sesji przyszły
`SessionOrchestrator` powinien wywołać
`focusWindowSafely(getCurrentWindow(), onBlocked, onFocused)` (wzorzec z `App.tsx`,
`src/services/focusWindowSafely.ts` — plik DeepSeek, tylko czytany), aby przywrócić
fokus własnego okna VELORA.

**`App.tsx` nie jest modyfikowany.** Żadna integracja z `WindowBroker` nie została
uruchomiona — to wyłącznie kontrakt zdarzeń + predykat pod przyszłe podłączenie.

## Tabela typowanych zdarzeń

| Zdarzenie (`VELORA_EVENTS`) | Emitowane przez | Ładunek | Odbiorca (przyszłość) |
| --- | --- | --- | --- |
| `velora://cinema-session-changed` | `launch_edge_cinema` (Windows) | `CinemaSessionEvent { session }` | UI / orchestrator |
| `velora://cinema-close-requested` | `request_edge_cinema_close` | `CinemaCloseRequestedEvent { sessionId, confirmed: true }` | `WindowBroker` |
| `velora://cinema-exited` | `report_edge_cinema_exit` | `CinemaExitedEvent { sessionId, reason: "closed" }` | powrót fokusu do VELORA |

Nazwy i ładunki są zgodne z `src/contracts/events.ts`. Forwarding w TS odbywa się
przez `typedEvent(name, payload)` w `createTauriEdgeCinemaLifecycleAdapter().subscribe`
(`listen` na 3 nazwach, zwracany jest złożony `unsubscribe`). Fallback adapter dla
podglądu WWW to bezpieczny no-op, który nigdy nie woła `invoke`.

## Uczciwe ograniczenia

- **Prototyp / adapter — NIE uruchomiona integracja.** Deskryptor ma
  `prototype: true`. `WindowBroker` / `SessionOrchestrator` pozostają w domenie
  DeepSeek i nie są tu implementowane ani duplikowane.
- **Środowisko: macOS.** Windows-owe ścieżki (`spawn`, `pid`, `msedge.exe`) są
  kompilowane w CI Windows, **nie testowane lokalnie na macOS**. Na macOS komendy
  zwracają komunikat o dostępności wyłącznie w natywnej aplikacji Windows.
- **Brak testów na MSI i brak testów sprzętowych.** Nie wykonano instalacji MSI,
  nie potwierdzono zachowania realnego okna Edge ani odtwarzania strumienia.
- **Brak gwarancji 4K / HDR / DRM / HDCP** i brak jakiegokolwiek bypassu
  zabezpieczeń przeglądarki.
- **Brak finalnego ogłoszenia release / merge.** To dokument modułu roboczego,
  bez publikacji i bez deklaracji gotowości produkcyjnej.
- **Brak zabijania procesów, enumeracji okien, wątku watchera i HWND.**
  Zamknięcie jest wyłącznie typowanym zdarzeniem / aktualizacją stanu.
