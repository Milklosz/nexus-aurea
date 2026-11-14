# VELORA 2.0 · S1 · Plan testów sprzętowych DualShock 4

> **Status każdego punktu: NOT TESTED ON HARDWARE**, dopóki wpisu nie zrobi użytkownik (kolumna „Wynik"). Ten sprint niczego nie instaluje na MSI i nie zmienia konfiguracji sprzętu.

Sprzęt docelowy: MSI GP76 Leopard 11UG, Windows 11, Panasonic TX-49EX610E przez HDMI, Sony DualShock 4 przez USB i Bluetooth.

## 0. Przygotowanie

1. Zbudowana wersja z gałęzi `feature/velora-2-s1-native-ds4` zainstalowana **ręcznie przez użytkownika** (nie przez agenta).
2. Zamknij DS4Windows, HidHide i inne narzędzia przechwytujące pada. Steam: przy pierwszym przebiegu **zamknięty**.
3. Uruchom VELORĘ, otwórz **Diagnostykę** (F2) i znajdź sekcję **Kontroler natywny**. Zostaw ją pod ręką: to jest główne źródło wyników.
4. Jeśli diagnostyka pokazuje „natywny odczyt niedostępny", zapisz podany powód i przejdź do fallbacku (Gamepad API); niektóre punkty poniżej nadal da się sprawdzić.
5. Wyniki zapisuj w tabeli na końcu (data, wersja pada: v1 CUH-ZCT1 / v2 CUH-ZCT2 / adapter, USB lub BT, wynik OK/BŁĄD/CZĘŚCIOWO, uwagi). **Nie** kopiuj do uwag ścieżek urządzeń ani numerów seryjnych.

## 1. Scenariusze

Skróty: **DS** = sekcja „Kontroler natywny" w Diagnostyce.

| # | Scenariusz | Kroki | Oczekiwany rezultat | Fallback, jeśli nie działa |
|---|---|---|---|---|
| 1 | **DS4 przez USB** | Podłącz kabel USB przed lub po starcie VELORY. | DS: „połączony", typ „DualShock 4 (v1/v2)", połączenie **USB**, aktywne źródło „natywne (Raw Input)". Ruch D-pada przesuwa kafel o jedno pole. | Jeśli typ/łącze puste: zapisz, co DS pokazuje. Przełącz źródło: odłącz natywne (patrz #16) i sprawdź Gamepad API. |
| 2 | **DS4 przez Bluetooth** | Sparuj pada w Windows, włącz (PS), poczekaj na połączenie. | Jak #1, połączenie **Bluetooth**. Zapisz, czy sam pad po połączeniu działa bez Steam. | Zapisz, czy DS pokazuje „połączony" ale brak ruchu (możliwy inny kształt raportu BT: **ważny wynik**). |
| 3 | **Home: nawigacja** | W doku: D-pad lewo/prawo przez wszystkie 8 kafli; krótkie tapnięcie, długie przytrzymanie, zmiana kierunku w trakcie. | Tap = 1 ruch; przytrzymanie: pierwszy ruch, pauza ~0,4 s, potem ~7 ruchów/s; zmiana kierunku natychmiast; brak przeskoków i zapętleń na krawędziach. | Zapisz kafel, na którym nawigacja się zacięła. |
| 3a | Lewy analog | Pchnij drążek w prawo/lewo; wolno przejdź przez martwą strefę; przekątna. | Brak ruchu w martwej strefie; brak drżenia; przekątna rusza **jedną** osią. | Zapisz zakres wychylenia, przy którym pojawił się ruch/drżenie. |
| 3b | Strefy | D-pad góra/dół z doku. | Przejście Control Center ↔ odtwarzacz ↔ dok ↔ Diagnostyka, bez zapętlenia. | — |
| 4 | **Cross / Circle** | Cross na kaflu; Circle w panelu. | Cross = **jedno** uruchomienie (nie dwa, nie dwa okna); Circle zamyka panel. | Zapisz, czy Cross uruchomił aplikację dwukrotnie (**podwójne wejście**: krytyczne). |
| 5 | **Control Center** | Options (tap) z doku; D-pad po zakładkach; L1/R1; Circle. | Panel otwiera się **po puszczeniu** Options; L1/R1 przełączają zakładki; Circle zamyka, fokus wraca do elementu, który otworzył (kafel/górne akcje). | Zapisz, gdzie wylądował fokus po zamknięciu. |
| 5a | Options + PS | Przytrzymaj PS i naciśnij Options. | Panel **nie** otwiera się; (z działającym Control Service) VELORA wraca na wierzch. | — |
| 6 | **Search** | Otwórz Szukaj (górne akcje → Cross); wybierz pole tekstowe (Cross); klawiatura ekranowa; Circle. | Klawiatura ekranowa przejmuje pada; Circle anuluje; po zamknięciu fokus wraca do pola/akcji. | Zapisz, czy Options otworzył coś pod klawiaturą (nie powinien). |
| 7 | **Netflix** | Cross na kaflu Netflix (Edge). | Aplikacja startuje **raz**. Podczas gdy Edge jest na wierzchu, pad **nie** porusza fokusem w VELORZE. (Diagnostyka nie jest wtedy widoczna: sprawdź po powrocie do VELORY, że fokus i wybrany kafel są **takie same jak przed** naciśnięciami w Edge.) | Zapisz, czy po powrocie fokus się przesunął (to błąd: pad nawigował w tle). |
| 7a | Powrót z Netflix | Włącz Control Service; PS+Options. | VELORA na wierzchu **albo** migotanie na pasku zadań + toast (dopuszczalne wg polityki). Edge **nie** jest zamykany. Zapisz, które. | Skrót awaryjny powrotu z Control Service. |
| 8 | **YouTube** | Jak #7 dla YouTube. | Jak #7/#7a. | Jak #7a. |
| 9 | **Steam** | Uruchom Steam (kafel), potem PS+Options. Powtórz z Big Picture. | Odnotuj: czy PS solo otwiera Big Picture (spodziewane, poza kontrolą VELORY); czy PS+Options przywraca VELORĘ; czy VELORA reaguje na pada, gdy Steam jest na wierzchu (**nie powinna**). | Zapisz konfigurację Steam Input (włączone/wyłączone „PlayStation Configuration Support"). **Nie zmieniaj jej automatycznie.** |
| 9a | Steam Input a podwójne zdarzenia | Przy włączonym Steam (desktop) naciśnij D-pad w VELORZE. | **Jedno** przesunięcie. Jeśli dwa: zapisz (Steam zamienia pad w klawisze strzałek). | Zalecenie: konfiguracja per aplikacja w Steam, nie globalna. |
| 10 | **Playnite** | Uruchom Playnite (tryb pełnoekranowy), PS+Options. | Polityka zezwala na Playnite; VELORA wraca lub toast. Playnite **nie** jest zamykany. | Jak #7a. |
| 11 | **Reconnect** | W trakcie przytrzymywania D-pada odłącz kabel / wyłącz pad (przytrzymaj PS). Podłącz ponownie. | Natychmiastowe zatrzymanie nawigacji (brak „zablokowanego" kierunku). DS: „brak kontrolera", po ponownym podłączeniu „połączony". Pierwsze naciśnięcie po połączeniu działa. | Zapisz czas do rozpoznania ponownego połączenia (BT potrafi trwać kilka sekund). |
| 11a | Pad poza zasięgiem BT | Oddal się, aż pad zniknie. | Po ≤ ~3 s DS: „brak kontrolera". | — |
| 12 | **Wybudzenie systemu** | Uśpij laptopa, obudź; (BT) wybudź padem przez PS. | Po wznowieniu pad działa bez restartu VELORY lub po ponownym połączeniu; zapisz, co było potrzebne. | Restart VELORY; zapisz czy konieczny. |
| 13 | **HDMI → telewizor** | Ustaw wyjście na TV; nawigacja z kanapy 2–3 m. | Fokus jest widoczny; brak opóźnień ponad ~100 ms odczuwalnych; Cross/Circle zgodne z #4. | Zapisz widoczność fokusu na TV. |
| 14 | **1080p** | Rozdzielczość 1920×1080. | Jak #13. | — |
| 15 | **4K** | Rozdzielczość 3840×2160 (jeśli TV/HDMI pozwala; TX-49EX610E to 4K). | Jak #13; brak spadku płynności nawigacji. | Zapisz wersję HDMI/odświeżanie. |
| 16 | **Fallback Gamepad API** | (Jeśli możliwe) uruchom VELORĘ w trybie bez natywnej warstwy lub z pozostałym błędem startu. | DS4 działa przez Gamepad API: nawigacja i Cross/Circle; **brak** podwójnych akcji. | — |
| 17 | **Dwa pady** | Podłącz drugiego DS4/Xbox. | Steruje jeden aktywny pad; drugi przejmuje dopiero po zwolnieniu pierwszego. (Xbox może być ignorowany przez ~0,4 s po ruchu DS4: priorytet natywny.) | Zapisz zachowanie. |
| 17a | **Wirtualny pad (DS4Windows / ViGEm)** | Uruchom DS4Windows (z i bez HidHide) lub Steam z konfiguracją tworzącą wirtualny pad XInput z tego samego DS4. Przytrzymaj D-pad w prawo przez 2 s; naciśnij Cross. | **Jedno** przesunięcie na krok powtarzania i **jedno** potwierdzenie. Jeśli podwójne: **zapisz opóźnienie/zachowanie** (krytyczne), bo ochrona to tylko okna 90/400 ms. | Zamknij DS4Windows/wyłącz wirtualny pad; zapisz konfigurację. |
| 17b | **Brak ciągłych raportów** | Przytrzymaj D-pad przez 3 s bez ruchu (USB, potem BT). | Powtarzanie trwa przez cały czas trzymania (> 750 ms). Jeśli ustaje po ~0,75 s: pad nadaje tylko przy zmianie stanu (**ważny wynik**, zmień założenie w `ds4.rs`). | — |
| 18 | **Diagnostyka** | Naciskaj kolejno przyciski. | „Ostatni przycisk" zgadza się z naciśniętym; brak danych, których nie da się potwierdzić. | — |

## 2. Co zebrać w razie błędu

- Zrzut ekranu sekcji DS (zawiera tylko dane semantyczne).
- Wersja pada (v1/v2/adapter), tryb łączenia, wersja Windows, czy Steam / DS4Windows działały.
- Czy Control Service był włączony (akord PS+Options działa tylko wtedy).

## 3. Tabela wyników (do wypełnienia przez użytkownika)

| # | Data | Pad (v1/v2/adapter) | USB/BT | Wynik | Uwagi |
|---|---|---|---|---|---|
| 1 |  |  |  | NOT TESTED ON HARDWARE |  |
| 2 |  |  |  | NOT TESTED ON HARDWARE |  |
| 3–18 |  |  |  | NOT TESTED ON HARDWARE |  |

## 4. Kryteria „zielonego światła" po testach

Minimum, by uznać natywną obsługę za gotową do użycia z kanapy: #1, #2 (lub jedno z nich, jeśli używasz tylko jednego łącza), #3, #4, #5, #11 oraz brak podwójnych zdarzeń w #4 i #9a. Pozostałe punkty wpływają na zakres ograniczeń, nie blokują samego sterowania w VELORZE.
