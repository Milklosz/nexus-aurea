# Instalacja rozszerzenia Playnite — VELORA Library Exporter (moduł A1)

> **STATUS UCZCIWY.** Poniższa procedura opisuje **ręczną instalację na Windows**,
> której **NIE wykonano** w środowisku powstania dokumentu (macOS). Rozszerzenie
> dostarczono wyłącznie jako **projekt źródłowy** — nie zostało skompilowane ani
> uruchomione tutaj (brak Windows, Playnite, .NET Framework 4.6.2, Playnite.SDK).
> Wszystkie kroki „Sprawdź" wymagają fizycznej maszyny Windows z Playnite.
> Patrz także [`playnite-manifest-contract.md`](playnite-manifest-contract.md) i
> [`schemas/velora-playnite-manifest.schema.json`](schemas/velora-playnite-manifest.schema.json)
> (jedyny, jawny kontrakt danych) oraz [`../playnite-extension/README.md`](../playnite-extension/README.md).

Rozszerzenie działa **wewnątrz Playnite** i zapisuje jawnie allowlistowany manifest
do `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`. VELORA czyta ten
plik **wyłącznie do odczytu**.

**VELORA nigdy nie czyta bazy danych Playnite (nieudokumentowanych plików
biblioteki / SQLite) i nigdy nie otrzymuje tokenów, ciasteczek ani danych
logowania** (żadnych `-AUTH_PASSWORD` / `-AUTH_LOGIN`, sesji launcherów,
haseł GOG/Epic/EA/Ubisoft). Uruchomienie gier odbywa się wyłącznie przez
`playnite://playnite/start/<id>` obsługiwane przez sam Playnite.

---

## 1. Wymagania wstępne

- [ ] **Windows** (Playnite desktop działa na Windows; na macOS/Linux nie działa).
- [ ] **Playnite 10** (wersja desktop, zainstalowana i uruchomiona co najmniej raz). Playnite 11 wymaga osobnego builda `net10.0` / SDK 11 i nie jest objęty tym projektem.
- [ ].NET Framework **4.6.2** (targeting pack / Developer Pack) do zbudowania projektu.
- [ ] **Visual Studio 2017+** (z workloadem .NET desktop) albo **MSBuild Build Tools** (`msbuild`).
- [x] Pakiet NuGet **`PlayniteSDK 6.18.0`** — przypięty w `.csproj`; oficjalny pakiet 6.x dla `net462` / Playnite 10.
- [ ] Uprawnienia do zapisu w `%LOCALAPPDATA%` (katalog użytkownika) i do katalogu
      `%AppData%\Playnite\Extensions`.
- [ ] VELORA (build z włączonym panelem **Biblioteka Playnite** / Control Center → Gaming).

Brak: kont administracyjnych, wpisów `HKLM` / Winlogon / powłoki, zmian rejestru
systemowego, sterowników, jakiegokolwiek omijania DRM / HDCP.

---

## 2. Zbudowanie rozszerzenia (na Windows)

1. Otwórz `playnite-extension/VeloraLibraryExporter.csproj`.
2. Pozostaw przypiętą wersję `PlayniteSDK 6.18.0`. Nie dodawaj referencji do
   `Playnite` / `Playnite.Common`.
3. Z poziomu wiersza poleceń (Developer Command Prompt for VS):
   ```
   msbuild VeloraLibraryExporter.csproj /t:Restore /p:Configuration=Release
   msbuild VeloraLibraryExporter.csproj /p:Configuration=Release
   ```
   albo w Visual Studio: wybierz konfigurację `Release` → Build → Build Solution.
4. Wynik: `playnite-extension/bin/Release/VeloraLibraryExporter.dll`.
   Prywatna kopia `Playnite.SDK.dll` **nie** jest kopiowana do outputu
   (`ExcludeAssets=runtime`) — w runtime dostarcza ją Playnite.

---

## 3. Instalacja plików

Wybierz **jedną** z dwóch metod.

### Metoda A — kopia do katalogu Extensions (zalecana dla gotowego DLL)

Utwórz folder:
```
%AppData%\Playnite\Extensions\VeloraLibraryExporter\
```
i skopiuj do niego:
- `extension.yaml`
- `VeloraLibraryExporter.dll`
- (opcjonalnie ikonę, jeśli ją dodasz — projekt jej nie wymaga)

Nie kopiuj `Playnite.SDK.dll` ani plików `.pdb`/`.tmp`.

### Metoda B — „External extensions" (wygodna przy iteracji)

Playnite → **Settings → For developers** (tryb deweloperski) → dodaj folder
wyjściowy buildu (`playnite-extension/bin/Release/`) jako **External extension**.
`extension.yaml` musi leżeć w tym folderze (skopiuj go tam). Playnite wykryje DLL.

---

## 4. Włączenie rozszerzenia

- [ ] Uruchom / zrestartuj Playnite.
- [ ] **Settings → Extensions** → odnajdź **VELORA Library Exporter** i upewnij się,
      że jest **włączone** (enabled). Jeśli widnieje błąd ładowania, patrz § 9.
- [ ] Pozycja menu powinna pojawić się w głównym menu jako sekcja **VELORA**.

---

## 5. Wyzwolenie eksportu

Masz dwie drogi:

- **Ręcznie:** menu główne → **Extensions → VELORA → „VELORA: eksportuj bibliotekę"**
  (`MenuSection = "@VELORA"`, `Description = "VELORA: eksportuj bibliotekę"`).
- **Automatycznie:** przy każdym starcie Playnite `OnApplicationStarted()` wykonuje
  best-effort `ExportManifest()` w `try/catch` (awaria nie przerywa startu Playnite).

Eksport iteruje `PlayniteApi.Database.Games`, pomija gry `Hidden`, buduje manifest
w pamięci i zapisuje go **atomowo** (`.tmp` → `File.Replace`/`File.Move`).

---

## 6. Weryfikacja: plik JSON

- [ ] Sprawdź, że istnieje:
      `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`.
- [ ] Otwórz w edytorze: poprawny JSON (zaczyna się od `{`, UTF-8 bez BOM),
      `schemaVersion: 1`, `kind: "velora.playnite.library-manifest"`,
      `source: "playnite-api"`, `readOnly: true`,
      `extension.id: "velora-library-exporter"`, `extension.version: "1.0.0"`.
- [ ] `games[]` zawiera realne tytuły z Twojej biblioteki; gry `Hidden` są pominięte.
- [ ] `cover` to `null` albo `data:image/(png|jpeg|webp|gif);base64,...` — nigdy
      `file:` / `http(s):` / `javascript:` / zdalny URL.
- [ ] `launch` jest `null` dla gier niezainstalowanych, a dla zainstalowanych ma
      `kind: "playnite-uri"` i `uri: "playnite://playnite/start/<id>"` zgodne z `id`.
- [ ] W pliku **nie ma** pól `PlayAction`, `GameActions`, `Notes`, `Links`,
      `GameStartedScript`, `PreScript`, `PostScript`, `GameId`, `InstallDirectory`
      ani żadnych tokenów / haseł / ciasteczek / surowych ścieżek biblioteki.
- [ ] Porównaj strukturę z fixture
      [`../playnite-extension/ManifestExample.json`](../playnite-extension/ManifestExample.json)
      oraz z [`schemas/velora-playnite-manifest.schema.json`](schemas/velora-playnite-manifest.schema.json).
- [ ] (Opcjonalnie) sprawdź brak pliku `.tmp` po udanym eksporcie — zapis był atomowy.

---

## 7. Weryfikacja: panel VELORA

- [ ] Uruchom VELORA, otwórz **Control Center → Gaming → Biblioteka Playnite**.
- [ ] Panel pokazuje **realne tytuły, okładki, ulubione i „Ostatnio grane"**
      pochodzące z manifestu (źródło `playnite-api`, `available: true`), a nie
      komunikat `unavailable` / `playnite-detected`.
- [ ] Brak okładki daje bezpieczny placeholder (gradient + inicjały) — nie próbę
      ładowania zewnętrznego zasobu.
- [ ] Sekcja wyraźnie komunikuje, że dane gier są **tylko do odczytu**.
- [ ] Kliknięcie karty z `launch` przekazuje do Playnite bezpieczne URI
      `playnite://playnite/start/<id>`; VELORA nie uruchamia procesów z manifestu.

---

## 8. Weryfikacja: VELORA NIE pisze do danych Playnite

- [ ] Przed i po otwarciu panelu / odświeżeniu / kliknięciu karty porównaj zawartość
      katalogu danych Playnite (`%AppData%\Playnite` i bibliotekę gier): **brak
      nowych plików i brak modyfikacji**.
- [ ] Jedynym plikiem tworzonym przez integrację jest
      `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json` (zapisuje je
      rozszerzenie Playnite, **nie** VELORA).
- [ ] Ulubione / „Ostatnio grane" VELORY żyją wyłącznie w `localStorage` WebView
      VELORY — to nie jest zapis do Playnite.
- [ ] VELORA nie czyta nieudokumentowanej bazy Playnite, nie prosi o logowanie do
      GOG / Epic / EA / Ubisoft i nie otrzymuje tokenów, ciasteczek ani danych logowania.

---

## 9. Ponowny eksport po zmianach w bibliotece

Manifest jest **snapshotem** — nie odświeża się sam w trakcie pracy. Po dodaniu /
usunięciu gry, zmianie ulubionych, okładki, aktywności lub stanu instalacji:

- kliknij ponownie **Extensions → VELORA → „VELORA: eksportuj bibliotekę"**, albo
- zrestartuj Playnite (auto-eksport w `OnApplicationStarted()`), a następnie
  odśwież panel VELORA.

---

## 10. Wyłączenie / deinstalacja

- **Wyłączenie bez usuwania:** Playnite → **Settings → Extensions** → wyłącz
  **VELORA Library Exporter** (eksport przestanie się wykonywać; ostatni plik JSON
  pozostaje na dysku).
- **Pełna deinstalacja:** zamknij Playnite → usuń folder
  `%AppData%\Playnite\Extensions\VeloraLibraryExporter\` (albo usuń wpis
  „External extensions") → opcjonalnie usuń
  `%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json`.
- Po usunięciu manifestu VELORA wraca do bezpiecznego stanu `unavailable` /
  `playnite-detected` — **nie zgaduje** danych gier i nie czyta bazy Playnite.

---

## 11. Rozwiązywanie problemów

| Objaw | Co sprawdzić |
| --- | --- |
| Rozszerzenia nie widać w Settings → Extensions | Czy `extension.yaml` leży obok DLL; `Type: GenericPlugin`, `Module: VeloraLibraryExporter.dll`; wersja `PlayniteSDK` zgodna z Playnite; restart Playnite; log Playnite (`%AppData%\Playnite\playnite.log`). |
| Błąd ładowania DLL | Zbudowane pod **.NET Framework 4.6.2** (nie .NET Core/5+); czy `Playnite.SDK.dll` **nie** zostało skopiowane do folderu rozszerzenia; brak referencji do `Playnite`/`Playnite.Common`. |
| Brak pliku JSON | Czy rozszerzenie jest włączone; czy `%LOCALAPPDATA%` jest zapisywalny; czy wyzwolono eksport (menu lub restart); komunikaty `Debug.WriteLine` w logach/debuggerze. |
| `games[]` puste | W bibliotece mogą być same gry `Hidden`; sprawdź w Playnite. Gry z pustą nazwą są celowo pomijane. |
| Brak okładek | Plik coveru niedostępny / > 2 000 000 B / nierozpoznany format / wynikowy URI > 2 000 000 znaków → zgodnie z kontraktem `cover: null` i placeholder w VELORA. Rozwiązanie okładki wyłącznie przez `GetFullFilePath(game.CoverImage)`. |
| Panel VELORA wciąż `unavailable` | Zweryfikuj manifest względem schemy (stałe, `readOnly`, duplikaty `id`, schemat `launch.uri` zgodny z `id`); sprawdź ścieżkę i uprawnienia odczytu; odśwież panel. |
| VELORA pokazuje dane „przykładowe" | To błąd — VELORA **nigdy** nie generuje przykładowych gier. Zgłoś i wróć do bezpiecznego fallbacku. |

---

## 12. Czego NIE wykonano / NIE testowano (uczciwy zakres)

- **NIE wykonano na macOS** — środowisko powstania to macOS; nie ma tu Windows,
  Playnite, .NET Framework 4.6.2 ani Playnite.SDK. Projekt **nie został
  skompilowany ani uruchomiony**, integracja **nie została uruchomiona**.
- **NIE testowano na MSI** (maszyna MSI z Windows) — brak testów sprzętowych,
  brak weryfikacji 4K / HDR / DRM / HDCP dla serwisów streamingowych.
- Wszystkie powyższe checklisty to **procedura do wykonania ręcznego** na Windows
  po zbudowaniu i zainstalowaniu rozszerzenia; nie są to wyniki przeprowadzonych
  testów.
- VELORA **nigdy nie czyta bazy danych Playnite** i **nigdy nie otrzymuje tokenów,
  ciasteczek ani danych logowania**; nie instaluje launcherów, nie modyfikuje
  systemu Windows, nie omija zabezpieczeń.
