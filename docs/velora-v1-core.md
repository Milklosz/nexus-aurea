# VELORA 1.0 RC — natywny rdzeń sesji, okien i Gamepad Home

Status: gałąź `feat/velora-v1-core`, Draft PR. Bez merge i bez release.
Bazuje na `fix/velora-deepseek-p1` (poprawki P1, Draft PR #14), a nie na
niezmodyfikowanym Night Buildzie. Dokument opisuje zakres, ograniczenia i
procedurę testów na MSI.

## 1. SessionOrchestrator

Rdzeń sesji jest w `src-tauri/src/session_orchestrator.rs`. Stan jest trzymany
pod mutexem, a każda zmiana ma jawny powód, numer rewizji i znacznik czasu.

Stany:

| Stan | Znaczenie |
| --- | --- |
| `veloraHome` | Ekran główny VELORA |
| `game` | Sesja gry lub Steam Big Picture |
| `playnite` | Sesja Playnite Fullscreen/Desktop |
| `cinema` | Profil Cinema |
| `desktop` | Profil Desktop / zminimalizowane VELORA |
| `ambient` | Ekran Ambient |

Dozwolone przejścia są jawną tabelą. `veloraHome` może wejść w każdy stan.
`game`, `playnite` i `cinema` mogą przekazywać sesję między sobą. `desktop` i
`ambient` wymagają najpierw powrotu do `veloraHome`. Przejście na ten sam stan
jest idempotentne i nie zwiększa rewizji, ale może odświeżyć kontekst
uruchomienia.

Polecenia:

- `get_session_state`
- `request_session_transition` z `target`, `cause`, opcjonalnym `context`
- `return_velora_home` — przejście do domu i próba przywrócenia okna VELORA
  przez WindowBroker

Zdarzenia:

- `velora-session-changed` — `from`, `to`, `cause`, `context`, `revision`
- `velora-session-error` — odrzucone przejście
- `velora-return-home` — wynik powrotu wraz z wynikiem przywrócenia okna

Błędy przejść nie zmieniają bieżącego stanu. Nieznane przejście zwraca
`InvalidTransition`, a niedostępny mutex — `InternalStateUnavailable`.

## 2. WindowBroker

`src-tauri/src/window_broker.rs` śledzi okna przez natywny HWND i API Win32:

- `GetForegroundWindow`, `GetWindowThreadProcessId`
- `EnumWindows`, `IsWindow`, `IsWindowVisible`, `GetWindowRect`
- `GetClassNameW`, `OpenProcess`, `QueryFullProcessImageNameW`
- `IsIconic`, `ShowWindowAsync`, `SetForegroundWindow`, `FlashWindowEx`

Broker nie czyta tytułów okien. Przechowuje tylko HWND, PID, nazwę procesu i
klasę okna dla procesów jawnie zarejestrowanych przez sesję uruchomienia oraz
dla VELORA. Wątek monitorujący odświeża stan co 500 ms i emituje
`velora-foreground-changed` tylko przy zmianie HWND.

Polityka przywracania:

- jawne żądanie użytkownika (PS + Options, Ctrl+Alt+N, przycisk Home) może
  poprosić o fokus niezależnie od aplikacji na pierwszym planie;
- automatyczne przywrócenie po zakończeniu sesji jest dozwolone tylko, gdy
  pierwszy plan należy do pulpitu Windows (`Progman`, `WorkerW`,
  `SHELLDLL_DefView`), Playnite, VELORA, albo nie ma aktywnego okna;
- każde inne okno, w tym nieznany proces, zachowuje fokus;
- wynik jest zawsze weryfikowany po `SetForegroundWindow`; przy odmowie
  Windows VELORA nie pętli prób i używa `FlashWindowEx` jako sygnału awaryjnego;
- wygasły HWND nie jest używany.

Nie użyto `AttachThreadInput`, hooków klawiatury, przechwytywania wejścia ani
wymuszania fokusu w pętli. TOCTOU między sprawdzeniem polityki a wywołaniem
Win32 nie jest w pełni atomowe; dlatego wynik jest raportowany, a nie udawany.

Polecenia: `get_window_broker_status`, `restore_velora_window`.
Zdarzenia: `velora-foreground-changed`, `velora-window-tracking-error`,
`velora-restore-result`.

## 3. Gamepad Home (DualSense)

`src-tauri/src/gamepad_home.rs` jest częścią Control Service. Po jawnym
uruchomieniu Control Service tworzy ukryte okno message-only i rejestruje
Raw Input dla Generic Desktop Game Pad/Joystick z `RIDEV_INPUTSINK` oraz
`RIDEV_DEVNOTIFY`. Odbiera wyłącznie raporty HID pada; nie rejestruje
klawiatury ani myszy i nie blokuje raportów wysyłanych do gry.

Obsługiwane raporty:

- USB `0x01`, 64 bajty — PS: bajt 10 bit 0, Options: bajt 9 bit 5
- Bluetooth pełny `0x31`, 78 bajtów — PS: bajt 11 bit 0, Options: bajt 10 bit 5,
  z walidacją CRC (seed `0xA1`)
- Bluetooth minimalny `0x01`, 10 bajtów — PS: bajt 7 bit 0, Options: bajt 6 bit 5

Urządzenie jest akceptowane tylko dla Sony VID `0x054C` i PID DualSense
`0x0CE6` lub DualSense Edge `0x0DF2`. Kombinacja PS + Options wymaga obu
przycisków w oknie 250 ms, wyzwala się raz i wymaga zwolnienia obu przed
kolejnym powrotem. Globalny cooldown wynosi 750 ms. Rozłączenie usuwa stan
urządzenia; ponowne połączenie zaczyna od czystego stanu.

Po wykryciu kombinacji wywoływany jest `return_velora_home` z powodem
`gamepadHome`. Jeśli Windows odmówi fokusu, zdarzenie zawiera wynik
`blockedByWindows` i komunikat o Alt+Tab. Ctrl+Alt+N pozostaje fallbackiem
klawiaturowym.

Ograniczenia:

- Steam Input, sterowniki producenta, aplikacje o wyższym poziomie integralności
  lub polityka Windows mogą ukryć fizyczny raport HID albo odebrać fokus;
- przycisk PS może być przechwytywany przez system lub oprogramowanie pada;
- nie ma gwarancji działania przy każdym wariancie sprzętowym i firmware;
- test fizyczny na MSI nie został wykonany — to nadal bramka akceptacyjna.

## 4. LaunchRegistry

`src-tauri/src/launch_registry.rs` ujednolica śledzenie Playnite, Steam,
Steam Big Picture, gier Steam i aplikacji zarządzanych. Fazy sesji:

`requested → processStarted → windowAppeared → sessionActive → exitPending → ended`

Dodatkowo `failed` po 60 s bez procesu. Powrót procesu w okresie 5 s łaski
przywraca sesję (ochrona przed chwilowym błędem odczytu lub restartem).
Playnite Fullscreen → Desktop jest przekazaniem trybu, nie końcem sesji.
Nowe uruchomienie w tej samej grupie zastępuje starszą sesję bez przywracania
fokusu.

Obserwacja używa migawki Toolhelp32 (PID, PID rodzica, nazwa obrazu), listy
okien z WindowBroker i pierwszego planu. Dla gier Steam śledzeni są nowi
potomkowie procesu Steam z pominięciem helperów (`steamwebhelper.exe`,
`gameoverlayui.exe`, `steamservice.exe`, `steamerrorreporter.exe`) oraz okien
istniejących przed uruchomieniem. Dzięki temu okno Steam Big Picture nie jest
liczone jako okno gry.

Polecenie: `get_launch_registry_status`; zdarzenia: `velora-launch-event`,
`velora-launch-error`. Zdarzenie zgodności `managed-app-exited` dla Playnite
jest nadal emitowane, aby istniejący interfejs nie utracił obsługi zamykania.

Ograniczenie: gra uruchomiona przez launcher pośredni, który nie jest
potomkiem `steam.exe`, może nie zostać skojarzona. To jest raportowane jako
brak okna/timeout, bez zgadywania i bez przejmowania fokusu.

## 5. Testy

Testy jednostkowe Rust obejmują:

- stany: start w `veloraHome`, wszystkie dozwolone przejścia, zabronione
  przejścia, idempotencję, rewizję, kontekst, serializację zdarzeń;
- fokus: pulpit, Playnite, VELORA, nieznane okno, obce aplikacje, wygasły
  HWND, wyścig zmiany pierwszego planu, odmowę Win32;
- Gamepad: USB/BT/minimalny, błędny CRC, nie-Sony, krótkie raporty, kolejność
  przycisków, okno 250 ms, cooldown, rozłączenie i ponowne połączenie;
- LaunchRegistry: proces, okno, aktywna sesja, exit grace, restart, timeout,
  handoff Playnite, baseline okien Steam, helpery, puste migawki.

Testy frontendowe obejmują most IPC sesji i powrotu do domu. Testy syntetyczne
nie dowodzą działania HWND, Raw Input, CRC na prawdziwym DualSense ani polityki
pierwszego planu Windows. To wymaga MSI.

Lokalnie: `pnpm test` (159 testów), `pnpm build`, `cargo test --lib` (62
testy) i `cargo check`. Windows/MSVC CI jest wymagane dla surowych deklaracji
Win32; lokalny macOS nie kompiluje gałęzi `cfg(windows)`.

## 6. Testy na MSI

1. Zainstaluj wyłącznie zweryfikowany artefakt Windows x64 z Actions. Nie
   wyłączaj SmartScreen/Defender.
2. Uruchom VELORA. Sprawdź wersję i brak dekoracji okna.
3. Otwórz diagnostykę pada i włącz Control Service. Sprawdź:
   - status `DualSense Home` i liczbę urządzeń;
   - połączenie USB: PS + Options w ciągu 250 ms wraca do VELORA;
   - to samo przez Bluetooth; po rozłączeniu i ponownym połączeniu kombinacja
     działa, ale nie powtarza się bez zwolnienia przycisków;
   - przytrzymanie Options przed naciśnięciem PS nie wyzwala powrotu;
   - przy aktywnym Steam Input sprawdź, czy raporty są widoczne; jeśli nie,
     potwierdź fallback Ctrl+Alt+N i zapisz to jako ograniczenie.
4. Uruchom grę/Steam Big Picture, sprawdź fazy `processStarted`,
   `windowAppeared`, `sessionActive`. Po zamknięciu sprawdź exit grace.
5. Uruchom Playnite Fullscreen z VELORA, przełącz Fullscreen → Desktop i
   zamknij Playnite. Sprawdź, że VELORA wraca tylko wtedy, gdy nie ma na
   pierwszym planie obcej aplikacji. Otwórz Chrome/File Explorer i zamknij
   Playnite — fokus nie może zostać przejęty.
6. Przełącz profile Cinema/Gaming/Desktop i sprawdź stan sesji w diagnostyce.
7. Sprawdź, że PS + Options nie wysyła żadnych komend do gry poza powrotem
   VELORA i nie blokuje inputu.
8. Zapisz build SHA, wersję pada, tryb USB/BT, firmware, zachowanie Steam Input
   i wynik każdego punktu. Bez tego testy sprzętowe pozostają niezaliczone.

## 7. Poza zakresem i ryzyka

- Brak merge, release, podpisywania instalatora i zmian PR #13.
- Brak sterowników, emulatorów pada, hooków, przechwytywania inputu gry,
  obejść DRM/anti-cheat i zmian Edge Cinema/autostartu/biblioteki UI.
- Sesja Cinema/Desktop/Ambient jest synchronizowana z istniejącym interfejsem,
  ale ekran Ambient nadal jest lokalnym overlayerem; pełne źródło prawdy dla
  każdego piksela UI to kolejny krok.
- Zachowanie `SetForegroundWindow` zależy od polityki Windows i integralności
  procesów. Wynik odmowy jest jawny, nie maskowany.
- Gra uruchomiona poza drzewem procesów Steam może nie zostać wykryta.
- Fizyczny DualSense, MSI, Panasonic i Steam Input pozostają do walidacji.
