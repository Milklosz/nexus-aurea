# VELORA S2.3 — raport inżynierski

Data walidacji: **17 listopada 2026**. Kandydat **0.11.0-rc.1** dostarcza wspólny natywny router, cztery tryby nawigacji, pięć profili i symulator używający rzeczywistego toru wejścia. Testy automatyczne i CI przeszły. Computer Use potwierdziło konkretne interakcje w Windows, w tym pełny ekran i pauzę odtwarzacza YouTube podczas reklamy. **Nie potwierdzono pełnej obsługi pięciu serwisów z kanapy.** Nawigacja przestrzenna na sprawdzonej stronie YouTube nie znalazła kontrolki w budżecie; katalogi chronione i fizyczny DS4 pozostają otwarte.

Stosowane poziomy dowodu: **Implemented** oznacza istniejącą implementację; **Automated Tested** — wykonane testy automatyczne; **Computer Use Verified** — zaobserwowany efekt w aplikacji; **Physical Hardware Verified** — rzeczywisty test kontrolera, którego obecnie brak; **Blocked** — rzeczywistą zależność zewnętrzną. Brak obserwacji oznacza **Not Tested**, a nie Blocked ani Pass.

## 1. Początkowy stan repozytorium

Właściwe repozytorium: `C:\Users\milos\velora-s1-1-sprint\work\grand`. Początkowy czysty HEAD ec8d185 dodawał dokumentację akceptacji po integracji a7c53b3034fe00b6fa0c76ff6d4fe5f332c0c5ea (0.10.0-rc.2). Gałąź S2.3 powstała bezpośrednio z a7c53b3. PR #58–#61 zostały zweryfikowane jako otwarte Draft i niezmienione. Zewnętrzne repozytorium w katalogu nadrzędnym, istniejące dane i instalacja nie były zastępowane. Szczegóły: [audyt](velora-2-s2-3-navigation-audit.md).

## 2. Końcowy commit źródłowy

**cc24affd970b3f4fb478f58f1dceb218708f7753** jest commitem implementacji zawartym w testowanym debug EXE i manifestach CI. Późniejszy commit dowodowy zmienia dokumentację, nie kod aplikacji. Numer wersji React/Cargo: **0.11.0-rc.1**. CI PR budowało checkout 7cf56b3a54133c5795b414af8cb7d68660c73a98, czyli syntetyczny merge tego head z bazą a7c53b3; te identyfikatory są jawnie rozróżnione.

## 3. Gałąź i Draft PR

Gałąź: `feature/velora-2-s2-3-native-tv-experience`. [Draft PR #62](https://github.com/Milklosz/nexus-aurea/pull/62), baza `codex/velora-grand-living-room-validation`. Brak merge, force push, tagu i publikacji stabilnego wydania. [Przebieg CI źródła](https://github.com/Milklosz/nexus-aurea/actions/runs/44054094533) zakończył Windows, macOS i Playnite sukcesem; publikacja Release została pominięta.

## 4. Architektura

Zachowano PadHub, Controller Supervisor, istniejący worker streamingu, LaunchRegistry i mechanizm Home. `streaming_control` obsługuje normalizację, arbitraż, generacje, wybraną strategię i wspólne wysyłanie. `tv_navigation` przechowuje zamknięty kontrakt i wersjonowane profile, `spatial_navigation` — wspierane Windows UI Automation. React udostępnia ustawienia i lokalny symulator. Nie powstał drugi konkurujący system fizycznego wejścia. [Architektura](velora-2-s2-3-navigation-architecture.md).

## 5. Tor kontrolera

Znormalizowana akcja zawiera źródło, typ, czas monotoniczny, generacje, opcjonalną zahaszowaną tożsamość kontrolera, repeat, cel i decyzję routingu. Kolejka ma osiem elementów; raporty stare o ponad 200 ms są odrzucane. Próbkowanie: 33 ms, pierwsze powtórzenie 320 ms, następne 160 ms z przyspieszeniem do 110 ms. Martwe strefy są wewnętrznymi stałymi 0.35/0.25. Zmiana konfiguracji/kontrolera/celu i przepełnienie unieważniają stare wejście. Symulator ma pojedynczą aktywną akcję i rosnącą sekwencję; nie dziedziczy przytrzymanego fizycznego wejścia.

X potwierdza lub klika we wskaźniku, Circle wraca, Square przełącza odtwarzanie po uzbrojeniu, Triangle zmienia wskaźnik, prawy analog przewija/przesuwa, Options po czystym zwolnieniu otwiera CC. L1/R1 pozostają zarezerwowane dla dotychczasowego zastępczego Home; touchpad daje następny fokus. Gest PS+Options i wybrany gest zastępczy zachowano. [Mapowanie](velora-2-s2-3-controller-mapping.md).

## 6. Nawigacja przestrzenna

Implemented / Automated Tested: geometryczny wybór kierunku, widoczność, aktywność, focusability, granice, modalne pochodzenie, aktualna tożsamość okna, SetFocus i Invoke z ponowną autoryzacją. CUIAutomation8 pracuje na workerze MTA; 256 węzłów, głębokość 32, budżet odkrywania 40 ms, akcji 250 ms, cache 500 ms. Budżety są kooperacyjne; synchroniczny provider może je przekroczyć. Nie odczytujemy nazw, wartości, tekstu, URL ani haseł.

Computer Use: kierunek Down w YouTube został bezpiecznie odrzucony, ponieważ nie znaleziono odpowiedniej kontrolki w budżecie. Brak zaobserwowanego skutecznego przesunięcia UIA. Nie ma automatycznego ponownego kliknięcia, własnego overlay fokusu przestrzennego ani automatycznego przewijania list wirtualnych. [Opis i granice](velora-2-s2-3-spatial-navigation.md).

## 7. Wskaźnik

Implemented / Automated Tested: ograniczony ruch i przyspieszenie, dead zone, granice klienta, współrzędne virtual desktop także dla ujemnych monitorów, sprawdzenie trafionego własnego okna przed kliknięciem/wheel, niezależność nieaktywnego kontrolera. Symulator pamięta pozycję na workerze według dokładnego celu i generacji; kliknięcia w przyciski testowe nie nadpisują tej pozycji. Pierwszy ruch ustawia punkt w środku własnego klienta. CU potwierdziło +32 w YouTube oraz w publicznym Netflix: odmowę Confirm przed Move, akceptację jawnego kliknięcia w sprawdzony pusty obszar, widoczny scroll i drugi ruch do center +64 mimo powrotu do GUI. Puste kliknięcie nie daje osobnego potwierdzenia efektu strony. Dodatkowa lista receipts zniknęła przy odziedziczonym Home po zamknięciu celu; nie jest dopisywana do wcześniejszego eksportu. Rzeczywista płynność analogowa, DPI i drugi ekran wymagają osobnego testu.

## 8. Netflix

Profil v1: keyboard, jawny spatial/pointer; Space, strzałki seek, F oraz obsługiwane skróty odtwarzacza zależą od uzbrojenia i fokusu poza edycją. Publiczna polska strona otwiera się w zarządzanym oknie. Chroniony katalog, profile, wybór filmu, wyszukiwanie i odtwarzanie: **Blocked — brak zalogowanej sesji**. Publiczny landing nie jest dowodem zgodności katalogu.

## 9. YouTube

Używany jest wspierany desktop, bez spoofingu UA i bez założenia, że endpoint TV działa na Windows. K/J/L/F/M/C według jawnej listy. Publiczne wyszukiwanie i wybór wyniku przygotowano zwykłym Computer Use, nie kontrolerem. Symulator wykonał ruch wskaźnika, fullscreen i pauzę/wznowienie rzeczywistego playera w preroll; to wąskie **Computer Use Verified**. Nie omijano reklam. Główna transmisja, seek i pełne sterowanie katalogiem nie mają osobnego potwierdzenia. Spatial: faktyczna bezpieczna odmowa.

## 10. Disney+

Profil v1 zawiera wspólne keyboard/UIA/pointer oraz jawne ograniczenia. Nie wymyślono dedykowanych skrótów playback. Publiczna strona polska została otwarta; chroniony katalog, profile i playback: **Blocked — konto/subskrypcja**. Zgodność kontrolek odtwarzacza wymaga testu w legalnej zalogowanej sesji.

## 11. Max

Profil v1 opisuje fokus klawiatury, UIA, wskaźnik i ostrożny Back. Dedykowane skróty medialne są Unsupported. Publiczny adres przekierował do polskiego HBO Max. Przeglądarkowy komunikat profilu i cookie dialog ograniczyły test; nie zmieniano synchronizacji ani prywatności. Katalog/playback pozostają Blocked, nie Pass.

## 12. Prime Video

Profil v1: keyboard/UIA/pointer, Space, strzałki, F/M/C w kontekście uzbrojonego odtwarzacza. Publiczny polski ekran i kontrolka wyszukiwania zostały zaobserwowane. Chronione treści/playback wymagają konta i członkostwa. Nie wykonano zakupu, wypożyczenia, rejestracji ani testu płatności.

## 13. Media

Jedna metoda na akcję: zamknięta lista klawiszy danego profilu, jawne uzbrojenie konkretnej własnej sesji, blokada przy UIA edit/password/combobox lub błędzie rozpoznania. Brak uzbrojenia nie oznacza automatycznej próby innych skrótów. Windows volume/mute to osobne jawne Core Audio z odczytem endpointu. Generyczny GSMTC current session nie dowodzi własności konkretnego okna przeglądarki, dlatego nie jest uniwersalnym celem. Osobne absolutne Play/Pause bez pewnego stanu nie są implementowane jako ślepy toggle. Receipt accepted pozostaje effectUnverified; skuteczność strony wymaga obserwacji.

## 14. Własność okien

Cel musi pochodzić z zarządzanej sesji Cinema i odpowiadać HWND, PID oraz czasowi utworzenia procesu. Sam `msedge.exe` nie wystarcza. Ponowne sprawdzenie przed wysłaniem, generacje i pinning ograniczają stare cele. Celowe przywrócenie symulatora jest dozwolone z lokalnego VELORA lub dokładnego celu; obcy foreground odrzuca akcję. Computer Use potwierdziło tę odmowę na pustym Paint przed wywołaniem native. Pozostaje nieusuwalny atomowo wyścig między ostatnim sprawdzeniem a SendInput/UIA; brak obchodzenia UIPI.

## 15. Controller Simulator

Debug-only po stronie Rust, lokalny main WebView o dokładnym dozwolonym origin, explicit enable/target/mode, opóźnienie 600 ms na zwolnienie myszy, jedna akcja w locie, cancel/generation, maksymalnie 16 kroków i 64 receipts. Bezpieczny wbudowany scenariusz nie ma Confirm ani click. Sterowanie administracyjne odrzuca wybór z LAN. Eksport JSON zawiera tylko dozwolone pola/kody/publiczne service IDs; nie zawiera surowych błędów, URL, tytułów, sesji ani danych strony. Eksport został odczytany w prawdziwym UI. [Symulator](velora-2-s2-3-controller-simulator.md).

## 16. Testy automatyczne

Lokalnie: **961 testów Vitest / 108 plików PASS**, TypeScript i Vite build PASS; Windows Rust **443 PASS, 0 FAIL, 2 ignored, 0 filtered**; adapter Claude + provenance **37 PASS**. Focused router 16, spatial 5, profile 3. Clippy all targets PASS z odziedziczonymi ostrzeżeniami. Formatowanie dotkniętych modułów i git diff --check PASS; whole-crate fmt ma ten sam odziedziczony drift co baza.

Bazowy Vitest: 946/105 PASS. Izolowany bazowy Rust w sandboxie: 397 PASS/32 FAIL/2 ignored — 31 błędów Credential Manager, jeden linker/temp. Pierwsza pełna próba poza sandboxem miała fixture bez-Git uruchomiony w temp wewnątrz nadrzędnego Git; użycie zwykłego zewnętrznego TEMP dało poprawny końcowy run. Te nieudane próby nie są przedstawiane jako sukces. Lokalny Playnite był niedostępny bez .NET SDK; CI Playnite przeszedł. Windows/macOS CI test/check/build PASS.

## 17. Computer Use

20 scenariuszy, wyniki i dokładny zakres: [raport CU](velora-2-s2-3-computer-use-results.md). Rzeczywiście użyto Windows API narzędzia, nie mocków ani wywołania IPC z terminala. Sprawdzono czysty build, pięć publicznych usług, lokalny symulator, wybrane efekty, granicę obcego fokusu, Home, eksport i restart. Oczekiwane skutki nie są wywodzone wyłącznie z accepted. Testy fizycznego pada nie były symulowane jako zaliczone.

## 18. Macierz zgodności

[Macierz per usługa i akcja](velora-2-s2-3-compatibility-matrix.md) oddziela istniejący adapter od faktycznej obserwacji i konta. Żadna usługa nie otrzymuje deklaracji pełnej fizycznej zgodności. Szczególnie UIA, wyszukiwanie tekstowe i katalogi wymagają dalszej akceptacji.

## 19. Wydajność

Próbka głównego procesu debug (5 s, YouTube foreground): 0.125 s CPU, czyli 2.5% jednego logicznego rdzenia; working set 56,057,856 B, private 10,231,808 B, 36 wątków. Bez procesów WebView2/Edge, bez gwarancji całego systemu lub builda release. Pięć zaakceptowanych receipts: 23/24/53/119/115 ms, mediana 53, max 119; nie obejmuje 600 ms opóźnienia UI i nie mierzy DS4. Pomiary UIA na ścieżce błędu są niepełne. [Metoda i ograniczenia](velora-2-s2-3-performance.md).

## 20. Bezpieczeństwo

Weryfikowano zakres IPC, origin, debug gate, ownership, generacje, replay, cancel, bounded work, media arm, UIA scope i eksport. W trakcie review poprawiono m.in. ponowne blokowanie mutexa, zbyt szerokie localhost, pinning/generation, main-thread blocking, cache pozycji wskaźnika, timing i pojedynczy dispatch. Nie znaleziono krytycznego nierozwiązanego problemu w ocenianym zakresie; nie jest to certyfikacja bezpieczeństwa. [Review i residual risks](velora-2-s2-3-security-review.md). Nie użyto DRM bypass, injection do procesu odtwarzania, drivera, hooka, modyfikacji przeglądarki czy podniesienia uprawnień aplikacji.

## 21. Regresje

Testy React/Rust obejmują istniejące moduły, a CI również Playnite/macOS. W UI obserwowano Home/Cinema, clock/weather, Claude Usage stale, CC, managed sessions i restart. Nie potwierdzono na żywo iPhone LAN (pilot wyłączony, zero sparowanych urządzeń), Steam/Playnite grania, fizycznego TV, audio JBL ani realnych padów. Wcześniejsze dowody rc.2 nie są zaliczeniem rc.1 S2.3. Instalacja 0.9.2 pozostaje niezmieniona.

## 22. Artefakty

Instalator z CI: `outputs/s2-3-ci-windows/VELORA_0.11.0-rc.1_x64-setup.exe` i sąsiedni `velora-build-provenance.json`. Rozmiar 4,584,876 B. Debug z symulatorem: `outputs/s2-3-cc24aff/nexus-aurea.exe`, 27,858,944 B, wraz z manifestem integralności. Paczka przekazania ma osobny README i sumy. Instalator nie został uruchomiony. Authenticode: unsigned; manifest i SHA nie są podpisem. Lokalny verify-release --preview PASS dla spójności, bez niezależnego potwierdzenia origin CI. CI zweryfikowało relację pliku build/payload przez dokładnie przewidzianą zmianę znacznika NSIS.

## 23. Hashe

| Plik / identyfikator | SHA-256 |
| --- | --- |
| Instalator | 27f138faaa3ba2d9b155c6d0a3941a41f8979617a97d7db7c28578636ea60012 |
| Debug EXE | 0024ea2708ad7149e1b1be19b09d413b82c365e1ce88a72a5992f34f83274ba9 |
| Debug ZIP z manifestem i README | e38aa45d834ed1b10aa2ea8efc70915f1c98978963cf13e01240fa9c37707aaa |
| CI built release EXE (manifest, niepobrany osobno) | eceada81c9ec4159ca192593b0f4ad1d6962332d4c1a76c52edc346aa22c54a9 |
| CI packaged release EXE (manifest) | 61d9cdb280e3070cd4296b51c4f8c8ce1594d8785963f33c95dd80cbd32ff1cc |
| GitHub artifact ZIP digest, ID 14314773093 | 6af2329db5193acf6042a87d16fe6b04c329e1268f25a848731c9eb24f906536 |
| Niezmieniona instalacja 0.9.2, przed i po próbach | d702baf99b9e640c70d96ea0ed01306dac63482356826dfccdd7958ae1eee51f |

Artefakt GitHub wygasa 2026-12-17; lokalna kopia została zachowana. [Kopia manifestu CI](evidence/s2-3-ci-provenance.json). Różnica built/package jest jawną transformacją znacznika Tauri, nie twierdzeniem o identycznych plikach.

## 24. Znane ograniczenia

Brak pełnej pięcioserwisowej nawigacji katalogowej, tekstowego wyszukiwania bez klawiatury, adaptacyjnego capability detection w automatic, potwierdzonego UIA focus na sprawdzonej stronie, osobnego spatial overlay, wirtualnego scroll, absolutnego Play/Pause i pewnego powiązania browser GSMTC z HWND. Dedykowane Disney/Max media shortcuts są Unsupported. Provider UIA i SendInput mają residual races; diagnostyka błędu UIA nie zachowuje pełnych metryk. Długi panel diagnostyczny wymaga przewijania; wygoda fizycznego pada wymaga akceptacji. Debug CU nie dowodzi poprawności instalatora upgrade ani zgodności release runtime.

## 25. Fizyczne testy do wykonania

**Gate I: Blocked**, zgodnie z poleceniem bez wymagania podłączenia pada teraz. Na MSI: DS4 USB i Bluetooth, reconnect, drift/dead zone, przytrzymanie/powtórzenia, jednoczesny Gamepad API/Raw Input/Steam Input, brak dubli, PS+Options i istniejący fallback, X/Circle/Square/Triangle/Options, fokus po fullscreen/Alt-Tab, oba analogi, cancel, Home podczas problemu UIA, 1080p/DPI/drugi monitor, długa sesja i każde legalne konto usługi. Physical Hardware Verified pozostaje puste.

## 26. Rekomendacja i odwracalność

Zachować **Draft** jako kandydat do przeglądu i dalszej akceptacji. A/B są zaimplementowane i automatycznie sprawdzone; C ma rzeczywiste dowody CU; D ma testy i wąską próbę live; E/F pozostają częściowe; G ma zielone CI i ograniczony live; H ma review z opisanymi granicami; I jest Blocked. Nie rekomenduję stable ani deklaracji „każdy serwis działa już z DS4”. Następny etap: skuteczny UIA focus na reprezentatywnym widoku lub świadoma akceptacja manual pointer, pełna publiczna nawigacja YouTube, legalnie zalogowane katalogi/playback, potem fizyczna akceptacja na MSI. Są to otwarte części programu, nie twierdzenie o pełnej realizacji wszystkich scenariuszy.

Rollback: zamknąć testowy EXE i tylko utworzone okna usług normalnie; uruchomić dotychczasową instalację 0.9.2. Bez kasowania danych/profili, instalowania sterownika, zmiany autostartu, certyfikatów czy usług. Kandydat dzieli tożsamość danych i single-instance z instalacją, więc uruchamiać pojedynczo. Wykonane próby zostały zamknięte normalnie; hash instalacji jest zgodny. Nie wykonano instalacji, merge ani publikacji Release.
