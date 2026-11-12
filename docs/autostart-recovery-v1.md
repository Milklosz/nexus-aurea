# VELORA 1.0 — Autostart & Recovery 2.0 (diagnostyka, tylko do odczytu)

> **Status integracji (VELORA 1.0): WDROŻONE.** Diagnostyka i raport recovery są
> zarejestrowane w `generate_handler![...]`; nadal nie naprawiają wpisu
> automatycznie. Aktualny stan:
> [docs/velora-v1-integration.md](./velora-v1-integration.md).

Dokument opisuje rozszerzenie obszaru **D. Autostart & Recovery**. Rozszerzenie
jest **addytywne**: nie zmienia ani jednej istniejącej komendy, eksportu,
komunikatu błędu ani testu z `docs/autostart-v1.md`. Sekcja „Integracja (dla
integratora)" w `docs/autostart-v1.md` pozostaje **bez zmian** — nowe komendy są
już zarejestrowane w `src-tauri/src/lib.rs` w `generate_handler![...]`.

Cała nowa funkcjonalność jest **wyłącznie do odczytu**. Nie naprawia wpisu
automatycznie, nie wykonuje żadnego zapisu przy starcie aplikacji, przy montażu
panelu ani przy odczycie diagnostyki. Jedynym zapisem do systemu pozostaje
istniejący, opt-in `set_autostart_enabled`.

## Co dodano

### Rust (`src-tauri/src/autostart.rs`)

- `pub enum AutostartIssue` z wariantami: `MissingValue`, `MalformedCommand`,
  `ExecutablePathInvalid`, `ExecutableMissing`, `WrongExecutable`,
  `UnexpectedArguments`, `QueryFailed(String)`. Metody `code() -> &'static str`
  (stabilny kod camelCase) oraz `user_message() -> String` (czysty komunikat po
  polsku). Ładunek `QueryFailed` jest **tylko diagnozą wewnętrzną** i nigdy nie
  trafia do `user_message()`.
- Czyste, deterministyczne helpery (bez I/O, testowalne na macOS):
  - `validate_executable_path(path)` — walidacja ścieżki z wpisu,
  - `parse_command_value(value)` — parsowanie wartości REG_SZ → `(exe, windowed)`,
    czyli detektor **błędnego wpisu**,
  - `detect_issues(value, current_exe)` — analiza wpisu i wykrycie wpisu
    nieaktualnego (stale) po aktualizacji / przeniesieniu VELORA,
  - `is_healthy(issues)`, `recovery_message(issues)`, `now_timestamp()`,
    `issue_codes(issues)`.
- Dwa typy wynikowe (tylko `Serialize`, `rename_all = "camelCase"`):
  `AutostartDiagnostics` i `AutostartRecoveryReport`. Pole `issues` zawiera
  **wyłącznie kody** problemów — nigdy surowych ścieżek ani komunikatów systemu.
- Dwie nowe komendy Tauri (do zameldowania integratorowi):
  - `autostart::get_autostart_diagnostics` → invoke `get_autostart_diagnostics`,
  - `autostart::get_autostart_recovery` → invoke `get_autostart_recovery`.
- Wewnątrz `mod windows` dodano `pub(super) fn read_command_value()`, które
  odczytuje **aktualną** wartość `VELORA` wyłącznie przez istniejący, jawny
  `reg.exe query` (reużywa `value_line()` + `registry_query_arguments()`).

Obie komendy na systemach innych niż Windows zwracają bezpieczny, „niedostępny"
kształt (`windows: false`, `supported: false`, puste `issues`, czysty komunikat
polski). Komendy **nigdy** nie wywołują `reg.exe add` ani `reg.exe delete`.

### TypeScript (`src/services/autostart.ts`)

- Typy `AutostartDiagnostics`, `AutostartRecoveryReport` (lustro camelCase z Rust).
- Bezpieczne domyślne wartości dla podglądu WWW: `disabledAutostartDiagnostics`,
  `disabledAutostartRecovery` (bez `invoke`, bez wyjątku).
- `getAutostartDiagnostics()` / `getAutostartRecovery()` — wywołują odpowiednie
  komendy tylko w Tauri, z **ścisłą walidacją kształtu** odpowiedzi i bezpiecznym
  fallbackiem przy każdej nieprawidłowości lub odrzuceniu `invoke`.
- `autostartRecoveryMessage(report)` — czysty, polski komunikat dla użytkownika
  (bez wycieków surowych danych); `autostartDiagnosticsSummary(d)` — zwięzłe
  „Autostart: poprawny" / „Autostart: wykryto N problemów" dla **przyszłego UI**.
  `AutostartPanel.tsx` nie został zmieniony.

### Testy

- Nowy plik `src/__tests__/autostartDiagnostics.test.ts` (środowisko node,
  `vi.hoisted` + `vi.mock("@tauri-apps/api/core")`), oraz nowe, czyste testy
  jednostkowe w `#[cfg(test)] mod tests` w `autostart.rs`. Istniejące testy
  (277 JS + 38 Rust, w tym `no_hklm_winlogon_shell_or_cmd_appears_anywhere`)
  pozostają nienaruszone.

## Wykrywanie błędnego wpisu (invalid-entry detection)

`parse_command_value` parsuje wartość REG_SZ dokładnie w takiej postaci, w jakiej
zapisuje ją `autostart_command_value`: opcjonalny cudzysłów wokół ścieżki oraz
**opcjonalna, pojedyncza** flaga `--windowed` na końcu. Odrzuca:

- wstrzyknięte cudzysłowy, nowe linie i znaki sterujące,
- dodatkowe argumenty i nieznane parametry,
- nieujęte w cudzysłów ścieżki zawierające spacje,
- wielokrotne flagi.

`detect_issues` łączy parsowanie z walidacją ścieżki i porównaniem (bez
rozróżniania wielkości liter, z normalizacją separatorów) ścieżki z wpisu z
bieżącym `current_exe()`. Wynik to lista kodów problemów; brak wartości to
`MissingValue`, różna ścieżka to `WrongExecutable` (wpis nieaktualny).

`validate_executable_path` odrzuca: pustą ścieżkę, ścieżkę względną, cudzysłów,
nowe linie, znaki sterujące / NUL, `..`, metaznaki powłoki (`& | ^ % !`),
rozszerzenie inne niż `.exe` (bez rozróżniania wielkości liter) oraz długość
> 1024. Akceptuje poprawną, bezwzględną ścieżkę Windows, np.
`C:\Program Files\VELORA\velora.exe`. Walidacja jest czysta — nie sprawdza
istnienia pliku na dysku (to wymagałoby I/O); wariant `ExecutableMissing`
pozostaje zarezerwowany w kontrakcie.

## Tryb awaryjny `--windowed` (zachowanie)

Flaga `--windowed` (safe mode) jest w pełni zachowana: parser rozpoznaje
pojedynczą flagę na końcu wpisu, a `get_autostart_recovery` raportuje
`safe_mode` wykryty z argumentów procesu (`windowed_flag_present`). Diagnostyka
**nie usuwa, nie dopisuje ani nie zmienia** flagi — odczytuje ją wyłącznie do
celów informacyjnych. Flaga nadal jest zapisywana przy (ponownym) włączeniu
autostartu przez istniejący przełącznik opt-in.

## Bezpieczne wyłączenie

Wyłączenie autostartu nadal usuwa **dokładnie i wyłącznie** wartość `VELORA`
przez istniejące `reg.exe delete ... /v VELORA /f` (realizowane wyłącznie w
`windows::apply`, wywoływanym przez `set_autostart_enabled`). Nowe komendy
diagnostyczne nie mają dostępu do tej ścieżki zapisu.

## Odzyskiwanie po restarcie Windows / aktualizacji VELORA

Po restarcie systemu lub aktualizacji / przeniesieniu aplikacji wpis autostartu
może wskazywać na starą ścieżkę (`WrongExecutable`), mieć uszkodzoną postać lub
nieprawidłową ścieżkę. `get_autostart_recovery` **raportuje** taki stan
(`stale = true`) i zwraca czytelną instrukcję `recommended_action`.

> **Uwaga (uczciwość):** po restarcie Windows / aktualizacji VELORA system
> **TYLKO RAPORTUJE** nieaktualny wpis — **NIE naprawia go automatycznie**.
> Użytkownik odświeża wpis sam, wyłączając i włączając autostart ponownie
> istniejącym przełącznikiem opt-in. Nie ma żadnej automatycznej naprawy,
> samoczynnego zapisu ani cichej zmiany konfiguracji.

## Diagnostyka stanu i czytelne błędy

`get_autostart_diagnostics` zwraca: `windows`, `supported`, `healthy`,
`path_valid`, `command_valid`, `issues` (kody), `last_error` (zsanitowany) oraz
`checked_at`. Wszystkie komunikaty (`user_message`, `recovery_message`,
`autostartRecoveryMessage`) są czyste i po polsku: bez surowych ścieżek, bez
`os error`, `Error:`, `0x`, bez stosów wywołań. `last_error` z istniejącego
`windows::status()` jest zsanityzowany do stałego, bezpiecznego komunikatu.
Warstwa TS dodatkowo odrzuca każdą odpowiedź o nieprawidłowym kształcie i
filtruje `issues` do samych czystych kodów.

## Testy dla nieprawidłowej konfiguracji

Dodano testy (Rust, czyste, bez `reg.exe`, działają na macOS) dla: poprawnej i
każdej odrzuconej ścieżki, poprawnego i każdego błędnego wpisu (cudzysłów,
nowa linia, NUL, `..`, metaznaki, nie-`.exe`, zbyt długa, dodatkowe argumenty,
wielokrotne flagi, nieujęta ścieżka ze spacjami), zdrowego / brakującego /
nieaktualnego / uszkodzonego wpisu, czystości komunikatów oraz gwarancji, że
wyniki `detect_issues` to wyłącznie kody (bez surowych ścieżek). Po stronie TS
testowano: poprawną odpowiedź, każdą zniekształconą odpowiedź (bezpieczny
fallback, `issues: string[]`), podgląd WWW, odrzucenie `invoke`, komunikaty z
brakiem wycieków oraz kompatybilność istniejących invoke'ów.

## Czego NIE robimy (ograniczenia i uczciwość)

- **NO HKLM / Winlogon / shell / Startup changes.** Nadal dotykamy wyłącznie
  pojedynczej wartości `HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v
  VELORA`. Nie zmieniamy `HKLM`, `Winlogon Shell`, powłoki Windows, folderu
  Startup ani żadnych innych ustawień systemowych. Nie używamy `cmd /c`,
  powłoki ani składania poleceń z łańcuchów znaków.
- **Nowe komendy są read-only.** `get_autostart_diagnostics` i
  `get_autostart_recovery` wykonują wyłącznie odczyt (`reg.exe query`) i czystą
  analizę; jedynym zapisem pozostaje `set_autostart_enabled`. Brak auto-repair.
- **Not tested on MSI.** Nie wykonano testów instalatora MSI; dokument
  `docs/autostart-v1.md` zachowuje swoją ręczną listę kontrolną bez zmian.
- **No hardware tests.** Brak testów na fizycznym sprzęcie / logowaniu do
  Windows. Implementacja i testy czystych helperów powstały i zostały
  zweryfikowane w środowisku **macOS**; kod specyficzny dla Windows jest
  odgrodzony `#[cfg(target_os = "windows")]` z bezpiecznymi fallbackami
  `#[cfg(not(...))]` i nie był uruchamiany na macOS (brak `reg.exe`).
- **Brak ogłoszenia wydania.** To opis zmiany technicznej, nie komunikat
  release'owy.

## Kompatybilność wsteczna

Zachowano dokładnie wszystkie istniejące eksporty Rust (`SAFE_MODE_FLAG`,
`run_value_name`, `registry_run_key`, `windowed_flag_present`,
`autostart_command_value`, `registry_add_arguments`, `registry_delete_arguments`,
`registry_query_arguments`, `AutostartStatus`, `StartupMode`, trzy komendy
`#[tauri::command]`), wszystkie polskie komunikaty błędów, wszystkie 8
istniejących testów Rust oraz wszystkie eksporty i dokładne ciągi `invoke`
w TS (`get_autostart_status`, `set_autostart_enabled` z `{ enabled, windowed }`,
`get_startup_mode`). Nie dodano nowych zależności (Cargo / npm), nowych
`mod`ów ani nowych funkcji crate'a `windows`.
