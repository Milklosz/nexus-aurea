# VELORA 1.0 — System Intelligence (NIGHT MEGA SPRINT II)

Status: gałąź `feat/velora-v1-system-intelligence`, osobny Draft PR do
`feat/velora-v1-core`. Bez merge, bez release i bez zmian w PR #13–#16.
Bazuje na ukończonym rdzeniu VELORA 1.0 z Draft PR #16.

Dokument opisuje architekturę, audyt wejściowy, faktycznie działające funkcje,
ograniczenia wymagające MSI oraz procedurę testów sprzętowych.

## 1. Audyt przed implementacją

Sprawdzone zostały: `session_orchestrator`, `window_broker`, `launch_registry`,
`gamepad_home`, `control_service`, `app_manager`, most IPC w `src/services`
oraz CI w `.github/workflows/ci.yml`.

Najważniejsze ustalenia:

| Obszar | Problem | Reakcja |
| --- | --- | --- |
| Process scanning | `launch_registry` i `app_manager` miały własne implementacje Toolhelp32; status aplikacji mógł wykonywać kilka pełnych skanów | wspólny `process_table` z cache 350 ms i wymuszonym świeżym odczytem dla baseline'u uruchomienia |
| Session state | stan sesji żył wyłącznie w pamięci; crash oznaczał brak informacji o poprzedniej sesji | wersjonowany zapis `velora-session.json` w katalogu danych aplikacji, atomowa wymiana pliku, rollback do Home |
| Commands | powtórzone lub spóźnione przejście nie miało identyfikatora ani zabezpieczenia rewizji | `commandId`, `expectedRevision`, `issuedAtMs`, ograniczony cache komend |
| Cancellation | powrót do Home nie miał operacji, timeoutu ani anulowania | `OperationRegistry` z deadline 3 s i komendami `get_session_operations` / `cancel_session_operation` |
| PID reuse | PID był traktowany jako tożsamość procesu | `ProcessIdentity` (PID + czas utworzenia) dla rootów i okien |
| Window main window | pierwsze napotkane okno procesu mogło być dialogiem lub oknem pomocniczym | scoring widoczności, właściciela, klasy, rozmiaru i pierwszego planu; jedno `isMain` na proces |
| Foreground | odmowa `SetForegroundWindow` była raportowana, ale bez przyczyny | klasyfikacja `foregroundLock`, `accessDenied`, `invalidWindow`, `unknown` |
| DualSense | `GIDC_REMOVAL` miał wartość `1`, czyli tę samą co `GIDC_ARRIVAL` | poprawione `GIDC_ARRIVAL = 1`, `GIDC_REMOVAL = 2`; dodany reconnect i diagnostyka |
| Display/audio | brak natywnej warstwy tylko do odczytu | nowy `display_audio` z EnumDisplayMonitors, DisplayConfig, Core Audio i monitoringiem sygnatury |
| Polling | 350 ms procesów + 500 ms okien + 25 ms pętli usługi | 600 ms aktywnego rejestru, 750 ms okien, 40 ms pętli, 10 s monitora wyświetlaczy, cache procesów |
| Diagnostics | brak jednego snapshotu i bezpiecznego eksportu | `diagnostics` z typowanym kontraktem, redakcją ścieżek i SHA-256 raportu |

## 2. Architektura

```text
WebView (React)
  ├─ sessionOrchestrator.ts ── IPC ──► session_orchestrator.rs
  ├─ controlService.ts ────── IPC ──► control_service.rs ──► gamepad_home.rs
  ├─ displayAudio.ts ──────── IPC ──► display_audio.rs
  └─ diagnostics.ts ───────── IPC ──► diagnostics.rs
                                          ├─ session_orchestrator
                                          ├─ launch_registry
                                          ├─ window_broker
                                          ├─ control_service
                                          └─ display_audio

launch_registry ── process_table (Toolhelp + cache)
      │                 └─ ProcessIdentity (PID + creation time)
      ├─ window_broker (EnumWindows, foreground, restore policy)
      └─ session_orchestrator (transition table, recovery, operations)

session_monitor ── resume gap + orphan reconciliation
session_store ──── atomic JSON snapshot, clean-shutdown marker
```

Zasada: **jeden właściciel stanu**. Sesja nie zgaduje stanu z okien; okna i
uruchomienia raportują fakty, a przejścia sesji przechodzą przez jawną tabelę.
`launchId` i `sessionRevision` są nośnikami korelacji, nie źródłem prawdy.

## 3. Session Orchestrator 2.0

Plik: `src-tauri/src/session_orchestrator.rs`.

- Stany i tabela przejść bez zmian semantycznych: Home wchodzi wszędzie,
  Game/Playnite/Cinema mogą przekazywać sesję między sobą, Desktop/Ambient
  wymagają powrotu do Home.
- `SessionContext` zawiera teraz `sessionRevision`.
- `SessionSnapshot` zawiera opcjonalny `recovery` z powodem:
  `unexpectedExit`, `cleanRestart`, `corruptState`, `orphanedLaunch`.
- `commandId` jest idempotentny w ramach 64 ostatnich komend; powtórka zwraca
  pierwotny snapshot i nie zwiększa rewizji.
- `expectedRevision` odrzuca nieaktualne komendy jako `staleRevision`.
- `issuedAtMs` starszy niż 10 s jest odrzucany jako `expiredCommand`.
- `SessionError` zawiera `currentRevision` i `allowedTargets`, więc UI i MSI
  widzą, dlaczego przejście zostało odrzucone.
- `return_velora_home` tworzy operację z deadline 3 s. Anulowanie przed
  przywróceniem okna zwraca `cancelled`; przekroczenie deadline jest
  raportowane jako `timedOut`, ale wynik okna nadal jest prawdziwy.
- Po restarcie VELORA zawsze startuje w Home. Poprzednia sesja jest raportowana,
  nigdy automatycznie odtwarzana. Rewizja jest kontynuowana, aby korelacja
  zdarzeń nie kolidowała po restarcie.
- `session_monitor` wykrywa przerwę monotoniczną ≥ 6 s (sleep/wake lub
  zawieszenie procesu), resetuje okno łaski zakończenia i uruchamia
  rekoncyliację osieroconych uruchomień. Co 5 s sprawdza też osierocony
  `launchId`.

Polecenia: `get_session_state`, `request_session_transition`,
`get_session_operations`, `cancel_session_operation`, `return_velora_home`.

Zdarzenia: `velora-session-changed`, `velora-session-error`,
`velora-session-recovery`, `velora-return-home`, `velora-system-resumed`.

## 4. WindowBroker 2.0

Plik: `src-tauri/src/window_broker.rs`.

- `TrackedWindow` ma `processCreatedAt100Ns`, `score` i `isMain`.
- Scoring odrzuca okna niewidoczne, zerowe, `WS_EX_TOOLWINDOW` i „cloaked”
  (DWM). Okna z właścicielem są śledzone, ale nie stają się głównym oknem,
  jeśli istnieje lepszy kandydat.
- PID + czas utworzenia procesu tworzą tożsamość. Okno z tego samego,
  recyklowanego PID-u, ale innego procesu, jest ignorowane.
- Przy przywracaniu VELORA sprawdzane są: `IsWindow`, PID właściciela i klasa
  okna. Wygasły lub ponownie użyty HWND kończy się `windowUnavailable`.
- `SetForegroundWindow` jest wywoływane raz; wynik jest weryfikowany. Odmowa
  jest klasyfikowana i raportowana wraz z kodem Win32. Brak pętli wymuszającej
  fokus, brak `AttachThreadInput`, hooków i DLL injection.
- Polityka automatycznego powrotu bez zmian: tylko pulpit Windows, Playnite,
  VELORA lub brak aktywnego okna. Jawne żądanie użytkownika może poprosić o
  fokus, ale nadal jest weryfikowane.
- `velora-foreground-changed` zawiera poprzedni HWND i rodzaj zmiany
  (`gained`, `lost`, `changed`).
- Monitor pierwszego planu ma 750 ms, kontrolowany stop i nie wykonuje
  pełnego EnumWindows w ścieżce rejestru uruchomień (szybki odczyt
  `GetForegroundWindow`).

## 5. LaunchRegistry — odporność i wydajność

Plik: `src-tauri/src/launch_registry.rs`.

- Fazy: `requested → processStarted → windowAppeared → sessionActive →
  exitPending → ended`, plus `failed` i `cancelled`.
- `LaunchSession` ma `pidReuseDetected`, `attention`, `sessionRevision` i
  zachowany wynik przywrócenia okna.
- Wykrywanie PID reuse: root ma zapisaną tożsamość procesu. Zmiana czasu
  utworzenia oznacza inny proces; sesja kończy się po 5 s łaski, nie
  przejmując nowego procesu.
- Okna są filtrowane po tożsamości procesu, więc recyklowany HWND nie jest
  liczony jako okno gry.
- Po sleep/wake okno łaski jest resetowane; proces, który zniknął podczas snu,
  dostaje pełne 5 s na potwierdzenie zakończenia.
- `cancel_launch_session` anuluje aktywne uruchomienie w sposób idempotentny.
- Polling: 600 ms przy aktywnej sesji, 1000 ms bezczynnie. Cache procesów ma
  350 ms; baseline uruchomienia wymusza świeży odczyt.
- Wątek watcherski ma kontrolowany stop i jest zatrzymywany przy wyjściu.
- Emisja zdarzeń jest deduplikowana przez porównanie fazy; powtórzone
  obserwacje nie tworzą nowych zdarzeń.

## 6. DualSense Home 2.0

Plik: `src-tauri/src/gamepad_home.rs`. Nadal część Control Service.

- Rozpoznawanie modelu: DualSense (`0x0CE6`) i DualSense Edge (`0x0DF2`).
- Tryb połączenia tylko wtedy, gdy ścieżka urządzenia jednoznacznie wskazuje
  USB lub Bluetooth; inaczej `unknown`. Nie zgadujemy z VID/PID.
- Publiczny status nie zawiera surowej ścieżki urządzenia — tylko 16-znakowy
  skrót FNV-1a.
- `GamepadDeviceInfo` raportuje model, tryb, czas połączenia, ostatni raport,
  liczbę raportów, ostatnią kombinację i licznik reconnectów.
- `GIDC_ARRIVAL = 1`, `GIDC_REMOVAL = 2` (poprzednia wartość removal była
  błędna). Przy arrival czyszczony jest cache ścieżki i stan kombinacji.
- Duplikaty identycznych raportów w oknie < 8 ms są liczone i pomijane.
  Raport po 8 ms jest przetwarzany normalnie.
- `ChordDiagnostic` raportuje `triggered`, `armed`, `cooldown`, `latched`,
  `released`, `rejectedWindow` lub `ignored`.
- Control Service wykrywa sytuację „Windows widzi kontroler Sony, ale Raw
  Input nie ma raportów przez ≥ 8 s” i pokazuje ostrzeżenie o możliwym
  Steam Input. To jest hipoteza diagnostyczna, nie pewny werdykt.
- Alternatywny skrót klawiaturowy: `Ctrl+Alt+N`, `Ctrl+Shift+N`,
  `Alt+Shift+N`. Zmiana jest walidowana po stronie backendu i obowiązuje w
  bieżącym uruchomieniu Control Service. Nie jest zapisywana na dysk.
- `Ctrl+Alt+F12` pozostaje awaryjnym wyłączeniem usługi.
- Brak przechwytywania, blokowania i mapowania inputu gry. Brak sterowników.

## 7. Display & Audio — bezpieczny fundament

Plik: `src-tauri/src/display_audio.rs`.

Tylko odczyt:

- aktywne monitory (`EnumDisplayMonitors`, `GetMonitorInfoW`),
- rzeczywisty tryb (`EnumDisplaySettingsW`: rozdzielczość, Hz, bity),
- HDR/advanced color przez `DisplayConfigGetDeviceInfo`, jeśli API odpowie;
  w przeciwnym razie `hdr: null` i `hdrError`,
- przyjazna nazwa monitora z DisplayConfig, bez surowej ścieżki,
- domyślne urządzenie audio Core Audio, lista renderujących, stan, głośność
  i mute tylko do odczytu,
- sygnatura konfiguracji wyświetlaczy; zmiana emituje
  `velora-display-changed`.

Nie są wywoływane żadne settery rozdzielczości, HDR, domyślnego audio ani
głośności. Panasonic nie jest zakładany jako 4K 120 Hz; raport pokazuje
rzeczywisty tryb Windows. „Zmiana HDMI” jest wnioskowana z sygnatury
monitorów, a nie z nazwy portu.

Polecenie: `get_display_audio_status`.
Zdarzenie: `velora-display-changed`.

## 8. Diagnostics & Self-Test

Plik: `src-tauri/src/diagnostics.rs`, UI:
`src/components/SystemDiagnosticsPanel.tsx`.

Snapshot zawiera:

- wersję, build SHA, target i profil,
- snapshot sesji, operacje i błąd zapisu stanu,
- LaunchRegistry (w tym PID reuse i attention),
- WindowBroker (PID, klasa, tożsamość procesu, score, isMain),
- Control Service i urządzenia DualSense,
- wyświetlacze i audio z polityką read-only,
- listę błędów i ograniczeń.

Polecenia: `get_diagnostics_snapshot`, `export_diagnostics_report`.

Eksport:

- jest budowany wyłącznie z typowanych pól,
- nie zawiera tokenów parowania, kluczy, danych logowania, tytułów obcych okien
  ani surowych ścieżek urządzeń,
- redaguje ścieżki profilu użytkownika (`C:\Users\…`, `/home/…`,
  `/Users/…`, AppData) na `<redacted-path>`,
- usuwa znaki kontrolne i ogranicza długość tekstów,
- ma limit 256 KiB i SHA-256 całego raportu.

Test jednostkowy sprawdza brak zakazanych pól i redakcję ścieżek. Nie jest to
audyt całego UI; raport nadal należy traktować jako dane diagnostyczne.

## 9. Wydajność i cykl życia wątków

| Operacja | Przed | Po |
| --- | --- | --- |
| Skan procesów w rejestrze | pełny Toolhelp co 350 ms | cache 350 ms, polling 600 ms |
| Status aplikacji | kilka skanów | jeden wspólny snapshot |
| Odczyt pierwszego planu w rejestrze | pełny refresh okien | szybki `GetForegroundWindow` |
| Biblioteka Steam | odczyt przy każdym statusie | cache 60 s, świeży odczyt przy launchu |
| Pętla Control Service | 25 ms | 40 ms |
| Monitor okien | 500 ms | 750 ms, stop przy wyjściu |
| Monitor wyświetlaczy | brak | 10 s, stop przy wyjściu |
| Ciężkie komendy IPC | część synchroniczna | `spawn_blocking` (sesja, okna, diagnostyka, audio) |

Wątki mają nazwy i kontrolowany stop: `velora-launch-registry`,
`velora-window-broker`, `velora-display-monitor`, `velora-session-monitor`,
`nexus-control-session`. Control Service jest joinowany przy stopie.

## 10. Testy

Stan lokalny (macOS, bez sprzętu Windows):

- `pnpm test`: 30 plików, 172 testy.
- `cargo test --lib`: 122 testy.
- `pnpm build`: sukces.
- `cargo check`: sukces (kod `cfg(windows)` nie jest kompilowany lokalnie).
- `cargo xwin check` i `cargo xwin test --no-run` dla
  `x86_64-pc-windows-msvc`: sukces. To kompilacja i linkowanie kodu Win32,
  nie uruchomienie testów na Windows.
- `git diff --check`: czysto.

Nowe testy Rust obejmują m.in.:

- recovery po nieoczekiwanym zakończeniu, clean restart, kontynuację rewizji,
- idempotencję komend, konflikt `commandId`, `staleRevision`, `expiredCommand`,
- timeout i anulowanie operacji,
- reset łaski po sleep/wake,
- PID reuse roota i ignorowanie okna z recyklingowanego PID-u,
- klasyfikację odmowy foreground, zmiany fokusu, scoring okien i `isMain`,
- reconnect, duplikaty raportów i wyniki kombinacji DualSense,
- cache procesów, cykle drzewa procesów, tożsamość procesu,
- sygnatury wyświetlaczy, HDR `null`, politykę read-only,
- redakcję ścieżek i brak sekretów w raporcie diagnostycznym.

Nowe testy frontendowe obejmują mosty sesji, operacje/anulowanie, Control
Service, display/audio, diagnostykę i panel System Intelligence.

Windows MSVC i NSIS są uruchamiane przez istniejący CI na `windows-latest`.
Lokalny macOS nie linkuje kodu Win32, dlatego wynik CI jest obowiązkowy.

## 11. Czego nie zweryfikowano bez MSI

- `SetForegroundWindow` na rzeczywistym MSI/Panasonicu i przy różnych
  politykach fokusu.
- EnumDisplayMonitors/DisplayConfig/Core Audio na sprzęcie docelowym;
  HDR może być raportowany inaczej niż oczekuje telewizor.
- Fizyczny DualSense po USB i Bluetooth, w tym reconnect, Steam Input,
  firmware i przycisk PS przechwytywany przez system.
- Sleep/wake na MSI (test syntetyczny sprawdza tylko logikę przerwy).
- NSIS install/run/uninstall i zachowanie WebView2.
- Zachowanie przy monitorze odłączanym w trakcie sesji (logika sygnatury jest
  testowana, ale sam handshake HDMI nie).

## 12. Testy na MSI

1. Zainstaluj wyłącznie artefakt Windows x64 z Actions. Nie wyłączaj
   SmartScreen/Defender. Zapisz SHA-256 instalatora i build SHA z panelu
   System Intelligence.
2. Uruchom VELORA. Sprawdź start w Home, brak dekoracji i wersję.
3. Otwórz diagnostykę (F2) → System Intelligence:
   - zapisz build SHA, target i profil,
   - sprawdź listę wyświetlaczy: rzeczywista rozdzielczość i Hz (nie zakładaj
     120 Hz),
   - sprawdź HDR: `tak`, `nie` lub `niedostępny` z powodem,
   - sprawdź domyślne audio i stan urządzeń,
   - sprawdź brak błędów lub zapisz ich treść.
4. Sleep/wake: wejdź w sesję Game/Cinema, uśpij MSI, obudź. Sprawdź zdarzenie
   `velora-system-resumed`, brak natychmiastowego kończenia sesji i stan
   `sessionRevision`.
5. Crash recovery: uruchom sesję, zakończ proces VELORA z Menedżera zadań,
   uruchom ponownie. Sprawdź Home, komunikat o nieoczekiwanym zakończeniu i
   brak automatycznego przejęcia starej sesji.
6. Orphan: uruchom grę, zamknij proces gry poza VELORA, sprawdź zakończenie
   sesji po grace i powrót do Home.
7. PID reuse: trudne do wymuszenia ręcznie; jeśli uda się uzyskać recykling
   PID, sprawdź `pidReuseDetected` i brak przejęcia nowego procesu.
8. Foreground: otwórz Chrome/File Explorer, zakończ Playnite/grę. VELORA nie
   może przejąć fokusu. Sprawdź `blockedUnsafeForeground` lub
   `blockedByWindows` i kod przyczyny.
9. DualSense USB: włącz Control Service, PS + Options w ciągu 250 ms wraca do
   VELORA. Sprawdź model, tryb USB/Bluetooth, licznik raportów i ostatni wynik
   kombinacji. Rozłącz i połącz ponownie; sprawdź reconnect i brak
   wielokrotnego triggera bez zwolnienia przycisków.
10. DualSense Bluetooth: powtórz. Sprawdź CRC (błędny raport nie może
    wyzwolić powrotu). Przy Steam Input sprawdź ostrzeżenie o izolacji Raw
    Input i fallback skrótu.
11. Skrót: zmień na `Ctrl+Shift+N` lub `Alt+Shift+N`, sprawdź rejestrację i
    powrót. Sprawdź `Ctrl+Alt+F12` jako awaryjne wyłączenie. Po restarcie
    aplikacji sprawdź, że wraca domyślny `Ctrl+Alt+N` (znane ograniczenie).
12. Eksport: kliknij „Eksportuj bezpieczny raport”, zapisz SHA-256 i sprawdź,
    że JSON nie zawiera ścieżek użytkownika, tokenów ani tytułów obcych okien.
13. Odłącz monitor HDMI i podłącz ponownie. Sprawdź zdarzenie zmiany
    wyświetlaczy; VELORA nie może zmienić rozdzielczości ani HDR.
14. Zapisz wynik każdego punktu, build SHA, model TV, tryb HDMI, model pada,
    firmware, tryb USB/BT i obecność Steam Input. Bez tego testy sprzętowe
    pozostają niezaliczone.

## 13. Bezpieczeństwo

- Brak nowych uprawnień sieciowych i brak wysyłki diagnostyki.
- Brak odczytu tytułów okien; przechowywane są HWND, PID, nazwa procesu i
  klasa okna dla jawnie śledzonych procesów.
- Brak surowych ścieżek urządzeń w IPC diagnostycznym.
- Brak sekretów parowania w snapshocie i eksporcie.
- Brak automatycznych zmian ustawień Windows.
- Brak hooków, DLL injection, `AttachThreadInput` i pętli fokusu.
- Brak sterowników i emulacji pada; Raw Input pozostaje pasywny.
- Zapis sesji jest lokalny, ograniczony do 64 KiB, wersjonowany i odrzuca
  uszkodzony plik.

## 14. Znane ograniczenia

- Zmiana skrótu powrotu nie jest trwała między uruchomieniami.
- Identyfikatory urządzeń DualSense są 64-bitowymi skrótami FNV-1a, nie
  kryptograficznymi; kolizja jest mało prawdopodobna, ale teoretycznie możliwa.
- HDR to stan advanced color Windows, nie certyfikacja telewizora.
- Sygnatura wyświetlaczy nie identyfikuje portu HDMI.
- Wykrywanie Steam Input jest heurystyczne.
- `SetForegroundWindow` zawsze zależy od polityki Windows.
- Gra uruchomiona poza drzewem procesów Steam może nie zostać wykryta.
- Brak weryfikacji sprzętowej do czasu testów MSI.
