# VELORA 2.0 · S1 · DualShock 4: zachowanie, ograniczenia, ownership fokusu

> **NOT TESTED ON HARDWARE.** Wszystko poniżej jest sprawdzone testami jednostkowymi i symulacją (zdarzenia syntetyczne). Żadne z twierdzeń o fizycznym DualShock 4, USB, Bluetooth, Steam Input ani HDMI nie zostało potwierdzone na MSI. Plan testów: [`velora-2-s1-ds4-hardware-test-plan.md`](velora-2-s1-ds4-hardware-test-plan.md). Decyzja architektoniczna: [`velora-2-s1-ds4-adr.md`](velora-2-s1-ds4-adr.md).

## 1. Przepływ danych

```
DualShock 4 ──(HID)──► Windows Raw Input ──► pad_hub (jeden wątek, jedna rejestracja)
                                               │
                    ┌──────────────────────────┤
                    │ DS4 (PID 05C4/09CC/0BA0) │ inne urządzenia (np. DualSense)
                    ▼                          ▼
              ds4.rs: parser + tracker     kanał mpsc ► GamepadHomeRuntime
              ▼                            (tylko gdy działa Control Service)
   zdarzenia `velora-controller`           akord PS+Options → powrót do Home
   (semantyczne, bez bajtów i ścieżek)
              ▼
   nativeControllerStore (jeden listener) ► useNativeController ► ControllerEngine
              ▼
   useFocusOwner (jeden właściciel, bramka) ► intenty ► DOM
```

- Rust **nie zapisuje nic do pada** i nie otwiera uchwytu urządzenia. Nie wysyła raportów feature ani wyjściowych, więc nie przełącza trybu raportów (USB / BT podstawowy / BT pełny).
- Zdarzenia stanu są wysyłane **tylko gdy okno VELORA jest na wierzchu** (gra działająca z padem nie zalewa IPC). Po odzyskaniu fokusu frontend dostaje bieżący stan. Zdarzenia połączenia (rzadkie) są zawsze wysyłane.
- Trzymane wejście jest odświeżane **heartbeatem co 250 ms**; frontend uznaje ciszę dłuższą niż 700 ms za zwolnienie.
- Pad, który **przestał nadawać** w trakcie trzymania (np. zerwane łącze BT), dostaje po 750 ms **jednorazowy neutralny stan** i nie jest już „heartbeatowany"; pad bez raportów przez 3 s jest uznawany za utracony (Windows nie zawsze zgłasza odłączenie BT). Założenie: DS4 nadaje raporty w sposób ciągły także przy niezmienionym stanie (licznik w raporcie rośnie) **[NIEZWERYFIKOWANE, zwłaszcza w trybie BT podstawowym]**. Gdyby pad nadawał tylko przy zmianie, trzymany przycisk przestałby powtarzać po 750 ms. Test sprzętowy #3 to rozstrzygnie.
- Adapter USB Sony bez sparowanego pada nie jest padem (flaga „brak kontrolera" w bajcie 31, bit 0x04, wg sterownika Linux **[NIEZWERYFIKOWANE]**).

## 2. Mapowanie (domyślne, semantyczne)

| Wejście DS4 | Funkcja | Uwagi |
|---|---|---|
| D-pad lewo/prawo | ruch w doku (lub w rzędzie górnych akcji) | debounce 40 ms, powtarzanie 420/135 ms |
| D-pad góra/dół | zmiana strefy Home; w dialogu ruch między kontrolkami | |
| Lewy analog | jak D-pad, z histerezą 0,55 / 0,35 | **oś dominująca** na przekątnej, zablokowana do puszczenia drążka |
| Cross (✕) | potwierdź / uruchom | |
| Circle (◯) | wstecz / zamknij panel | |
| Options | Control Center | **na zwolnieniu**, i **wcale**, gdy PS był wciśnięty w trakcie |
| L1 / R1 | poprzednia / następna sekcja Control Center | tylko gdy Control Center jest otwarty; nic poza tym |
| Share | brak akcji | VELORA go nie przechwytuje; Steam/Windows mogą zareagować |
| PS solo | brak akcji | zob. §4 |
| PS + Options | powrót do VELORA (Home) | akord globalny, wymaga działającego Control Service |
| Square, Triangle, L2, R2, L3, R3, Touchpad | brak akcji | świadomie nie mapowane „na siłę" |

Przyciski są identyfikowane **nazwą** (`cross`, `circle`, …), nie indeksem. Tabela `ControllerBindings` (`nativeController.ts`) przypisuje nazwy do trzech akcji nawigacji i może w przyszłości pochodzić z ustawień bez dotykania parserów.

## 3. Ownership fokusu

W danej chwili **dokładnie jeden właściciel** interpretuje wejście nawigacyjne (`focusOwnership.ts`, `useFocusOwner`). Kolejność, pierwszy pasujący wygrywa:

| # | Właściciel | Kiedy |
|---|---|---|
| 1 | `external` | VELORA nie jest oknem na wierzchu (Netflix, YouTube, Steam, Playnite, gra, przeglądarka): **wejście nie jest interpretowane** |
| 2 | `ambient` | ekran Ambient (nawigacja wyciszona; wejście natywne **resetuje licznik bezczynności i budzi** Ambient, bez zależności od Gamepad API) |
| 3 | `keyboard` | klawiatura ekranowa (zabiera każdy intent, także Options) |
| 4 | `diagnostics` | ekran diagnostyki |
| 5 | `search` / `control-center` | Control Center (Szukaj to jego zakładka) |
| 6 | `home-actions` | fokus w górnych akcjach Home |
| 7 | `home-dock` | dok |

Zasady:

- **Jedno źródło:** gdy natywna warstwa ma pada DS4, Gamepad API pomija ten pad (`isDualShock4GamepadId`); inne pady (Xbox, DualSense) zostają na Gamepad API; bez natywnej warstwy DS4 wraca do Gamepad API.
- **Priorytet natywny (bramka `CrossSourceGate`):** dopóki natywny pad trzyma jakieś wejście (i 400 ms po nim), akcje z Gamepad API są odrzucane. Chroni to przed **wirtualnym padem** utworzonym z tego samego DS4 (DS4Windows/ViGEm, wirtualny XInput Steam), którego id nie da się odróżnić od prawdziwego Xboxa. Skutek uboczny: prawdziwy drugi pad (Xbox) jest ignorowany przez ułamek sekundy po ruchu DS4. Dodatkowo ta sama akcja z drugiego źródła w ciągu 90 ms jest odrzucana (okno przekazania).
- **Potwierdzenie w szczelinie przekazania:** `confirm` w ciągu 180 ms od zmiany warstwy (zamknięcie panelu, powrót fokusu z aplikacji zewnętrznej) jest połykany. Zapobiega to uruchomieniu aplikacji z doku, gdy użytkownik chciał tylko zamknąć panel. Ruch i wstecz nie są opóźniane. Przejście dok ↔ górne akcje to zwykła nawigacja, nie przekazanie.
- **Powrót do otwierającego:** przy otwarciu panelu (Options, F3, Szukaj/Pilot/Ustawienia, F2, przycisk diagnostyki) zapamiętywany jest element Home z fokusem, o ile nie jest dokiem; zamknięcie przywraca fokus tam, jeśli element nadal istnieje, nie jest wyłączony i faktycznie przyjął fokus, inaczej do wybranego kafla doku. Przeskok Control Center → Diagnostyka zachowuje pierwotnego otwierającego.
- **Po powrocie z aplikacji zewnętrznej** zachowana jest ostatnio wybrana pozycja doku (istniejący mechanizm `activeServiceRef` / `useReturnHomeListener`).
- **Brak sterowania ukrytym interfejsem:** w `external` i `ambient` handlery nie są wołane.
- **Listenery:** jedna subskrypcja Tauri na proces (licznik referencji w `NativeControllerStore`), niezależnie od liczby ekranów/rerenderów; zwalniana, gdy znika ostatni konsument; opóźnione `unlisten` po wyścigu mount/unmount jest obsłużone.

## 4. Przycisk PS: co jest realne

Windows **dostarcza** raport HID z PS także do aplikacji w tle (Raw Input `INPUTSINK`), więc *wykrycie* jest możliwe niezależnie od fokusu, o ile nic innego nie zajęło pada na wyłączność. **Aktywacja okna** to osobna sprawa i podlega regułom Windows:

`SetForegroundWindow` powiedzie się tylko, gdy proces jest już na wierzchu, został uruchomiony przez proces na wierzchu, dostał ostatnie zdarzenie wejścia, nie ma okna na wierzchu lub minął limit blokady. Wejście z pada HID **nie** liczy się jako „ostatnie zdarzenie wejścia". [WIEDZA]

| Scenariusz | Co robi dziś VELORA (kod `window_broker.rs`) | Czego **nie** obiecujemy |
|---|---|---|
| 1. VELORA ma fokus | akord → `AlreadyFocused`; fokus zostaje (PS solo bez akcji) | — |
| 2. Aplikacja streamingowa uruchomiona przez VELORĘ | polityka `DeviceRequest` pozwala (proces śledzony); jedna próba `SetForegroundWindow`, weryfikacja 5×20 ms | skuteczności przy każdym naciśnięciu |
| 3. Przeglądarka / aplikacja nieuruchomiona przez VELORĘ | polityka **blokuje** (`BlockedUnsafeForeground`); migotanie paska zadań + toast; działa skrót awaryjny z Control Service | jakiejkolwiek zmiany fokusu |
| 4. Steam / Big Picture | dozwolone, jeśli śledzony; Steam może sam zareagować na PS | wygrania wyścigu o fokus ze Steamem |
| 5. Gra (borderless / pełny ekran wyłączny) | dozwolone, jeśli śledzona; best effort | aktywacji; pełny ekran wyłączny może minimalizować/migać |
| 6. Steam Input lub inny program zajmuje pada | surowy HID zwykle nadal dociera [NIEZWERYFIKOWANE]; pad przełączony na raport 0x11 obsługuje parser natywny | nic, co wymaga HidHide / DS4Windows „hide" |

**Decyzja:** dla DS4 obowiązuje ten sam akord **PS+Options** co dla DualSense (okno 250 ms, zatrzask do puszczenia obu, cooldown 750 ms). Samotny PS nie ma domyślnej akcji, bo koliduje z PS w Steam/Big Picture i systemie. Share+Options jest udokumentowaną alternatywą, **tylko jeśli** test sprzętowy potwierdzi kolizję ze Steam.

**Nie stosujemy:** globalnych hooków, wstrzykiwania kodu, wstrzykiwania Alt, `AttachThreadInput`, minimalizowania/przywracania jako triku, ingerencji w procesy chronione, wyłączania Steam Input.

## 5. Powrót do VELORY: trzy różne operacje

| Operacja | Co robi | Zabija proces? |
|---|---|---|
| **Powrót fokusu** (w obrębie VELORY) | zamyka panele, ustawia fokus w doku/otwierającym | nie dotyczy |
| **Przywrócenie okna VELORA** | `return_velora_home` → `window_broker` (jedna próba, weryfikacja, fallback FlashWindowEx) | **nie** |
| **Zamknięcie aplikacji zewnętrznej** | osobna, jawna akcja (istniejący przepływ potwierdzenia zamknięcia); nie jest częścią powrotu | tylko na wyraźne polecenie |

Domyślny powrót **nigdy** nie zabija gry, Steam ani przeglądarki i **nie** używa Alt+F4. Scenariusze (Home↔Control Center, wyszukiwarka→Home, Netflix/YouTube/Steam/Playnite→VELORA) są pokryte przez istniejący model sesji; ograniczenia aktywacji z §4 dotyczą ostatnich czterech.

## 6. Steam Input

VELORA **nie** wyłącza Steam Input, **nie** czyta ani nie zmienia konfiguracji Steam, **nie** otwiera uchwytu HID i nie wysyła raportów do pada. Znane ryzyka (wszystkie **[NIEZWERYFIKOWANE]**, w planie testów):

- podwójne zdarzenia, jeśli Steam Desktop Configuration zamienia pad w klawisze (strzałki/Enter/Escape) — klawiatura VELORY reaguje obok pada; `Escape` bez otwartego dialogu wychodzi z pełnego ekranu;
- wirtualny pad XInput Steam / DS4Windows / ViGEm obok fizycznego DS4 (dwa pady: natywny odczyt czyta surowy DS4, a Gamepad API widzi wirtualnego Xboxa). Chronią przed tym tylko **priorytet natywny 400 ms** i okno 90 ms bramki; skuteczność zależy od opóźnienia wirtualnego pada **[NIEZWERYFIKOWANE]**;
- przełączenie BT DS4 na raport 0x11 przez Steam/DS4Windows (Gamepad API może „oślepnąć", natywna warstwa obsługuje 0x11);
- PS otwierający Big Picture.

Jeśli test sprzętowy potwierdzi problem, zalecenie dla użytkownika (tylko tekst, bez zmian automatycznych): w Steam użyć konfiguracji per aplikacja albo wyłączyć „PlayStation Configuration Support" dla gier, nie globalnie, i dla VELORY zostawić pad bez Desktop Configuration.

## 7. Diagnostyka

Ekran diagnostyki (F2 / przycisk „Diagnostyka pada" / przycisk w Control Center) ma sekcję **Kontroler natywny**: stan (`brak kontrolera` / `połączony` / `aktywny` / `natywny odczyt niedostępny`), typ (v1/v2/adapter), połączenie USB/Bluetooth, aktywne źródło wejścia, ostatni przycisk, bieżący właściciel fokusu i cel powrotu. Pokazuje **wyłącznie** dane zgłoszone przez warstwę natywną lub przeglądarkę. Nie wyświetla ani nie zapisuje bajtów HID, ścieżek urządzeń ani numerów seryjnych; urządzenie to nieprzejrzysta etykieta: **niesolony** skrót FNV-1a ścieżki urządzenia (stabilny między sesjami dla tego samego portu/parowania, więc to nie jest etykieta „per sesja"), żyjący tylko w pamięci i nigdzie niewyświetlany. Nic nie jest zapisywane w logach trwałych.

## 8. Znane ograniczenia i problemy poza zakresem S1

1. **Wszystko NOT TESTED ON HARDWARE.** Układ raportów, dopełnianie raportów BT przez Raw Input, rozróżnienie USB/BT po ścieżce i zachowanie po uśpieniu są oparte na dokumentacji, nie na pomiarze.
2. **DualSense BT (istniejący kod, nie naprawiony):** `is_dualsense_device_path` wymaga `vid_054c`/`pid_0ce6`, a ścieżka BT ma postać `…VID&0002054c_PID&0ce6…`; akord DualSense po Bluetooth prawdopodobnie nigdy nie zadziała. USB jest wykrywane po podłańcuchu „usb", co dla ścieżek HID może dać `Unknown` (tylko diagnostyka). DS4 używa identyfikacji przez `RIDI_DEVICEINFO`.
3. **Surowy profil PlayStation (Gamepad API):** kod mapuje confirm/back na indeksy 0/1, a etykiety diagnostyki mówią ✕=B1, ◯=B2. Rozbieżność istniała przed S1; Chromium mapuje DS4 jako `standard`, więc dotyczy tylko wymuszonego profilu „PlayStation (surowe)".
4. **Ambient:** gdy aktywny jest ekran Ambient, natywny odczyt jest wyłączony; budzenie pada działa przez istniejące Gamepad API.
5. **Klawisze syntetyczne Steam** (F12 w przeglądzie): nie ma „pad echo guard"; do rozstrzygnięcia po teście.
6. **Podwójne obsłużenie F2 / Escape w dialogu** (klawiatura): idempotentne dziś; poza zakresem.
7. **Fokus po powrocie** ma kilku piszących (`useReturnHomeListener`, rAF przywracania, `focus` okna). Nie zmieniono; ownership zmniejsza ryzyko, nie eliminuje go.
8. Fałszywe ostrzeżenie „Steam Input" dla użytkownika samego DS4 zostało usunięte przez doliczenie padów DS4 huba do licznika urządzeń surowych.
9. **Zmiany dla innych padów na ścieżce Gamepad API:** reguła osi dominującej drążka (przekątna = jedna oś) oraz połykanie `confirm` przez 180 ms po zmianie warstwy dotyczą także Xboxa/DualSense. Zamierzone, ale to zmiana zachowania istniejącej ścieżki.
10. **Popup WebView2** (np. rozwijana lista `<select>`, jeśli kiedyś się pojawi): Rust uznaje okno za „na wierzchu" po procesie, a frontend po `document.hasFocus()`; przy ich rozbieżności natywny pad nie steruje popupem.
11. **Częstość zdarzeń:** stan drążka jest kwantyzowany do 1/16 i wysyłany przy każdej zmianie, bez limitu częstotliwości; przy wolnym ruchu drążkiem możliwy jest strumień rzędu setek zdarzeń/s przez IPC (**[NIEZWERYFIKOWANE]**, do obserwacji w teście #3a). Ewentualne rozwiązanie: koalescencja 60–120 Hz.
12. **Akord DS4 przy zajętej kolejce powrotu** jest cicho pomijany (DualSense zapisuje to w `last_error`); kolejne naciśnięcie ponawia.
13. **Wygaszanie pada po ciszy:** jeśli pad w trybie BT podstawowym nadaje tylko przy zmianie stanu, pad bezczynny migałby między „połączony" a „brak" co ~3 s, a pierwsze naciśnięcie po bezczynności mogłoby zostać połknięte albo zdublowane (ochrona: bramka 90 ms). **[NIEZWERYFIKOWANE]**, test sprzętowy #2/#11.
