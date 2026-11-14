# ADR-S1-001: Natywne wejście DualShock 4 w VELORA 2.0

**Status:** zaimplementowane (Draft PR), **NOT TESTED ON HARDWARE**.
**Sprint:** S1 · **Gałąź:** `feature/velora-2-s1-native-ds4`
**Autorzy:** inżynier S1 (Claude Sonnet) + niezależny przegląd architektury (Claude Opus, effort high, tylko odczyt).

Znaczniki dowodów: **[KOD]** sprawdzone w repozytorium, **[WIEDZA]** znane z dokumentacji platformy/protokołu, nieweryfikowane w tym repo, **[NIEZWERYFIKOWANE]** wymaga testu na sprzęcie.

## 1. Kontekst i stan wyjściowy

- Frontend czytał pada wyłącznie przez przeglądarkowe Gamepad API (`useGamepad` → `ControllerEngine` → `navIntent`). [KOD]
- Rust miał już osobny odbiornik Raw Input dla **DualSense** (PS5) wykrywający akord PS+Options i wołający powrót do Home (`gamepad_home.rs`). Działał tylko wtedy, gdy działał Control Service. DualShock 4 był z niego świadomie wykluczony. [KOD]
- **Ograniczenie Win32:** `RegisterRawInputDevices` pozwala na jedno okno docelowe na kolekcję użytkowania (usage page/usage) w procesie; druga rejestracja tej samej kolekcji zastępuje pierwszą, a `RIDEV_REMOVE` usuwa ją dla całego procesu. [WIEDZA] Drugi, niezależny odbiornik DS4 po cichu zepsułby akord DualSense (i odwrotnie).

## 2. Rozważane opcje

| Opcja | Stabilność | DS4 USB / BT | Koszt utrzymania | Bezpieczeństwo | Zależności | Ryzyko podwójnego wejścia | Werdykt |
|---|---|---|---|---|---|---|---|
| (a) Tylko Gamepad API | dobra w fokusie; rAF dławiony w tle | USB tak; BT w trybie podstawowym tak. Po przełączeniu pada na raport 0x11 (Steam, DS4Windows) parsery HID-usage mogą ślepnąć do ponownego połączenia [NIEZWERYFIKOWANE dla Chromium] | najniższy (istnieje) | piaskownica | brak | średnie (wirtualny pad Steam, klawisze syntetyczne) | **fallback** i ścieżka dla padów nie-Sony |
| **(b) Raw Input (WM_INPUT) + własny parser raportów** | dobra; tylko odczyt, bez uchwytu urządzenia, `INPUTSINK` działa w tle | wszystkie trzy kształty raportów | niski/średni | brak zapisu do pada; parsowanie niezaufanych bajtów defensywne | tylko user32 | niskie przy jednym arbitrze | **wybrane** |
| (c) Bezpośredni HID (CreateFile/ReadFile, hidapi) | średnia: I/O overlapped + powiadomienia PnP | pełne; można wymusić BT 0x01→0x11 przez `HidD_GetFeature`, co jest trwałe i oślepia innych | wysoki | otwiera uchwyt, pokusa zapisu | nowe cechy `windows` | niskie | odrzucone: inwazyjne, duplikuje (b) |
| (d) Windows.Gaming.Input RawGameController | średnia | tylko surowe indeksy; BT 0x11 prawdopodobnie niewidoczny [NIEZWERYFIKOWANE] | średni (WinRT) | OK | cecha `Gaming_Input` | średnie | odrzucone |
| (e) GameInput | nieznana dla DS4 [NIEZWERYFIKOWANE] | [NIEZWERYFIKOWANE] | wysoki (ręczne FFI) | OK | redystrybucja GameInput | średnie | odrzucone |
| (f) XInput / DirectInput | XInput nie widzi DS4 bez ViGEm/DS4Windows | DInput: ta sama ślepota 0x11 | średni | OK | XInput wymaga sterownika | średnie | odrzucone |
| (g) hidapi / gilrs | hidapi = model (c); gilrs = WGI/XInput | jak (c)/(d) | zewnętrzny cykl wydań | łańcuch dostaw: hidapi buduje C przez `cc`, gilrs dodaje bazę SDL i możliwe drugie `windows` | nowe crate'y | średnie | odrzucone; **zero nowych zależności w S1** |

## 3. Decyzja

Rozszerzyć istniejące podejście **Raw Input** do jednego procesowego właściciela odbiornika (`pad_hub.rs`) z własnym wątkiem i czasem życia równym czasowi życia aplikacji.

- `pad_hub` jest **jedynym** wywołującym `RegisterRawInputDevices` (kolekcje 0x01/0x04 i 0x01/0x05) i jedynym, który robi `RIDEV_REMOVE` (przy zamknięciu aplikacji).
- **DualShock 4** (Sony PID 05C4, 09CC, 0BA0): dekodowany w `ds4.rs`, wysyłany do frontendu jako semantyczne zdarzenia `velora-controller`; akord PS+Options obsługiwany w Rust przez ten sam `ComboTracker` co DualSense, uzbrojony tylko gdy działa Control Service.
- **Pozostałe urządzenia (w tym DualSense):** raporty przekazywane bez zmian kanałem `mpsc` do `GamepadHomeRuntime`, dopóki Control Service działa. Start/stop Control Service nie dotyka rejestracji Raw Input.
- Powtarzanie, martwa strefa i debounce **zostają w TypeScript** (`ControllerEngine`), karmione semantycznym stanem. Jedna przetestowana implementacja dla obu źródeł; bramki UI (fokus, dialog, klawiatura) żyją w TS; strumień stanu toleruje gubienie zdarzeń, czego nie zrobiłyby zdarzenia „powtórz" z Rust.
- Gamepad API zostaje jako **fallback** i ścieżka dla padów, których natywna warstwa nie obsługuje (Xbox, DualSense).
- Brak nowych crate'ów, brak sterowników, brak zapisów do pada (żadnych raportów wyjściowych ani feature, więc VELORA nigdy nie przełącza trybu raportów USB/BT).

### Odstępstwa od rekomendacji przeglądu Opusa

| Rekomendacja Opusa | Co zrobiono | Dlaczego |
|---|---|---|
| Akord DualSense przeniesiony do wątku huba, Control Service tylko przełącza `chord_enabled` | DualSense nadal działa w wątku Control Service, raporty dostaje przez kanał; flaga `chord_enabled` dotyczy tylko DS4 | Mniejszy zakres zmian w 1,9 tys. wierszy przetestowanego kodu; zachowuje dotychczasową semantykę „akord działa, gdy działa usługa". Opóźnienie akordu DualSense ≤ pętla 40 ms usługi (jak dotąd). |
| Publisher ≤120 Hz z koalescencją | Zmiana-tylko + kwantyzacja drążka do 1/16 + heartbeat 250 ms | Kwantyzacja eliminuje szum czujnika bez timera; heartbeat chroni przed utraconym zwolnieniem. |
| Klasyfikacja po `RIDI_DEVICEINFO` | Tak, z fallbackiem na parser ścieżki (VID/PID także w postaci BT `VID&0002054c_PID&05c4`) | Zgodnie z zaleceniem; fallback na wypadek błędu zapytania. |
| Poprawka indeksów Cross/Circle w surowym profilu PlayStation (F8) | **Nie zmieniono** | Wcześniejszy commit `1781e6a` świadomie ustawił Cross=0/Circle=1 dla surowego profilu. Chromium mapuje DS4 jako `standard`, więc ścieżka DS4 jej nie dotyka. Rozbieżność z etykietami diagnostyki zapisana jako znany problem. |
| Priorytet natywny nad Gamepad API (drugi audyt, M2) | Dodany w `CrossSourceGate` (400 ms) | Wirtualny pad z tego samego DS4 nie jest odróżnialny po id od prawdziwego Xboxa. |
| Wzmocnienie przeciw klawiszom syntetycznym Steam (F12, „pad echo") | **Nie zaimplementowano** | Wymaga potwierdzenia na sprzęcie, czy Steam w ogóle zamienia pad w klawisze. Ujęte w planie testów. |

## 4. Fakty o DualShock 4 użyte w parserze

Źródło: publiczna dokumentacja sterownika Linux `hid-playstation` i PS Dev Wiki. **[WIEDZA], nie weryfikowane na sprzęcie.**

- VID `054C`; PID `05C4` (v1), `09CC` (v2), `0BA0` (adapter USB Sony). DualSense `0CE6`/`0DF2` jest odrzucany.
- **USB, raport 0x01, 64 B:** blok wspólny od bajtu 1: `LX LY RX RY | hat(nibble niski)+Square 0x10/Cross 0x20/Circle 0x40/Triangle 0x80 | L1 0x01 R1 0x02 L2 0x04 R2 0x08 Share 0x10 Options 0x20 L3 0x40 R3 0x80 | PS 0x01, Touchpad 0x02, licznik | L2 R2 analogowe`.
- **BT podstawowy, 0x01, 10 B:** ten sam blok od bajtu 1. **BT pełny, 0x11, 78 B:** blok od bajtu 3; CRC-32 LE w bajtach 74..78 liczone po `0xA1` + bajty 0..74.
- Hat: 0=N … 7=NW, 8 i wyższe = puszczony.
- Parser przyjmuje długości jako **minima** (Raw Input może dopełniać krótkie raporty BT; [NIEZWERYFIKOWANE]); CRC zawsze na offsecie protokołu. Rodzaj łącza = kształt raportu + wskazówka ze ścieżki (`bthenum`, `{00001124-…}`, `vid&0002…`); adapter USB Sony raportuje się jako USB.
- Odczyt **nie przełącza trybu raportów**. Przełącza go dopiero odczyt feature 0x02/0x05 lub raport wyjściowy 0x11 (Steam, DS4Windows); przełączenie jest trwałe do ponownego połączenia. VELORA tego nigdy nie wysyła.

## 5. Wykonalność wymagań bez dodatkowych sterowników

| Wymaganie | Wykonalne? | Uwagi |
|---|---|---|
| D-pad lewo/prawo, góra/dół | Tak | Natywnie; Gamepad API jako fallback |
| Lewy analog z martwą strefą | Tak | Histereza 0,55/0,35 + reguła osi dominującej (przekątna) |
| Cross = potwierdź, Circle = wstecz | Tak | Semantyczne nazwy przycisków |
| Options = Control Center | Tak | Na zwolnieniu, nie gdy PS był wciśnięty |
| L1/R1 sekcje | Tak | Tylko Control Center (zakładki), tylko źródło natywne |
| Share bez akcji | Tak w VELORA | Nie zatrzyma reakcji Steam/innych aplikacji |
| PS gdy VELORA ma fokus | Tak (odczyt) | Domyślnie bez akcji solo; akord PS+Options |
| PS z tła → VELORA na wierzchu | **Częściowo** | Wykrycie tak; aktywacja okna zależy od Windows (zob. `velora-2-s1-ds4.md`) |
| Ukrycie pada przed innymi, blokada PS Steam, sterowanie obcymi aplikacjami padem | **Nie** | Wymaga klasy sterowników HidHide/ViGEm. Poza zakresem |

## 6. Ryzyka (priorytetowo)

1. **Wysokie:** kształt/dopełnienie raportów BT inny niż w specyfikacji → parser z minimami + CRC; diagnostyka pokazuje tylko potwierdzone dane. Test sprzętowy konieczny.
2. **Wysokie:** natywne i Gamepad API jednocześnie reagują na jedno naciśnięcie → `ignorePad` (pomija DS4 w Gamepad API), `CrossSourceGate` (odrzuca tę samą akcję z drugiego źródła w 90 ms **oraz wszystkie akcje Gamepad API przez 400 ms po aktywności natywnego pada**), prime po zmianie źródła. To **nie** jest twardy arbiter: wirtualny pad z tego samego DS4 jest chroniony tylko oknami czasowymi **[NIEZWERYFIKOWANE]**.
3. **Wysokie:** nadpisanie/usunięcie rejestracji Raw Input → jeden właściciel; start/stop Control Service nie rejestruje niczego.
4. **Średnie-wysokie:** Steam zamienia pad w klawisze (podwójne ruchy) → [NIEZWERYFIKOWANE], plan testów.
5. **Średnie:** odmowa aktywacji okna przez Windows → uczciwy toast + skrót awaryjny, brak sztuczek Alt/AttachThreadInput.
6. **Średnie:** utracone zwolnienie → heartbeat 250 ms + wygaszanie po 700 ms po stronie frontendu; po stronie Rust pad, który przestał nadawać, dostaje neutralny stan po 750 ms (wynik drugiego audytu: wcześniej heartbeat powtarzał wciśnięty kierunek do 3 s).
7. **Niskie-średnie:** klony DS4, adapter bez sparowanego pada, wznowienie po uśpieniu [NIEZWERYFIKOWANE].

## 7. Cele poza zakresem S1

Wyłączność/ukrywanie pada (HidHide, ViGEm, emulacja XInput) · zmiana konfiguracji Steam/Steam Input · domyślne PS solo · lightbar, rumble, touchpad, żyroskop, wymuszanie trybu BT · gwarantowana aktywacja okna z tła (Alt, AttachThreadInput) · sterowanie innymi aplikacjami padem · GameInput, Windows.Gaming.Input, hidapi, gilrs.
