# Walidacja sprzętowa v0.7.1

Status: **NOT TESTED**. Nie instalować ani nie zastępować 0.4.0 bez zweryfikowanej kopii, planu odtworzenia i zgody użytkownika na zastąpienie.

## Warunki przed instalacją

1. Potwierdzić model MSI, wersję 0.4.0, lokalizację aplikacji, dane WebView i skróty/autostart. Zanotować istniejący instalator, wpis odinstalowania i ustawienia.
2. Zamknąć NEXUS po uzgodnieniu z użytkownikiem; wykonać kopię katalogu instalacji i całego profilu WebView oraz skrótów. Sprawdzić sumy kontrolne i dostępność kopii; dane mogą być wrażliwe.
3. Ustalić i sprawdzić na osobnym środowisku sposób odtworzenia plików, danych, skrótów i wpisów instalatora. Zachować instalator 0.4.0. Nie zakładać, że samo skopiowanie EXE odtwarza instalację NSIS.
4. Porównać tożsamość, instalator i ścieżki wersji 0.7.1 z 0.4.0. Wspólny identyfikator `pl.nexus.aurea` oznacza ryzyko współdzielenia danych WebView; instalacja obok nie jest potwierdzona. Uzyskać zgodę na zastąpienie, jeśli jest wymagane.
5. Zapewnić klawiaturę i dostęp do pulpitu. Zanotować aktualne wyjście audio. Nie zmieniać sterowników, powłoki ani ustawień HDMI.

## Procedura i rejestr

Wynik każdego punktu zapisać jako PASS tylko po rzeczywistej próbie, w przeciwnym razie FAIL lub NOT TESTED, wraz z datą, wersją, połączeniem i obserwacjami. Przerwać po utracie kontroli, problemie z danymi lub niestabilności. Escape/F11 i `--windowed` są opcjami odzyskiwania okna; Alt+Tab umożliwia powrót do pulpitu. Awaryjny skrót usługi to Ctrl+Alt+F12.

| Obszar | Próba | Status |
| --- | --- | --- |
| NEXUS | Start Windows i autostart; fullscreen na Panasonicie; fokus, powrót do Windows, restart po błędzie | NOT TESTED |
| Pad | Nawigacja lokalna USB i Bluetooth osobno; powrót, Gaming, Steam Input i awaryjne wyłączenie | NOT TESTED |
| App Manager | Wykrywanie i start Steam/Apple Music, aplikacje już uruchomione, powrót, profile Cinema/Gaming/Desktop | NOT TESTED |
| Apple Music | Sesja SMTC, tytuł/wykonawca/stan, play/pause, next/previous, pozycja, Background i Music Mode | NOT TESTED |
| Audio | Aktualne wyjście Windows, głośność, brak zmiany urządzenia; JBL tylko po potwierdzeniu połączenia | NOT TESTED |

Globalne mapowanie przycisków pada i skrót powrotu padem nie są zaimplementowane; dostępny skrót powrotu używa klawiatury. Działanie SMTC i fokusu zależy od systemu i aplikacji. Stan zapisany w profilu nie dowodzi, że wszystkie skutki profilu zostały zastosowane.

## Znane ryzyka do rozstrzygnięcia

- App Manager po wykryciu uruchomionego Steam zwraca informację o procesie bez otwarcia Big Picture ani przeniesienia fokusu. Wykrywanie opiera się na wybranych ścieżkach i nazwach procesów.
- Zmiana trybu Gaming w Control Service jest asynchroniczna; zwrócony status może wyprzedzać rzeczywiste zwolnienie lub rejestrację skrótu. Przed testem konfliktów wymagana jest weryfikacja na sprzęcie.
- SMTC jest prototypem: rozpoznawanie sesji na podstawie fragmentu identyfikatora może wskazać niewłaściwą sesję; brak timeoutu na operacjach WinRT może blokować polecenie. Brak okładek, routingu audio i kontroli urządzeń.
- Uruchomienie aplikacji i przełączenie fokusu ogranicza polityka Windows; fizyczna obsługa kontrolera i SMTC nie wynikają z zielonego CI.

