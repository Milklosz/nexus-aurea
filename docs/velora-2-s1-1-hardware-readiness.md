# VELORA S1.1 — gotowość do pierwszych testów sprzętowych

Stan: kandydat do testów, bez potwierdzenia fizycznego DS4/MSI. Niczego nie zainstalowano.

## Stan początkowy (2026-11-15)

Worktree C:/Users/milos/velora-s1-1-sprint, gałąź integration/velora-2-s1-1-sprint,
HEAD 978501a, merge 8d1fc3e. Brak zmian śledzonych i operacji merge/rebase/cherry-pick.
Nieśledzony target-int zawiera istniejący cache Cargo; pozostawiono go bez zmian.
Remote origin: Milklosz/nexus-aurea. S0.1 1df1736 i S1 d816266 są w historii merge.

## Sześć ustaleń

- A1: ostrzeżenie „Nie omijaj ostrzeżeń TLS w Safari” jest w obu wariantach Control Center, również przy uszkodzonym magazynie i initialPanel=remote. Test obu wariantów.
- A2: RIDI_DEVICEINFO VID/PID identyfikuje DualSense 054c:0ce6 i Edge 054c:0df2. Fallback rozpoznaje całe pola USB oraz Bluetooth VID&0002054c_PID&0ce6. Ujemne metadane Windows mają pierwszeństwo przed ścieżką. DS4 nie jest uznawany za DualSense.
- A3: deadzone 0.18 / 0.12 z histerezą przed kwantyzacją 1/16. Tylko analog jest koaleskowany na urządzenie do 16 ms, tick dostarcza ostatnią próbkę. Przyciski, D-pad i powrót analogu do zera są natychmiastowe.
- A4: sync_channel(64), try_send, tylko zidentyfikowany DualSense, maks. 256 raportów po 128 bajtów na wiadomość. Pełna kolejka zwiększa droppedRawReports i epokę, unieważnia stare raporty. Przed ponownym akordem wymagany neutralny raport każdego urządzenia; cooldown jest zachowany. Praca pompy i drain ograniczona na obrót, shutdown/panika odłączają subskrypcję.
- A5: mapowanie Gamepad API PlayStation pozostawiono. Natywny DS4 używa semantycznych Cross/Circle. Natywny DualSense obsługuje akord Home; nawigacja DualSense pozostaje w Gamepad API. Steam Input może udostępnić osobny wirtualny XInput.
- A6: aktywność natywna jest notowana synchronicznie w subskrybencie, przed kolejnym tickiem. Priorytet zapamiętywany per akcja i kierunek przez 400 ms, obejmuje Options i PS+Options oraz opóźniony release. Inne akcje niezależnego pada pozostają dostępne.

## Dodatkowe rozszerzenie bezpieczeństwa anti-replay

Pełny test wykrył podwójne zaakceptowanie sekwencji. Użytkownik zatwierdził trwały checkpoint rewizji/skrótu indeksu, migrację i recovery. Szczegóły i granice gwarancji: [replay checkpoint](velora-2-s1-1-replay-checkpoint.md). Pierwszy test LAN musi także obejmować ponowne uruchomienie VELORY po przerwanym zapisie i jawne recovery.

## Integracja i niezależny przegląd

Zachowano Credential Manager, recovery, provenance, host/origin/HMAC pilota, listę capability/CSP,
allowlistę launcherów i politykę powrotu Home. Osobny agent przejrzał te granice i zmiany.
Znalezione P2: opóźniony Options, blokowanie innych akcji niezależnego pada, ponowne uzbrojenie
akordu po overflow. Wszystkie poprawiono, dodano regresje. Poprawiono też cleanup przy panice.
Przegląd nie zastępuje testów urządzeń ani audytu każdej linii istniejącego kodu.

## Plan pierwszego testu MSI (kolejność)

1. Uruchomić kandydat z gałęzi PR w trybie developerskim na MSI GP76; zapisać SHA i stan CI. Nie instalować wydania stabilnego. Pilot LAN początkowo wyłączony.
2. Podłączyć Panasonic TX-49EX610E przez HDMI. Sprawdzić 1080p/4K, skalowanie, overscan, audio HDMI, czytelność focusu, zegara, pogody i docka. Nie zakładać HDR.
3. DS4 USB, Steam zamknięty: sprawdzić diagnostyczne rozpoznanie rewizji/transportu, Cross=wybór, Circle=Wstecz, D-pad i analog (szum, skos, szybki ruch, neutralny), L1/R1, Options raz po release.
4. Przytrzymać PS+Options, zwolnić osobno przyciski, powtórzyć. Oczekiwać jednego Home bez otwarcia Control Center. Sprawdzić odłączenie, reconnect i ciszę BT >3 s.
5. Powtórzyć pkt 3–4 przez Bluetooth; zweryfikować rzeczywiste kształty raportów, CRC i VID/PID. Nie traktować fixture HID jako potwierdzenia urządzenia.
6. Steam uruchomiony: przetestować osobno aktywny Steam Input i lokalną konfigurację użytkownika. Po jednym Cross/Circle/Options i PS+Options nie może być dwóch akcji. Nie zmieniać globalnych ustawień Steam. W diagnostyce zapisać oba źródła.
7. Podłączyć niezależny drugi kontroler. Przy trzymanym kierunku DS4 jego inne przyciski/kierunki muszą działać. Windows nie ujawnia parowania fizyczny/wirtualny: identyczna akcja drugiego pada w oknie 400 ms pozostaje nierozróżnialna i wymaga testu/obserwacji.
8. Natywny DualSense USB/BT (jeśli dostępny): zweryfikować akord; nawigację i Cross/Circle sprawdzić osobno przez standardowy oraz raw profil Gamepad API. Nie zmieniać mapowania bez pomiaru.
9. Uruchomić kolejno Netflix, Disney+, Max, Prime Video, YouTube oraz Steam/Playnite, gdy zainstalowane. Sprawdzić wykrywanie foreground, blokadę nawigacji Home w zewnętrznym oknie, powrót Home po wyjściu i jawne żądanie powrotu.
10. Zweryfikować Apple Music i brak niezamierzonego przejęcia focusu po aktualizacji statusu. Na iPhonie sparować LAN tylko po prawidłowym zaufaniu certyfikatu; nie omijać ostrzeżeń TLS. Sprawdzić recovery i odwołanie urządzenia.
11. W Cinema Minimal sprawdzić wejście kontrolerem do Claude Usage, rozwinięcie, ręczne odświeżenie, Circle i powrót focusu; niedostępność źródła ma pozostać jawna.

## Ograniczenia Windows i ryzyka

Steam może przechwycić PS i generować klawisze Desktop Configuration; VELORA tego globalnie nie zmienia.
Windows może odmówić SetForegroundWindow; zachowano politykę brokera i brak hooków/wstrzykiwania.
Bluetooth, WebView2 foreground, TV i wszystkie usługi streamingowe wymagają fizycznej weryfikacji.
Licznik droppedRawReports oznacza utratę wiadomości kolejki, nie potwierdzonych naciśnięć Home.

## Weryfikacja

Wyniki końcowe i ograniczenia środowiska są w docs/velora-2-sprint-verification.md.
