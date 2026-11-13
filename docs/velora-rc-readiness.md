# VELORA 2.0 — Release Candidate Readiness

Data: 2026-11-13. Gałąź robocza: `test/velora-rc-stabilization` (na bazie
`test/velora-2-combined` @ `f82654c`). Draft PR do `test/velora-2-combined`.

**Werdykt:** nie jest to release candidate do użytkowników. Wersja nadaje się do
**pierwszego kontrolowanego testu na sprzęcie testowym**, nie na zainstalowanym
MSI i nie na działającej wersji 0.9.2. Żaden punkt sprzętowy nie został
uruchomiony w tej sesji, więc żaden nie ma statusu PASS.

Zasady sesji zachowane: bez merge do `main`, bez release, bez instalacji na MSI,
bez zmian w działającej wersji i w folderze rollbacku
(`C:\Users\milos\VELORA-rollback-2026-11-12`), nowe zmiany tylko w Draft PR.

## 1. CI

| Element | Head | Run (PR / push) | Wynik |
|---|---|---|---|
| PR #44 DualSense (`fix/velora-2-dualsense-input-normalization`) | `1781e6a` | 43413682854 / 43413679415 | zielone: macOS, Windows (Tauri/Rust, NSIS), Playnite net462 |
| PR #46 Edge rollback (`fix/velora-2-edge-spawn-rollback`) | `9856163` | 43413883591 / 43413741169 | zielone |
| PR #47 wyszukiwarka (`feat/velora-2-app-search`) | `da6489d` | 43413889897 / 43413761870 | zielone |
| `test/velora-2-combined` | `f82654c` | 43413875314 | zielone |

Nie było czerwonych CI do naprawy. „Publish GitHub Release" jest pominięty
na każdym przebiegu, zgodnie z zasadą bez release.

## 2. Co sprawdzono lokalnie (`test/velora-rc-stabilization`)

| Polecenie | Wynik |
|---|---|
| `pnpm install --frozen-lockfile` | OK |
| `pnpm test` (vitest) | **PASS: 75 plików, 651 testów** (baza: 73 / 639; dodano 12) |
| `pnpm build` (`tsc -b` + `vite build`) | OK |
| `cargo test --locked --lib` (src-tauri) | **PASS: 264 testów** |
| `git diff --check` | czysto |
| Lokalny instalator NSIS (`pnpm tauri build --ci --target x86_64-pc-windows-msvc`) | patrz sekcja 6 |

## 3. Audyt — co sprawdzono i jak

Przegląd był oparty na kodzie i testach, nie na uruchomieniu aplikacji. Tam, gdzie
pokrycie to tylko testy jednostkowe, jest to zaznaczone.

| Obszar | Sprawdzono | Wynik |
|---|---|---|
| Polityka Edge: tylko WM_CLOSE, bez zabijania procesów | `src-tauri/src/window_broker.rs` `close_tracked_window`: odmawia własnego okna VELORY, okna spoza PID z rejestru uruchomień, własnego PID; `request_close` to `PostMessageW(WM_CLOSE)`. `DestroyWindow` w `gamepad_home.rs` działa tylko na własnym, ukrytym oknie raw input. | **OK w kodzie** |
| Zarządzanie fokusem i modalami | `shouldRestoreDockFocus` nie przywraca fokusu, gdy otwarte jest Control Center, diagnostyka albo jakikolwiek `dialog[open]`. Pozycja B1 z `docs/velora-2.0-audit.md` jest zamknięta w kodzie. | **OK w kodzie** (`windowFocusRestore.test.ts`) |
| Escape przy otwartym modalu | Bez klawiatury: zamyka Control Center. Z klawiaturą: przechwytuje ją klawiatura (faza capture), więc Control Center zostaje otwarte. | **OK w kodzie**, pokryte testem integracyjnym |
| Wyszukiwarka i klawiatura ekranowa | `TEXT_ENTRY_ATTRIBUTE` ogranicza klawiaturę do pól VELORY. `writeFieldValue` używa natywnego setter-a, więc React widzi wpisany tekst. Commit i cancel oddają fokus polu. | **OK**, pokryte testem integracyjnym |
| Timeouty odczytu statusu | Odczyt statusu Windows i iPhone Remote **nie miał limitu czasu**. Zawieszone wywołanie blokowało ponowienie (przycisk wyłączony, guard in-flight). | **BŁĄD POTWIERDZONY, NAPRAWIONY** (sekcja 4) |
| Timeouty pilota | `remoteReliability.ts`: 5 s na potwierdzenie polecenia, testy istnieją. | OK (testy jednostkowe) |
| Timeout pogody | `useWeather.ts`: abort po 10 s, czyszczony przy zakończeniu. | OK w kodzie |
| Zdarzenia `velora-gamepad-home` i `velora-launch-error` | Emitowane w Rust (`gamepad_home.rs`, `launch_registry.rs`). Nie ma żadnego nasłuchu w `src/` (sprawdzone grepem). | **Znany brak, nie naprawiony** (sekcja 5) |
| DualSense Cross/Circle, pilot iPhone, Steam, Playnite, lifecycle, single-instance, odzyskiwanie sesji | Pokryte testami jednostkowymi (`controllerInput`, `remoteSecurityInvariants`, `sessionOrchestrator`, `playnite*` itd.). | **Tylko testy, bez przeglądu linia po linii i bez sprzętu.** Nie deklaruję PASS. |

## 4. Naprawiony błąd: brak limitu czasu na odczyt statusu

- Przed: `ControlCenter.tsx` czekał bez końca na `getControlServiceStatus` i
  `getRemoteAccessStatus`. Przy zawieszonym backendzie etykieta „Odczytuję…"
  zostawała, przycisk „Ponów odczyt" był wyłączony, a guard in-flight blokował
  ponowienie. Użytkownik nie miał wyjścia bez restartu.
- Po: `src/services/withTimeout.ts` (`STATUS_READ_TIMEOUT_MS = 8000`). Po
  przekroczeniu czasu odczyt kończy się jak każdy błąd: komunikat „Nie udało się
  odczytać stanu Windows", ponowienie odblokowane. Późna odpowiedź jest odrzucana
  przez istniejący guard `requestId`.
- Testy: `src/__tests__/statusReadTimeout.test.tsx` (3 testy, z fałszywym zegarem).

## 5. Dodane testy integracyjne

`src/__tests__/searchKeyboardIntegration.test.tsx` (9 testów). Harness składa
prawdziwe `ControlCenter`, `useVirtualKeyboardHost` i `VirtualKeyboard`, a wejście
pada i pilota odwzorowuje ścieżki z `App.tsx`:

- Szukaj w Control Center pokazuje pole i pełną listę.
- Select na polu otwiera klawiaturę; wpisanie zapytania nie zmienia pola, dopiero
  „Gotowe" zapisuje i filtruje wyniki; wybór wyniku uruchamia właściwy identyfikator.
- „Anuluj bez zmian" zostawia pole puste i oddaje fokus polu.
- Escape (zdarzenie `cancel` dialogu) zamyka klawiaturę bez zapisu i oddaje fokus.
- Pad: Menu jest przechwytywane przez klawiaturę; Home anuluje szkic bez zapisu
  i pozwala działać zwykłej akcji Home.
- Pad: select i kierunki trafiają do klawiatury, a nie do zakładek pod spodem.
- Select na zakładce i na wyniku nie otwiera klawiatury.
- Pusty wynik: komunikat, brak uruchomienia.
- Błąd odczytu statusu Windows nie blokuje wyszukiwania.

Nie dodano (świadomie):

- **Powrót do VELORY po zamknięciu aplikacji** na poziomie całej aplikacji.
  Logika jest pokryta testami jednostkowymi (`homeReturn`, `returnHomeFocus`),
  ale pełny test wymagałby mockowania całego Tauri i zdarzeń natywnych. Ryzyko
  niskie dla tej sesji, ale to luka: sprawdzić na sprzęcie.
- **Nawigacja po strefach z modalem**: istniejące testy (`navigationZones`,
  `homeZones`) nie zostały rozszerzone.

## 6. Instalator Windows

- CI: krok „Build Windows x64 NSIS installer" przeszedł na `f82654c` (zadanie
  `windows-latest / React, Tauri, Rust` zielone).
- Lokalnie: [WYNIK ZOSTANIE UZUPEŁNIONY PO ZAKOŃCZENIU BUDOWY]
- Instalator **nie został zainstalowany**.

## 7. Możliwe regresje

- **Timeout 8 s na odczyt statusu:** zimny start WMI na wolnym PC może go
  przekroczyć. Skutek: fałszywy komunikat „Nie udało się odczytać stanu Windows"
  z przyciskiem ponowienia. Łagodne, ale widoczne.
- **Nakładanie się odczytów:** po timeoucie stary odczyt może wrócić później.
  Guard `requestId` go odrzuca, ale to zachowanie warto sprawdzić przy szybkim
  ponawianiu.
- **Klawiatura przechwytuje Escape:** przy otwartej klawiaturze Escape nie zamyka
  Control Center. To zamierzone, ale użytkownik może to uznać za błąd.
- **Edge i procesy po zamknięciu VELORY:** procesy uruchomione przez VELORĘ nadal
  działają po jej zamknięciu (znane, świadome, `docs/velora-2-sprint-a-status.md`).
- **Zawieszony natywny start blokuje kafelek** do restartu (świadomy kompromis z
  double-activation, `useLaunchGuard`).

## 8. Co sprawdzić na MSI przed pierwszym testem

Na maszynie testowej, nie na zainstalowanej wersji 0.9.2. Jeśli coś wymaga
instalacji, wymaga zgody właściciela.

1. Start: ekran główny, dock, fokus, Grand Cinema bez zmian wyglądu.
2. Szukaj z Control Center: otwarcie, pad, klawiatura, „Gotowe" i „Anuluj", fokus
   wraca do pola.
3. Klawiatura fizyczna: litery, Backspace, Enter, Escape.
4. DualSense: Cross, Circle, D-pad; odłączenie i ponowne podłączenie pada.
5. Control Center: odczyt statusu Windows; komunikaty błędów.
6. Pilot iPhone: sparowanie, nawigacja, Home; polityka uprawnień.
7. Edge: start, zamknięcie przez WM_CLOSE, brak zabijania innych okien; przypadek
   nieśledzonego startu wycofuje się bez ruszania cudzych okien.
8. Steam i Playnite: start, powrót do VELORY.
9. Single-instance: drugie uruchomienie aktywuje okno.
10. Sen i wybudzenie (NOT RUN od poprzednich sprintów).
11. Restart Windows i logowanie.
12. Folder rollbacku i działająca wersja 0.9.2 nietknięte.

## 9. Otwarte, nie naprawiane w tym RC

- `velora-gamepad-home` i `velora-launch-error` nie mają nasłuchu w froncie:
  błąd natywnego Home dla DualSense nie jest widoczny na TV.
- Brak zabezpieczenia przed paniką w wątku watchera (`ensure_watcher` /
  `watcher_tick` w `launch_registry.rs`) i w monitorze sesji (`session_monitor.rs`).
  Zapisane w `docs/velora-2-sprint-a-status.md`; w tej sesji nie odtworzono.
- Pliki tymczasowe sesji po awarii między zapisem a zmianą nazwy (wzmianka z
  dokumentu sprint A). Wzorca `velora-session.tmp` nie znaleziono w `src-tauri/src`,
  więc nie potwierdzone w tej sesji.

## 10. Czy wersja nadaje się do pierwszego kontrolowanego testu?

**Tak, warunkowo.** Kod przechodzi CI i testy lokalne, a jedyny potwierdzony błąd
z audytu (brak timeoutu na odczyt statusu) jest naprawiony. Warunki:

- test na sprzęcie testowym, z łatwą możliwością odinstalowania;
- wyniki punktów z sekcji 8 zapisane jako PASS, FAIL albo NOT RUN, bez PASS bez
  faktycznego testu;
- żadnych zmian w działającej wersji 0.9.2 ani w rollbacku.

Nie jest to wersja do release.
