# VELORA 1.0 — Autostart (opcjonalny, wyłącznie za zgodą)

Dokument opisuje obszar **B. Autostart**. Funkcja jest całkowicie opcjonalna i
**domyślnie wyłączona**. VELORA nigdy nie włącza autostartu samodzielnie — ani
przy pierwszym uruchomieniu, ani przy starcie aplikacji, ani w instalatorze MSI.

## Zasada: opt-in tylko w trakcie działania aplikacji

Jedyny zapis do systemu jest bezpośrednim wynikiem **świadomego kliknięcia
przełącznika (toggle) przez użytkownika** w panelu `AutostartPanel`. Montaż
panelu wykonuje wyłącznie odczyt (`get_autostart_status`, `get_startup_mode`) i
nie wywołuje `set_autostart_enabled`. Podgląd WWW (przeglądarka, bez Tauri) oraz
systemy inne niż Windows są tylko do odczytu i zgłaszają „niedostępny”.

## Co dokładnie jest zapisywane

Po włączeniu VELORA dodaje **jeden** wpis w gałęzi bieżącego użytkownika:

- Gałąź: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
- Nazwa wartości: `VELORA`
- Typ: `REG_SZ`
- Treść: `"<pełna ścieżka do velora.exe>"`, opcjonalnie z dopisanym ` --windowed`

Realizacja wywołuje bezpośrednio `reg.exe` ze **stałą, jawną listą argumentów**
(`add … /v VELORA /t REG_SZ /d <wartość> /f`). Nie używa `cmd /c`, powłoki ani
interpolacji łańcuchów poleceń. Ścieżka do pliku wykonywalnego jest brana z
`std::env::current_exe()` i oczyszczana ze znaków cudzysłowu oraz nowych linii.

VELORA **nie** dotyka:

- `HKLM` ani żadnych ustawień globalnych komputera,
- powłoki Windows / wartości `Winlogon Shell`,
- folderu `Startup`,
- żadnych innych ustawień systemowych.

Wpis dotyczy wyłącznie bieżącego użytkownika (HKCU), więc nie wymaga uprawnień
administratora.

## Jak działa wyłączenie

Wyłączenie przełącznikiem usuwa **dokładnie** wartość `VELORA` poleceniem
`reg.exe delete HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v VELORA /f`.
Żadne inne wartości ani wpisy nie są modyfikowane. Po każdym zapisie backend
ponownie odczytuje stan (`reg.exe query`) i nigdy nie zgłasza sukcesu, jeśli
rzeczywisty stan nie odpowiada żądaniu — w razie błędu zwraca odrębny komunikat
po polsku.

## Tryb awaryjny `--windowed`

Flaga `--windowed` to awaryjny, „bezpieczny” start. Jest już obsługiwana przez
konfigurację Tauri w `src-tauri/src/lib.rs` (blok `setup`): przy tej fladze VELORA
wyłącza pełny ekran i przywraca dekoracje okna, co ułatwia odzyskanie kontroli,
gdy pełnoekranowy interfejs sprawia problem.

W panelu dostępna jest osobna kontrolka (checkbox), która decyduje, czy wpis
autostartu ma zawierać ` --windowed`. Zostaje zapisana przy (ponownym) włączeniu
autostartu. Flagi można też użyć ręcznie, uruchamiając VELORA z parametrem
`--windowed` — niezależnie od autostartu.

## Czego VELORA nie robi bez zgody

- Nie zmienia powłoki Windows, Winlogon, HKLM, folderu Startup ani innych
  ustawień systemowych.
- Nie wykonuje żadnego zapisu przy starcie aplikacji ani przy montażu panelu.
- Nie używa `cmd /c`, powłoki ani składania poleceń z łańcuchów znaków.
- Nie instaluje niczego automatycznie, także w instalatorze MSI (brak kroków
  custom action, brak wpisów do rejestru na etapie instalacji).
- Nie wykonuje zmian w podglądzie WWW ani na macOS / Linuxie.

## Instalator MSI — ręczna lista kontrolna (do sprawdzenia przez testera)

Instalator MSI nie konfiguruje autostartu. Poniższe punkty wykonuje się
**ręcznie**, wyłącznie w celu weryfikacji:

1. Po świeżej instalacji MSI (bez otwierania panelu) sprawdź, że wartość
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\VELORA` **nie istnieje**
   (`reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v VELORA`
   zwraca błąd „nie znaleziono”).
2. Uruchom VELORA i otwórz panel Autostart — status powinien brzmieć
   „wyłączony”, a przełącznik ma być wyłączony. Samo otwarcie nie może nic
   zapisać.
3. Włącz przełącznik. Sprawdź, że pojawił się dokładnie jeden wpis `VELORA`
   (REG_SZ) ze ścieżką do `velora.exe` w cudzysłowie.
4. Zaznacz tryb `--windowed`, włącz autostart ponownie i sprawdź, że wartość
   kończy się na ` --windowed`.
5. Wyloguj się i zaloguj ponownie: VELORA powinna uruchomić się w oknie
   (dekoracje widoczne, bez pełnego ekranu).
6. Wyłącz przełącznik. Sprawdź, że wartość `VELORA` zniknęła, a inne wartości
   w `Run` oraz `HKLM\...\Winlogon\Shell` pozostały bez zmian.
7. Zweryfikuj, że w `HKLM`, `Winlogon` i folderze `Startup` nie ma żadnych
   nowych wpisów ani plików dodanych przez instalator.
8. Uruchom VELORA ręcznie z parametrem `--windowed` i potwierdź bezpieczny
   start w oknie nawet przy wyłączonym autostarcie.

## Integracja (dla integratora)

Moduł Rust nazywa się `autostart`. W `src-tauri/src/lib.rs` należy dodać
`mod autostart;` oraz zarejestrować komendy w `tauri::generate_handler![...]`:

- `autostart::get_autostart_status` → invoke `get_autostart_status`
- `autostart::set_autostart_enabled` → invoke `set_autostart_enabled`
- `autostart::get_startup_mode` → invoke `get_startup_mode`

Komponent `AutostartPanel` (eksport nazwany, bez wymaganych propsów) montuje się
w `src/components/ControlCenter.tsx` jako kartę AUREA. Sam komponent nie jest
nigdzie montowany w tym obszarze.
