# VELORA Grand Living Room — końcowy raport inżynierski

Data: 16 listopada 2026. Kandydat: **0.10.0-rc.2**. Kod: **`a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea`**.

Zintegrowano S2.1/S2.2 i domknięto wykryte luki funkcjonalne oraz błędy z przeglądu i testów Windows. To kandydat inżynierski; **nie ma akceptacji sprzętowej ani statusu stable**. Kod pozostaje zamrożony, a ten raport i końcowe dowody są na osobnej gałęzi dokumentacji. Wyników rc.1 lub pośredniego `32782c0` nie przenosi się automatycznie na końcowy plik.

## 1. Zastany stan repozytorium

Główny checkout był na `codex/velora-2-s1-2-claude-usage`, HEAD `ec28205c97cc278290f45dc020d9da8c03618a0e`, z nieśledzonymi `.codex/` i `target-int/`. Zachowano je. Audyt znalazł już przygotowane osobne repozytorium `work/grand`, zintegrowany kod `f232ea6`, istniejące Draft PR #59/#60, lokalny debug rc.1 i nieśledzony wcześniejszy raport. Kontynuowano tę pracę zamiast jej powielania. Wcześniejszy raport zachowano jako wyraźnie oznaczone archiwum rc.1; nie jest bieżącym dowodem delegacji lub testów.

PR #58 sprawdzono przez połączenie GitHub: otwarty Draft, S2.0 `05f7235bb4680df03f9147bad055bb542cd6524e`, baza S1.4. Nie zmieniono go. Odczytane metadane instalacji wskazują 0.9.2; nie dowodzi to źródłowego commitu zainstalowanego pliku. Instalacji nie zastąpiono. Bez reset --hard, clean, force-push, modyfikacji main, merge lub stabilnego wydania.

## 2. Architektura i rzeczywista delegacja

Sześć obszarów funkcjonalnych korzysta ze wspólnych, istniejących autorytetów: `LaunchRegistry` śledzi uruchomienia i tożsamość procesów, `WindowBroker` własność/aktywację okien, `SessionOrchestrator` przejścia Home, a `PadHub` wejście kontrolera. Session Manager jest projekcją, nie drugim trackerem. Stan trwały zawiera wersjonowane identyfikatory; nie utrwala nowych żywych HWND, ciasteczek lub treści kont.

W bieżącej kontynuacji rzeczywiście uruchomiono trzy agentowe zadania: Luna Max — Windows Computer Use; specjalista sesji — implementacja i niezależny przegląd pilota/restartu; specjalista pilota — implementacja i niezależny przegląd audio/TV/sesji. Integracja, natywne audio/TV, poprawka restartu, testy pełne, GitHub i artefakty należały do agenta głównego. Przeglądy nie są przedstawiane jako niezależne potwierdzenie własnych zmian autora.

## 3–14. Funkcje i granice

| Obszar | IMPLEMENTED | AUTOMATED TESTED / granica live |
| --- | --- | --- |
| 3. Smart Home | Zwijane Moje aplikacje; wersjonowane ostatnie/ulubione, deduplikacja, przypinanie, kolejność, usuwanie i domyślne; jawne błędy zapisu | Store/panel/migracje i nawigacja; rc.1 potwierdziło edycję i trwałość po ponownym uruchomieniu. Usunięte ID są pomijane, niedostępny launcher zwraca istniejący bezpieczny błąd |
| 4. Session Manager 2.0 | Typ, rodzina metody uruchomienia, ID, stany, czas startu i rzeczywistego zaobserwowanego wejścia na pierwszy plan, możliwości i bezpieczny błąd; osobne notRunning bez fikcyjnych sesji | Testy PID reuse, cyklu życia, czasu aktywacji i powiadomień. Aktywacja wymaga dokładnego HWND/PID/czasu utworzenia procesu |
| 5. Control Center 3.0 | Sesje/switcher, Home, audio, TV, statusy kontrolera/pilota, diagnostyka, pulpit, exit/restart | Zachowuje istniejącą nawigację i lokalne znaczniki administracyjne. Resume oznacza okno aplikacji, bez czasu filmu |
| 6. Audio Windows | Core Audio read/set/mute i bieżące wyjście; zwrot rzeczywistego stanu; ochrona przed zapisem do nieaktualnego wyjścia | Callback IMMNotificationClient na istniejącym workerze, unieważnienie starego odczytu, debounce 100 ms bez nowej pętli pollingowej. Brak nieudokumentowanego przełączania domyślnego wyjścia |
| 7. iPhone Remote | Istniejące HTTPS PWA i parowanie; D-pad, OK/Back/Home, głośność/mute, CC/switcher, ulubione przez Home, nowy touchpad nawigacyjny, safe areas i stany reconnect | Gest emituje jedną istniejącą komendę kierunku/select. HMAC/replay i nieeksportowalny klucz zachowane; brak automatycznego powtarzania po reconnect. Fizycznego iPhone’a nie testowano |
| 8. Gaming Hub | Zainstalowane/ulubione/ostatnio żądane gry Steam i wejście do istniejącej biblioteki Playnite | Kolekcje ograniczone, ID przecinane z rzeczywistą biblioteką; żądanie launch nie oznacza rozegranej sesji |
| 9. Steam | Zachowane lokalne wykrywanie, Big Picture, zweryfikowane ID i uruchamianie; nowe kolekcje | Wykrycie rzeczywistej biblioteki potwierdzone w rc.1. Bez zmiany Steam Input lub danych konta; gry nie uruchamiano live |
| 10. Playnite | Zachowany eksporter/manifest/biblioteka/okładki i guarded launcher/resume | C# buduje CI. Brak dostępnej lokalnej instalacji nie tworzy fikcyjnych gier. Nie deklaruje się obsługi Playnite 11 na podstawie integracji SDK 6/Playnite 10 |
| 11. TV Mode | Jawny wybór ekranu i fullscreen tylko dla VELORA; zapis preferencji; start i powrót po zmianie ekranów przez istniejący obserwator | `--windowed` wygrywa; utrata ekranu daje okno na głównym. Nie zmienia topologii, HDR, rozdzielczości ani domyślnego audio Windows |
| 12. Ekrany | Rzeczywiste monitory, primary/current, rozdzielczość/skala, natywne odświeżanie i typ połączenia | HDMI wyłącznie z jednoznacznego QueryDisplayConfig; klonowane/nieznane cele mają unknown. Bez zgadywania Panasonica z numeru ekranu |
| 13. Autostart/recovery | Jawny istniejący HKCU opt-in, single-instance i clean recovery; poprawione orderly restart i zwolnienie własnego mutexu przed nową instancją | Izolowany test mutexu nie dotyka działającej VELORA. Nie włączono autostartu, nie dodano usługi/watchdog ani zamiany Explorer |
| 14. Diagnostyka | Wersja/SHA, sesje, kontroler/pilot, audio/ekrany, Home/restore i błędy; eksport z hash i rozszerzoną redakcją | Bez tokenów/credentials/prywatnych tytułów w nowej projekcji. Publiczne dowody pomijają surowe dane maszyny; lokalne szczegóły pozostają w ignorowanym outputs |

## 15. Wydajność

Produkcyjny frontend końcowego kodu: główny JS około 426 kB, gzip około 129 kB; CSS około 60 kB, gzip około 14 kB. To rozmiar buildu, nie pomiar responsywności. Sesje wykorzystują istniejące zdarzenia, a TV istniejący obserwator. Audio nie dodaje okresowego odpytywania; kolekcje, ingest i liczby sesji mają limity. Potwierdzenie Close dodaje jeden odczyt po 6,5 s, bez pętli ponawiania.

Wykonano jedną krótką próbkę bezczynności końcowego debug EXE wraz z jego stabilnym drzewem procesów potomnych. Szczegółowe wartości i ograniczenia są w lokalnym, ignorowanym outputs/performance-a7c53b3-local.json i nie są publikowane na GitHub. Nie podaje się wyliczonych z czasu narzędzia „latencji UI” ani fikcyjnych benchmarków startupu, pilota lub kontrolera.

## 16. Bezpieczeństwo i naprawione ustalenia

Zachowano CSP, dozwolone oficjalne URL, Credential Manager, HTTPS/HMAC, trwałą ochronę sekwencji/replay oraz dokładną własność okna i procesu. Brak nowych nieautoryzowanych endpointów, dowolnych ścieżek/procesów w IPC, sterowników, hooków lub uprawnień administratora. Nie obchodzono SmartScreen, Defender ani ostrzeżeń TLS.

Naprawiono: pierwszeństwo blokady administracyjnej DOM względem dozwolonego rodzica; cache PWA; brak powiadomienia o zmianie fokusu sesji; wyścig stare 401/nowe parowanie oraz nieatomową rezerwację sekwencji; restart z zachowaną do końca procesu blokadą pojedynczej instancji. Przeglądy źródeł nie pozostawiły rozpoznanego critical/high/P2 w badanym zakresie. Nie oznacza to pełnego pentestu lub braku wszelkich błędów.

IndexedDB porównuje generację poświadczenia w pojedynczej transakcji readwrite; stare odrzucenie ani tombstone nie usuwają nowego klucza. Web Locks nie kolejkuje komend. Bez Web Locks transakcje chronią dane, lecz kolejność dostarczenia komend z wielu kart nie jest gwarantowana. Równoległe, przegrane udane parowanie może wymagać odwołania nieużywanego urządzenia po stronie serwera. Hash pliku nie jest podpisem kodu. Sanitizer nie rozpoznaje każdego możliwego sekretu.

## 17. Testy automatyczne

| Sprawdzenie | Wynik końcowego kodu |
| --- | --- |
| Vitest | **946 PASS /105 plików** |
| Rust Windows, pełny zakres | **429 PASS /0 FAIL /2 ignored /0 filtered** |
| TypeScript | PASS |
| Produkcyjny frontend | PASS |
| Provenance i adapter Claude | **37 PASS** (31+6) |
| Clippy all-targets | PASS; odziedziczone ostrzeżenia pozostają |
| rustfmt zmienionych modułów natywnych | PASS |
| format całego crate | Odziedziczony drift; nie ogłoszono PASS |
| Whitespace S2.0→kandydat | PASS |
| Niezależny pilot po naprawie wyścigu | 65/65 wybranych; pełny zakres pilota 69/69 |
| Debug Windows z czystego commitu | PASS |

Dwa ignored to helpery podprocesów uruchamiane jawnie przez inne testy, nie „zaliczone” testy sprzętu. Pełny Rust wykonano poza blokadą sandboxa na unikalnych, syntetycznych usługach Credential Manager. Zachowano historyczne lokalne błędy sandboxa oraz wcześniejszą próbę zakończoną przed testami przez brak katalogu tymczasowego; nie zostały zamienione w PASS. Po utworzeniu krótkiego TMP pełny zakres przechodzi. Lokalnie brak SDK .NET; rozszerzenie Playnite sprawdza Windows CI.

## 18–19. Computer Use i bramka fizyczna

W tej sesji udokumentowany `@oai/sky` działał; nie instalowano ani nie naprawiano ręcznie helpera. **rc.1**: potwierdzono uruchomienie, recent, ulubione i trwałość, resume, nawigację CC, odczyt/zmianę/odtworzenie audio, wykrycie biblioteki, ekran/fullscreen/windowed, diagnostykę, stale Claude Usage oraz zegar/pogodę. **rc.1 restart FAIL** zachowano jako pierwotny wynik i poprawiono kod po analizie Tauri. Netflix Close zakończyło sesję; inne własne okna pozostały po przyjęciu WM_CLOSE. Nie uznano samego przyjęcia żądania za zamknięcie.

W końcowym rc.2 integrator potwierdził w UI dokładny SHA/wersję, trwałość Home, natywne audio/parametry ekranu, eksport i faktyczny restart do jednej nowej instancji. W końcowym rc.2 integrator potwierdził w UI dokładny SHA/wersję, trwałość Home, natywne audio/parametry ekranu, eksport i faktyczny restart do jednej nowej instancji. Końcowe wyniki rc.2 i dokładny SHA są w [macierzy CU](velora-2-grand-computer-use-results.md). Nie przenosi się całej macierzy rc.1 na rc.2. Live remote z oddzielnego klienta, start gry, zachowanie wcześniej otwartej obcej przeglądarki oraz wykonanie instalacji/upgrade/rollback pozostają osobno niezaakceptowane.

**PHYSICAL HARDWARE VERIFIED: brak.** Odroczone: PS+Options, osobno fallback Home, Netflix→Home→YouTube, Steam/Playnite→Home, deduplikacja, Bluetooth reconnect, dziesięć kolejnych powrotów, fizyczny iPhone i Panasonic HDMI/audio. Nie proszono o podłączanie pada podczas prac. Klawiatura/mysz nie są dowodem działania kontrolera.

Na koniec zamknięto kandydata normalnie i wyłącznie dwa potwierdzone okna przeglądarki utworzone podczas testów, przez ich własne Alt+F4 po aktywacji. Końcowa lista okien potwierdziła sprzątnięcie. Nie zabijano procesów, nie zamykano obcych sesji i nie akceptowano ekranów logowania lub cookie. To sprzątnięcie nie zmienia wyniku wcześniejszego żądania Close w VELORA.

## 20–23. Git, build, Draft PR i CI

| Element | Identyfikacja |
| --- | --- |
| Zachowane S2.0 | [Draft #58](https://github.com/Milklosz/nexus-aurea/pull/58), `05f7235` |
| S2.1 | [Draft #59](https://github.com/Milklosz/nexus-aurea/pull/59), `89886f0` |
| S2.2 rc.1 | [Draft #60](https://github.com/Milklosz/nexus-aurea/pull/60), `f232ea6` |
| Uzupełnienia i naprawy rc.2 | [Draft #61](https://github.com/Milklosz/nexus-aurea/pull/61), gałąź `codex/velora-grand-living-room-validation` |
| Końcowy kod / integracja | `a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea`; `integration/velora-2-grand-living-room` |
| Trzy commity kontynuacji | `32782c0` — sesje/pilot/audio/TV; `84e7e69` — QA parowania/restartu/zamykania; `a7c53b3` — czytelne kontrolki TV |
| Dowody po buildzie | Gałąź `docs/velora-grand-rc2-evidence`, bez zmiany zamrożonego kodu |
| Końcowe CI kodu | [run 43953442661](https://github.com/Milklosz/nexus-aurea/actions/runs/43953442661); Windows, macOS i Playnite PASS; publikacja wydania SKIPPED |

Drzewa publikowane przez GitHub API porównano z lokalnym indeksem Git. Aktualizacje gałęzi miały oczekiwany poprzedni SHA i `force:false`. Lokalny fetch uzupełnił krótki łańcuch rodziców i potwierdził pochodzenie od zachowanego `f232ea6`. Bez merge lub publikacji wydania.

Debug końcowy: `VELORA-0.10.0-rc.2-a7c53b3-debug.exe`, **27491328 bajtów**, SHA-256 **`236bbb6dce61180fe8ddf0ac9b39d42521c19bd67a45e18712478f36c7e51e05`**. Odczytano PE ProductVersion 0.10.0-rc.2; manifest sprawdził czysty checkout i osadzony source SHA. Nie jest to podpis lub atest CI.

Instalator NSIS, manifest provenance i rozszerzenie Playnite pobrano z końcowego runu wskazanego wyżej. ZIP-y zgadzają się z digestami Actions. Instalator VELORA_0.10.0-rc.2_x64-setup.exe ma 4534456 bajtów, ProductVersion/FileVersion 0.10.0-rc.2 i SHA-256 `37605cd38e1cdf6b1fcacc03fda44c4228f3b1f641ce512fb9b6a5c8119732c0`. Manifest wskazuje source a7c53b3 i synthetic merge 59b93c34d9eb4ef58b59d658109083efc84ca66e. Windows CI sprawdziło pochodzenie w kontekście runnera i relację payloadu; lokalna kontrola spójności również przeszła. Lokalny verifier nie potwierdza samodzielnie pochodzenia CI; podpis nie jest udowodniony. macOS Rust: 378 PASS, 1 ignored; Windows: 429 PASS, 2 ignored. **Nie uruchamiano instalatora.** Poprzedni instalator rc.1 zachowano oddzielnie i nie przedstawia się go jako zawierającego poprawki rc.2.

## 24. Znane ograniczenia

Gate G pozostaje BLOCKED. Brak fizycznego iPhone/TLS i kontrolera/TV; brak live gry i kompletnego testu obcej przeglądarki. Resume dotyczy aplikacji, bez prywatnego postępu video. Close może zostać zignorowane przez aplikację lub wymagać jej własnej interakcji; UI jawnie zgłasza brak potwierdzenia. Nie zmienia się globalnego audio ani topologii. Monitorowe ID może wymagać ponownego wyboru po zmianie geometrii. Steam/Playnite zachowują oddzielne kolekcje. Brak watchdog i deklaracji recovery przy uszkodzonej pętli zdarzeń Tauri. Instalator jest kandydatem bez podpisu potwierdzonego tym programem; wykonania upgrade/rollback nie testowano.

## 25. Wycofanie

Kandydat współdzieli tożsamość aplikacji, single-instance i dane z instalacją. Do powrotu bez instalowania zamknąć kandydata normalnie i otworzyć dotychczasową VELORA; nie usuwać ustawień ani profili przeglądarki. `--windowed` omija zapisany fullscreen/TV. Ulubione i głośność zmienione w testach przywrócono do zaobserwowanego stanu wyjściowego.

Przed ewentualnym, osobno zatwierdzonym upgrade zachować poprzedni instalator oraz uzgodnioną prywatną kopię konfiguracji. NSIS zachowuje `pl.nexus.aurea`, `nexus-aurea.exe`, tryb current-user i istniejący upgrade hook. Nie włącza autostartu ani nie zamienia Explorer. Rollback po upgrade wymaga zachowanego poprzedniego instalatora; bez opcji kasowania danych użytkownika. Tego upgrade nie wykonywano.

## 26. Zalecany następny etap

Przyjąć kandydat inżynierski wyłącznie w zakresie udokumentowanych bramek, pozostawiając wszystkie PR-y Draft. Dokończyć brakujące testy klienta LAN i obcego okna oraz kontrolowany test gry, następnie osobną, dobrowolną akceptację DS4/iPhone/HDMI. Dopiero potem rozważać stabilne wydanie. Samo zielone CI lub działający ekran Home nie zamyka tych bramek.
