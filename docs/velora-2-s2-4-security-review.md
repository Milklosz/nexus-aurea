# S2.4 — przegląd bezpieczeństwa

Status: **SOURCE REVIEW — zintegrowany kod S2.4**. Przegląd obejmuje diff S2.4 względem `740f5964df4e2dc843f436b0e5e7a61af9cafc13`, w tym `spatial_navigation.rs`, `streaming_control.rs`, `tv_navigation.rs`, wskaźnik, diagnostykę i symulator. Wyniki Computer Use, testów integracyjnych i tożsamość finalnego artefaktu należy odczytywać z odrębnych raportów. Ten dokument nie jest certyfikacją przeglądarki, DRM, LAN ani fizycznego DS4. Zmiany w tych ścieżkach po przeglądzie wymagają ponownej oceny.

## Przejrzane granice zaufania

| Granica | Ustalenie z inspekcji źródeł |
|---|---|
| Fizyczny pad → router | Zachowany PadHub, raporty ograniczone, neutralne uzbrojenie i unieważnianie generacji. Nie dodano nowego sterownika ani globalnego hooka. |
| Akcja → okno streamingu | Zachowana sesja rejestru uruchomień i dokładne HWND/PID/czas utworzenia procesu/usługa. Rewalidacja własności i pierwszego planu przed wysłaniem. |
| Symulator → IPC | Natywne `debug_assertions` i ścisłe lokalne pochodzenie głównego WebView; release nie udostępnia symulacji. Numery sekwencji rosną, generacja i kolejka są ograniczone. |
| Import JSON → symulator | Maksymalnie 32 768 znaków, 1–64 kroki, zamknięta lista akcji i pięciu usług, odstępy 100–1000 ms, całkowite ruchy −32…32. Wynik jest konstruowany z dozwolonych pól; obce HWND/PID, sesje, skrypty, tekst i kody klawiszy są odrzucane przez pominięcie. Sam import nie wysyła poleceń. |
| Odtwarzanie → aktywacja treści | Checkpointy są ponownie wyznaczane z semantyki akcji, a nie z pola `requiresReview` w imporcie. Confirm/klik/skrót odtwarzacza zatrzymują odtwarzanie do lokalnej kontroli ekranu. Nie wolno zatwierdzać zakupu, wynajmu ani zmiany konta. |
| Przełączenie usług | Nagranie przechowuje tylko publiczną nazwę usługi. Odtwarzanie wymaga dokładnie jednej żywej zarządzanej sesji i ponownie przypina ją natywnie. Nie przyjmuje identyfikatora sesji z JSON. |
| Anulowanie | Rozwiązuje checkpoint odmownie, kończy opóźnienie, unieważnia dzierżawę i wywołuje natywne unieważnienie generacji. Nie cofa akcji już przyjętej przez Windows. |
| LAN → sterowanie | Zachowana autoryzacja HTTPS/HMAC, rezerwacja i ochrona sekwencji w `remote_access.rs`; `route_remote_navigation` przyjmuje tylko dozwolone akcje semantyczne. Brak endpointu symulatora, dowolnego klawisza, skryptu czy współrzędnych LAN. Kontener symulatora ma `data-remote-admin`. |
| Strona streamingu → VELORA | Osobne okno/proces Edge. Brak wstrzyknięcia skryptów, mostu WebView, odczytu danych logowania czy obchodzenia DRM. |
| Eksport dowodów | Do 64 wyników, zamknięte kody i nazwy usług. Pomija surowe błędy, nazwy stron i identyfikatory sesji. Oznaczenie efektu przez operatora jest oddzielone od przyjęcia natywnego polecenia i zawsze opisane jako lokalna obserwacja. |
| Diagnostyka ekranów | Wyłącznie odczyt; do 16 monitorów, 64 ścieżek, 256 trybów i 32 punktów audio. Ścieżki urządzeń są haszowane; EDID nie zawiera numeru seryjnego. Nowe etykiety przechodzą istniejącą redakcję eksportu. |

## Wskaźnik i zasoby Win32 — niezależny przegląd SOURCE

Układ wskaźnika używa sprawdzanej arytmetyki, obsługuje ujemny początek pulpitu i ukrywa wskaźnik, gdy nie mieści się w oknie. Okno pozostaje `NOACTIVATE`, `TOOLWINDOW`, `TRANSPARENT`, `LAYERED` i `WS_DISABLED`. Nie przejmuje fokusu ani wejścia. Widoczność wymaga zgodności właściciela z pierwszym planem i świeżego stanu.

Zarządzanie fontem jest zgodne z kolejnością własności: nowy font zostaje przypisany do własnego kontrolera STATIC przed usunięciem poprzedniego; końcowy font jest usuwany po `DestroyWindow`. `SendMessageW(WM_SETFONT)` dotyczy własnego okna na tym samym wątku. Nie znaleziono wycieku fontu w ścieżce sukcesu.

Dodatkowy komunikat „klik wysłany” jest ustawiany dopiero po przyjęciu całej tablicy `SendInput`, na 350 ms i dla tego samego właściciela. Jest potwierdzeniem wysłania, nie skutku na stronie. Tekst jest stały i nie pochodzi ze strony ani danych użytkownika. Używa tego samego nieaktywującego okna i warunków świeżości/własności; nie tworzy nowej ścieżki wejścia.

Niezależny przegląd wykrył ignorowany wynik `SetThreadDpiAwarenessContext`. Koordynator poprawił tę ścieżkę; ponowna inspekcja potwierdziła zakończenie tworzenia wskaźnika przy błędzie, aby nie potraktować współrzędnych zwirtualizowanych jako fizycznych. Kontekst dotyczy wyłącznie dedykowanego wątku, który kończy pracę; nie zmienia polityki DPI procesu ani systemu. Komentarz został także poprawiony: `GetWindowRect` opisuje granice całego okna, łącznie z częścią niekliencką, a nie granice samego klienta.

## Istotne ograniczenia

Natywny fallback został przejrzany niezależnie. Nie ponawia niepotwierdzonej akcji UIA jako kliknięcia ani skrótu klawiatury. Sprawdza generację i dokładne zarządzane okno, przełącza jedynie trwały tryb na wskaźnik oraz unieważnia oczekujące wejście i stan silnika. Użytkownik musi wykonać kolejny świadomy ruch/klik. Zmiana trybu jest widoczna w wyniku i wskaźniku; brak potwierdzenia akcji pozostaje odrzuconym wynikiem, bez deklaracji, że dostawca na pewno nic nie wykonał.

Home i Control Center symulatora dopuszczają lokalne okno VELORA albo dokładnie przypiętą sesję Edge na pierwszym planie. Warunek jest sprawdzany przy przyjęciu i ponownie na wątku wykonującym. Home pozostaje w istniejącym workerze, a gotowość powrotu wymaga zgodnej rewizji sesji Home, potwierdzonego wyniku restore i rzeczywistego fokusu głównego okna. Nie uznano samego dodania żądania do kolejki za zakończony Home.

Przegląd wykrył przejściową rekurencję mutexu w nowym `status_snapshot`/`simulator_home_ready`; implementator ją usunął. Ponowna inspekcja potwierdziła skopiowanie stanu i zwolnienie blokady przed obliczeniem gotowości Home. Zgłoszono także nieprawdziwe sformułowanie „akcja UIA nie została wysłana” po błędzie potwierdzenia. Poprawione źródło mówi o braku potwierdzenia i braku ponowienia. Diagnostyka UIA jest zerowana na początku próby, aby błąd dostawcy nie zachował starego potwierdzenia fokusu.

- `SendInput` nie ma atomowej operacji ograniczonej do docelowego HWND. Zmiana pierwszego planu po ostatniej kontroli to zachowane ryzyko wyścigu; końcowe kontrole ograniczają okno ryzyka, ale go nie eliminują. Błąd UIPI oznacza odrzucenie, nie próbę obejścia ochrony. [Kontrakt Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput).
- Synchroniczne UIA może przekroczyć kooperacyjny budżet z powodu zachowania zewnętrznego dostawcy. Limit czasu nie cofa wywołania już przyjętego przez dostawcę. Fallback po nieznanym wyniku mutującym nie może wysłać drugiej aktywacji.
- Własność procesu i okna nie dowodzi pochodzenia aktualnej strony po nawigacji użytkownika. Kod strony nie stanowi upoważnienia do natywnych akcji.
- Lokalny checkpoint wymaga rzeczywistej kontroli ekranu przez operatora. Jest ochroną przed ślepym odtworzeniem aktywacji; nie rozpoznaje automatycznie przycisków zakupu ani formularzy konta.
- Odtwarzanie może zmienić domyślne systemowe volume/mute wyłącznie przez jawne dozwolone akcje. Brak przełączania domyślnego urządzenia i regulacji głośności obcych aplikacji.
- Symulacja Home nie dowodzi dostarczenia przycisku PS przez Bluetooth. Testy jednostkowe i SOURCE REVIEW nie potwierdzają zachowania usługi na żywym ekranie.
- Brak akceptacji instalatora/upgrade, fizycznego DS4, iPhone LAN, chronionych katalogów, odłączenia HDMI i długotrwałego działania na podstawie samego przeglądu źródeł.

## Bramka

W zintegrowanym, przejrzanym kodzie nie wykryto nierozwiązanej krytycznej podatności ani ścieżki do dowolnego wykonania kodu/ujawnienia danych logowania. Poprawki kontroli kontekstu DPI, rekurencji mutexu i nieprawdziwej deklaracji wyniku zostały potwierdzone w źródle. Jest to ocena ograniczonego zakresu **SOURCE REVIEW**, a nie dowód bezpieczeństwa całego systemu ani zaliczenie otwartych akceptacji runtime. Końcowy raport Gate G musi wskazać konkretny commit i wyniki centralnych testów; ograniczenia wyścigów Windows/UIA pozostają jawne.
