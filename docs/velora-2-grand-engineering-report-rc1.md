# Archiwum zastanego raportu rc.1

Ten dokument zachowuje wcześniejszy, nieśledzony raport znaleziony przy audycie. Opisuje poprzednią pracę i jej ówczesne ograniczenia; nie stanowi aktualnego potwierdzenia testów Computer Use ani wykonania wszystkich wymienionych delegacji w bieżącej sesji. Aktualne wyniki są w raporcie programu i macierzy Computer Use.

# VELORA Grand Living Room — raport inżynierski S2.1 + S2.2

Data: 16 listopada 2026. Wersja kandydata: **0.10.0-rc.1**.

**Wdrożono i zintegrowano istotną część programu. Kandydat nie ma akceptacji sprzętowej i nie jest wydaniem stabilnym.** Wyniki źródłowe, automatyczne, Computer Use i fizyczne są rozdzielone poniżej. Dokumentacja dowodowa znajduje się na osobnej gałęzi; kod i artefakty kandydata są zamrożone na wskazanym SHA.

## Repozytorium i sposób pracy

Początkowy checkout był na `codex/velora-2-s1-2-claude-usage`, HEAD `ec28205c97cc278290f45dc020d9da8c03618a0e`. Istniejące pliki nieśledzone zachowano. Wspólny katalog Git znajdował się poza dozwolonym obszarem zapisu, a terminal nie rozwiązywał nazw GitHub. Utworzono osobne repozytorium `work/grand`, bez kasowania lub nadpisania poprzedniej pracy.

Źródła S2.0 pobrano przez połączenie GitHub, zweryfikowano hashe 68 brakujących blobów oraz całe drzewo i odtworzono dokładny commit `05f7235bb4680df03f9147bad055bb542cd6524e`. Lokalna granica shallow zachowuje tę bazę. Zmiany publikowano przez GitHub API; każde opublikowane drzewo miało identyczny SHA jak lokalny indeks. Bez force-push, zmiany main, merge, tagu stabilnego lub instalacji.

Pracowało sześć rzeczywiście uruchomionych agentów: Smart Home; Session Manager; audio; Luna — pilot iPhone; Gaming/TV; niezależny przegląd bezpieczeństwa. Integrację, rejestrację IPC, poprawki po testach, budowanie i kontrolę jakości prowadził agent główny.

## Architektura i wdrożone funkcje

| Obszar | Rzeczywiste zachowanie | Weryfikacja i granice |
| --- | --- | --- |
| Smart Home | Wersjonowane ulubione i ostatnio uruchamiane aplikacje; przypinanie, kolejność, usuwanie, domyślne; zapis samych ID i deduplikacja; jawny błąd zapisu | Testy store/panelu i integracji; bez historii przeglądania |
| Home / Cinema Minimal | Kompaktowe rozwijane Moje aplikacje; wejście Wznów sesję; nowa strefa fokusu dla klawiatury, pada i pilota | Nawigacja DOM przetestowana; nie dowodzi realnego pada |
| Session Manager 2.0 | Projekcja istniejącego LaunchRegistry, bez drugiego trackera; stany uruchamiania, aktywności, tła, błędu, zakończenia i niedostępności; ustalone nazwy i błędy | Żadne HWND/PID/URL/tytuły okien nie są utrwalane w nowym store |
| Resume / switcher | Zakładka Sesje i polecenie Aplikacje pilota; weryfikacja PID/czasu utworzenia i dokładnego własnego HWND; jawna odmowa Windows | Wznowienie aplikacji, bez obietnicy czasu filmu |
| Zamykanie sesji | Dwuetapowe potwierdzenie i istniejący scoped WM_CLOSE dla własnych sesji Cinema | Bez zamykania całej przeglądarki; nieobsługiwane typy nie mają Close |
| Control Center 3.0 | Sesje, audio, TV, istniejące statusy kontrolera/pilota, Home, pulpit, autostart, diagnostyka i lokalny restart/exit | Zachowano dotychczasową kolejność zakładek |
| Audio Windows | Core Audio: bieżące wyjście, głośność i mute; jawne zmiany, natywny odczyt zwrotny i ochrona przed zmianą innego endpointu | Odświeżenie przy wejściu, fokusie, widoczności i przyciskiem; brak stałej subskrypcji IMMNotificationClient |
| iPhone Remote | HTTPS PWA, duże dolne przyciski z safe areas, odrębne stany łączenia/offline/wygaśnięcia; brak kolejki i automatycznego powtórzenia komendy | Istniejące HMAC, trwałe sekwencje, parowanie i odwołanie zachowane |
| PWA aktualizacje | SW command-6 dostarcza zmienione zasoby i pomija API/non-GET | Cache nie stanowi obietnicy sterowania offline |
| Gaming Hub | Wykryte lokalnie gry Steam; kolekcje zainstalowane/ulubione/ostatnio uruchamiane; wersjonowane ID-only dane | Wpisy przecinają rzeczywistą bibliotekę; nowsze/nieczytelne konfiguracje nie są nadpisywane |
| Steam | Dotychczasowe sprawdzone wykrywanie, Big Picture, walidowane ID i uruchamianie; nowe kolekcje | Nie zmieniano Steam Input ani ustawień konta |
| Playnite | Zachowana biblioteka/okładki/manifest i istniejący eksporter SDK 6.18.0 dla Playnite 10 | Nowe kolekcje Steam pozostają oddzielne; brak twierdzenia o Playnite 11 |
| TV Mode | Lista rzeczywistych monitorów Tauri; zapamiętany niejawny identyfikator; wybór ekranu i fullscreen tylko dla okna VELORA | Nie zgaduje HDMI ani numeru Panasonica; zmiana geometrii może wymagać ponownego wyboru |
| Powrót okna TV | Istniejący obserwator ekranów przy starcie/zmianie; utrata wybranego ekranu daje okno na głównym monitorze | Bez zmiany topologii, HDR, rozdzielczości lub domyślnego audio Windows |
| Autostart | Zachowany jawny przełącznik HKCU bieżącego użytkownika; stan/błędy/wyłączenie | Nie włączono podczas prac |
| Recovery | Istniejące single-instance i metadane czystego zamknięcia; nowe lokalne exit/restart; `--windowed` wygrywa z TV | Bez watchdog, usługi, wymiany Explorer lub pętli restartów |
| Diagnostyka | Wersja/SHA, sesje, własność okien, kontroler, audio/ekrany i błędy; bezpieczne booleany/liczba urządzeń pilota | Eksport rozszerzono o redakcję wzorców credentials, URL i adresów sieciowych |
| Regresje | Claude Usage i adapter, 24h, Zabrze, launchery, Home/supervisor oraz Credential Manager zachowano | Automatyczne regresje nie są dowodem live widgetu lub sprzętu |

## Bezpieczeństwo

Niezależny przegląd źródeł: **SOURCE REVIEW PASS**, bez nierozwiązanego problemu krytycznego lub wysokiego ryzyka. Wykryto i poprawiono obejście DOM uprawnień: `data-remote-admin` zawsze wygrywa, również wewnątrz szerokiego `data-remote-allow`. Naprawiono także dostarczanie nowych zasobów przez stary cache PWA.

Zachowano CSP, ograniczoną listę oficjalnych URL, dokładną własność okien i procesów, ograniczone IPC, HTTPS/HMAC/replay protection, Windows Credential Manager i brak nieautoryzowanego LAN endpointu. Komendy restart/exit nie przyjmują programu lub ścieżki. Audio wymaga identyfikatora obserwowanego wyjścia. TV rozwiązuje ID wyłącznie w aktualnie wyliczonych monitorach. Publiczne dokumenty nie zawierają lokalnego raportu maszyny, tokenów ani prywatnych danych sesji.

Ryzyka pozostałe: rzeczywiste TLS/vault/Windows foreground/UIPI nie są udowodnione przeglądem źródeł. Dwie karty PWA używające jednego credential mogą ścigać się o sekwencję; serwer odrzuca konflikt, ale może być potrzebne ponowne parowanie. Hash artefaktu nie jest podpisem kodu. Sanitizer nie jest uniwersalnym detektorem każdego możliwego sekretu; nowe błędy pozostają ustalonymi komunikatami.

## Testy lokalne

| Sprawdzenie końcowego kodu | Wynik |
| --- | --- |
| Vitest | **924 PASS**, 104 pliki |
| TypeScript i produkcyjny frontend | PASS |
| Pełny Rust w sandboxie | **392 PASS /31 FAIL /2 ignored**; błędy Windows Credential Manager |
| Dostępny zakres Rust | **384 PASS /0 FAIL /2 ignored /39 filtered**; 37 remote-vault +2 Credential Store jawnie wyłączone |
| Provenance i adapter Claude | **37 PASS** (31+6) |
| Clippy all targets | PASS z odziedziczonymi ostrzeżeniami |
| rustfmt zmienionych modułów | PASS |
| rustfmt całego crate | Odziedziczone różnice w niepowiązanych plikach; nie ogłoszono PASS |
| Whitespace całego zakresu S2.0 → kandydat | PASS |
| Lokalny Playnite C# | BLOCKED: obecny runtime .NET bez SDK; CI sprawdza osobno |
| Debug no-bundle z czystego źródła | PASS |
| Lokalny NSIS | BLOCKED: terminal nie pobiera NSIS 3.13 z powodu DNS; instalator buduje CI |

Pierwszy pełny Rust na bazie zanotował dodatkowy błąd linkera w zbyt długim katalogu tymczasowym sandboxa. Krótszy zewnętrzny TMP rozwiązał ten błąd; katalog TMP wewnątrz repo powodował inny test wykrywania metadanych Git, więc zastosowano ścieżkę poza repozytorium. Błędów Credential Manager nie maskowano jako zaliczonych. Poprawiono też wykryte w integracji: typ zwrotny zapisu TV, podgląd audio, oczekiwania zakładki Sesje i rewizji cache.

## Computer Use i fizyczny sprzęt

**CU-01–CU-20: BLOCKED.** Inicjalizacja udokumentowanego `@oai/sky` działa, ale `list_apps()` kończy się `failed to launch codex app-server: program not found`. Nie instalowano zastępczego helpera ani nie omijano zabezpieczeń. Pełna macierz jest w `velora-2-grand-computer-use-results.md`.

Dodatkowa diagnostyka środowiska potwierdziła załadowany pakiet Sky i target `windows`; `Get-Command codex,codex.exe` nie znalazło komendy w dostępnym PATH tej sesji. To nie dowodzi braku aplikacji na całej maszynie ani przyczyny każdego błędu hosta. Nie zmieniano globalnego PATH i nie uruchamiano własnego protokołu helpera.

**PHYSICAL HARDWARE VERIFIED: brak.** Nadal do późniejszej akceptacji: PS+Options, osobno fallback Home, Netflix → Home → YouTube, Steam/Playnite → Home, duplikacja, Bluetooth reconnect, dziesięć powrotów, fizyczny iPhone i Panasonic HDMI/audio. Nie proszono o podłączanie pada podczas tej fazy.

## Wydajność

Nie zmierzono wiarygodnie startupu UI, idle CPU/RAM, opóźnień przełączenia, audio, pilota lub nadzoru kontrolera na pracującym kandydacie. Nie podano fikcyjnych benchmarków. Produkcyjny frontend w lokalnym logu ma główny JS około 423 kB (gzip około 128 kB) i CSS około 60 kB (gzip około 14 kB); jest to rozmiar buildu, nie pomiar runtime. Nowe panele nie dodają stałego timera; sesje korzystają z istniejących zdarzeń, TV z istniejącego obserwatora, a kolekcje są ograniczone.

## Git i artefakt debug

| Etap | Gałąź / PR / SHA |
| --- | --- |
| Zachowana baza S2.0 | Draft #58; `05f7235bb4680df03f9147bad055bb542cd6524e` |
| S2.1 | `feature/velora-2-s2-1-living-room-experience`; https://github.com/Milklosz/nexus-aurea/pull/59; `89886f079fe4bbcb0e47b9940fc6fab52046bd5d` |
| S2.2 | `feature/velora-2-s2-2-gaming-tv-integration`; https://github.com/Milklosz/nexus-aurea/pull/60; `f232ea698adf3e15003a167f032543a61f26324e` |
| Zintegrowany kod | `integration/velora-2-grand-living-room`; `f232ea698adf3e15003a167f032543a61f26324e` |
| Dowody po budowie | `docs/velora-2-grand-final-evidence`; osobny commit dokumentacji, bez zmiany zamrożonego kandydata |

Debug: `VELORA-0.10.0-rc.1-debug.exe`, **27 429 376 bajtów**, SHA-256 `0979e3f5e0c7ecc2bbce8340898f73cbce777673afc2de3264179be90614b71a`. ProductVersion odczytany z PE: `0.10.0-rc.1`. Manifest sprawdza czysty checkout i obecność źródłowego SHA w PE. To lokalny zapis integralności, nie podpis lub certyfikat CI. Plik nie był instalowany ani użyty jako dowód live UI.

Eksporter Playnite z push CI tego samego SHA pobrano i zweryfikowano: ZIP **8042 bajty**, SHA-256 `763339b1466f6bcacb4e0da002844fde8bead1d0bdf43ae7f71885dbb1995c56`; zawiera `extension.yaml` i `VeloraLibraryExporter.dll` 16 384 bajty. Nie instalowano rozszerzenia.

## Rollback i następny etap

Dotychczasowa instalacja z metadanymi 0.9.2 pozostała niezmieniona. Wariant debug współdzieli tożsamość aplikacji, single-instance i dane z instalacją — nie jest nowym profilem. Do zatwierdzonych później testów zamknąć dotychczasową VELORA normalnie i uruchomić kandydata z `--windowed`. Powrót bez instalowania: zamknąć kandydata i otworzyć dotychczasową aplikację. Nie kasować ustawień ani profili przeglądarki.

Przed przyszłym, osobno zatwierdzonym upgrade zachować poprzedni instalator i uzgodnioną lokalną kopię konfiguracji. Instalator zachowuje `pl.nexus.aurea`, `nexus-aurea.exe`, tryb current-user i dotychczasowy upgrade hook; nie włącza autostartu ani nie zastępuje Explorer. Rollback po upgrade wymaga wcześniejszego instalatora; nie używać opcji usuwania danych użytkownika.

Następny etap: przywrócić hostowy Computer Use i przejść CU-01–20 na konkretnym SHA, najpierw bez pada. Potem osobna akceptacja DS4/iPhone/HDMI. Brama stabilna pozostaje zamknięta do tych dowodów. Otwarte funkcjonalne ograniczenia obejmują brak nowego touchpada pilota, brak stałej subskrypcji zmian domyślnego audio, oddzielne kolekcje Steam/Playnite i brak automatycznego watchdog. Te punkty nie są przedstawiane jako ukończone.

Projekcja sesji nie dodaje osobnych pól `launchMethod`, rzeczywistego `lastActivation` ani wierszy aplikacji „not running”; `lastObservedAtMs` jest czasem obserwacji. TV panel nie przedstawia odświeżania ani potwierdzonego typu HDMI; dotychczasowa diagnostyka zawiera częstotliwość odświeżania zgłoszoną przez Windows. Także te elementy specyfikacji wymagają dalszej implementacji, a nie samego testu fizycznego.
