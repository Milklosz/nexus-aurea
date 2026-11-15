# Claude Usage Widget — S1.2

Stan: zaimplementowany lokalny adapter oficjalnego status line, cache, parser i UI. Automatyczny
samodzielny eksport interaktywnego /usage nie został znaleziony. Rzeczywiste limity można odczytać
po ręcznym podłączeniu skryptu do własnej sesji Claude Code i pierwszej normalnej odpowiedzi API.
**Konfiguracji użytkownika nie zmieniono; rzeczywistego payloadu konta w tym sprincie nie pobrano.**
Nie należy przedstawiać wdrożenia jako już aktywnego licznika na tym komputerze.

## Discovery (Windows, 2026-11-15)

Lokalne claude --version: 2.1.322. Sprawdzono --help, auth status --help i oficjalne auth status --json.
Z diagnostyki zachowano tylko loggedIn=true oraz authMethod=claude.ai, bez emaila lub surowych odpowiedzi.
Nie wykonano claude /usage, claude -p /usage, promptu modelowego, otwarcia/przejęcia sesji ani prywatnego endpointu.

Oficjalne źródła:
- [CLI reference](https://code.claude.com/docs/en/cli-reference): --print jest trybem zapytania; auth status ma JSON/kody0/1. Brak samodzielnego eksportu limitów /usage.
- [Commands](https://code.claude.com/docs/en/commands): /usage działa wewnątrz sesji; obejmuje plan, koszt i statystyki. To różne pojęcia.
- [Status line / rate limit usage](https://code.claude.com/docs/en/statusline#rate-limit-usage): oficjalne rate_limits.five_hour oraz seven_day, used_percentage i resets_at (epoch seconds), po pierwszej odpowiedzi API dla obsługiwanej subskrypcji. Każde okno może być niezależnie nieobecne.

Wspierany kontrakt status line jest wybranym źródłem strukturalnym. Tekstowe scraping TUI nie jest potrzebne.
Status line nie udostępnia w tym kontrakcie dowolnych limitów modelowych /usage, np. Fable; takich danych
nie tworzymy. Parser tekstu i fixture 0/79/19 pozostają testową, niepodłączoną do live granicą przyszłego adaptera.

## Ręczne podłączenie bez zmiany globalnych ustawień

Przygotowany lokalnie (gitignored) plik work/claude-statusline-settings.json wskazuje wyłącznie
scripts/claude-usage-statusline.mjs w tym checkout. Jego treść można obejrzeć przed użyciem.
W nowym, samodzielnie otwartym terminalu uruchomić:

~~~powershell
claude --settings "C:\Users\milos\velora-s1-1-sprint\work\claude-statusline-settings.json"
~~~

Jest to ustawienie **tej sesji**, a nie edycja ~/.claude/settings.json. Użytkownik może zamiast tego ręcznie
połączyć statusLine ze swoją konfiguracją, ale sprint tego nie robi. Przy innej lokalizacji repo należy
zmienić absolutną ścieżkę skryptu w tym lokalnym pliku. Potrzebny jest dostępny node.

Skorzystać z Claude Code normalnie. Po pierwszej odpowiedzi API CLI może przekazać rate_limits do skryptu.
Nie wysyłać dodatkowego promptu tylko na potrzeby VELORY. Bez danych widżet mówi „Uruchom Claude Code
z integracją status line i wykonaj pierwsze zapytanie”, zamiast pokazywać zero. Dopóki brak payloadu,
nie da się wnioskować, czy limit wynosi 0%, czy CLI nie przekazało danych.

Skrypt zapisuje %LOCALAPPDATA%/VELORA/claude-usage.json. VELORA odczytuje tylko tę stałą ścieżkę.
Odświeżyć ręcznie po upływie co najmniej minutowego gate lub poczekać na automatyczny odczyt.
Brakujące/nieobsługiwane okna są pomijane. Wartość 0% jest prawdziwą wartością tylko wtedy, gdy przyszła ze źródła.

## Koszt i prywatność

Sam adapter jest lokalnym skryptem stdin→whitelist→plik: nie wywołuje modelu, sieci ani endpointów i nie zużywa
dodatkowych tokenów. Normalne zapytanie użytkownika do Claude Code ma swoje zwykłe zużycie; VELORA go nie uruchamia.
Nie zmierzono liczników realnego konta i nie badano automatycznie kosztu samego interaktywnego /usage.

Payload status line może zawierać ścieżki transcript/workspace i identyfikatory sesji. Nie zapisujemy ani nie logujemy
całego payloadu. Skrypt przyjmuje maks.256KiB, wyciąga tylko pięciogodzinne/tygodniowe procenty, reset i wersję CLI.
Nie zapisuje kosztów, tokenów, modelowych statystyk ani pól innych dostawców. Wynik ma schemaVersion=1,
source=claude-code-statusline, capturedAt, sourceVersion i rateLimits. Plik powstaje przez ekskluzywny temp,
write+sync+rename, z ograniczonymi prawami przy tworzeniu. Tymczasowe pliki są sprzątane.
Obie postaci UNC (\\server oraz //server) są odrzucane. Nie udostępniamy ścieżki/programu/argumentów frontendowi.

## Backend i model

ClaudeUsageService działa w Rust poza wątkiem UI przez spawn_blocking. Jedyna komenda Tauri:
get_claude_usage { manual: boolean }. Nie dodano shell plugin ani szerokich capability. Dane zostają lokalnie.

Pierwszeństwo ma stały lokalny plik status line: regularny plik, bez symlinka, maks.32KiB, walidacja schematu,
procentów0–100, dat, wersji oraz dopuszczalnego czasu przechwycenia. Nieznane prywatne pola nie są akceptowane.
Gdy pliku nie ma, backend sprawdza oficjalne --version/auth status, aby rozróżnić brak CLI/logowania/timeout.
Zalogowany CLI bez pliku daje awaitingUsage. Te diagnostyczne procesy mają stałe argumenty, stdin zamknięty,
stderr odrzucony i stdout ograniczony do32KiB. Nie uruchamiamy PowerShell/cmd ani komend z frontendu.

Każdy proces diagnostyczny ma limit4s. Nieblokujący PeekNamedPipe / Unix fd eliminuje readerthreads.
Windows uruchamia własny proces jako CREATE_SUSPENDED, przypisuje Job Object kill-on-close, potem wznawia
wyłącznie jedyny pierwotny wątek nowego procesu. Nie otwiera ani nie zamyka cudzych sesji. RAII kończy/reapuje
własne drzewo procesów, także na błędzie; Unix korzysta z własnej grupy procesów. Nie ma hooków ani wstrzykiwania.
Brak możliwości ustanowienia kontroli procesu kończy się błędem. Sam CLI może komunikować się ze swoją usługą
w ramach auth status; bez sieci pozostaje jawny error/timeout, bez logowania surowej odpowiedzi.

Model UI: source=claude-code, fetchedAt, status available/stale/unavailable, limits[], sourceVersion,
stale, refreshing, errorCode, automaticUsageSupported. Limit: id/label/usedPercent oraz opcjonalne
resetAt/resetTimezone/resetText. capturedAt/fetchedAt oznacza **czas lokalnego przechwycenia payloadu**,
a nie gwarantowany moment pobrania limitu z serwera Claude. UI Updated prezentuje ten czas uczciwie.

## Cache, reset i odświeżanie

Cache ostatniego poprawnego wyniku w RAM, bez logów konta. Pierwszy odczyt nie blokuje Home.
Bezpieczny adapter pliku jest odświeżany co15min; manualny gate co najmniej1min. Błędy mają backoff1/2/4/8/15min,
również dla ręcznych prób; brak agresywnych retry i równoległych odczytów. Konkurent dostaje snapshot z refreshing.
Nie zmieniamy fetchedAt na czas samego odczytu pliku. Stary payload pozostaje stale po15min albo po resetAt.
Wygaśnięcie resetu oznacza stale także w otwartym widżecie, przez lokalny timer bez dodatkowego procesu/zapytania.
Backend nie trzyma sukcesu w TTL po resecie; po minutowym gate wolno ponownie odczytać plik. Nie przywraca zużycia do0.

resets_at jest epoch seconds, konwertowanym do RFC3339; Intl prezentuje Europe/Warsaw z prawidłowym CET/CEST.
Tekstowa fixture Nov18,2:59pm nie ma roku: parser nie zgaduje resetAt, tylko zachowuje resetText/strefę.
Parser tekstowy obsługuje ANSI, odstępy, długość paska i zmienne nagłówki Current ...; błędny/niepełny
format, duplikaty, przypadkowe liczby i wartości poza zakresem dają parserIncompatible.

## UI i kontroler

Kompaktowy element systemowego paska Cinema Minimal, rozwinięcie i cienkie paski tylko rzeczywistych kategorii.
Nawigacja lewo/prawo, Cross/Enter, Circle/Escape i powrót focusu korzystają z istniejącego routingu Home.
Nie zmieniono mapowania Cross/Circle. Aktualizacja, reset i timer nie ustawiają focusu. Odświeżanie pozostaje
osiągalne także przy przewijanym panelu. Stany loading/available/stale/brakCLI/braklogowania/awaitingUsage/
unavailable/parser/timeout/manualrefresh są jawne. Stan cache zawsze pokazuje czas ostatniego payloadu.

## Diagnostyka i testy

Sprawdzić Get-Command claude, claude --version, claude auth status --text i własne /usage.
Sprawdzić absolutną ścieżkę skryptu, dostępność node i pliku lokalnego, bez kopiowania payloadu sesji do issue.
Do zgłoszenia wystarczy sourceVersion, errorCode, czas i SHA VELORY. Nie publikować tokenów/auth status JSON.

CI korzysta wyłącznie z fixtures/mocków. Testy obejmują tekstowy przykład, JSON status line, brak/wygaśnięcie
okien, zerowe wartości, sanitizację prywatnych pól, obie postaci UNC, atomicwrite, cache/stale/reset,
konkurencję, timeout z zabiciem własnych potomków oraz UI/focus. Końcowe wyniki: velora-2-sprint-verification.md.
