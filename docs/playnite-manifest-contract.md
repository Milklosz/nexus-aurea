# VELORA 1.0 — Ecosystem: kontrakt manifestu Playnite (moduł A)

> **Jedyny, jawny kontrakt wymiany danych** między rozszerzeniem Playnite a VELORA.
> Schema maszynowa: [`docs/schemas/velora-playnite-manifest.schema.json`](schemas/velora-playnite-manifest.schema.json).
>
> **Status uczciwy:** integracja **nie została uruchomiona** w tym środowisku
> (macOS; Playnite działa na Windows). Dostarczono kompletny projekt źródłowy
> rozszerzenia, parser + testy, kontrakt i instrukcję instalacji. VELORA czyta
> wyłącznie lokalny plik JSON wygenerowany przez to rozszerzenie.

## 1. Dlaczego taka architektura

Playnite nie udostępnia oficjalnego, wspieranego **zdalnego API** do odczytu
biblioteki z osobnego procesu. Oficjalnie udokumentowanym i wspieranym
mechanizmem jest **rozszerzenie (plugin .NET)** działające wewnątrz Playnite,
które ma dostęp do `IPlayniteAPI` (`PlayniteApi.Database.Games`). Zamiast czytać
**nieudokumentowaną bazę danych Playnite** (pliki biblioteki, SQLite itd.),
VELORA przyjmuje odwrotny kierunek: małe rozszerzenie **jawnie eksportuje
wybrane metadane** do lokalnego pliku JSON, a VELORA otwiera go **tylko do odczytu**.

Oficjalne źródła (zweryfikowane):

- `https://api.playnite.link/docs/tutorials/extensions/intro.html` — typy rozszerzeń, `extension.yaml`, katalog `Extensions`.
- `https://api.playnite.link/docs/tutorials/extensions/plugins.html` — plugin `.NET Framework 4.6.2`, `Plugin(IPlayniteAPI)`, `PlayniteApi`.
- `https://api.playnite.link/docs/tutorials/extensions/menus.html` — `GetMainMenuItems(GetMainMenuItemsArgs)` → `MainMenuItem { Description, MenuSection, Action }`.
- `https://api.playnite.link/docs/tutorials/extensions/extensionsManifest.html` — `Id`, `Name`, `Author`, `Version`, `Module`, `Type: GenericPlugin`.
- `https://api.playnite.link/docs/tutorials/extensions/dataDirectory.html` — `GetPluginUserDataPath()`.
- `https://api.playnite.link/docs/tutorials/extensions/library.html` — `PlayniteApi.Database.GetFullFilePath(game.CoverImage)`.
- `https://api.playnite.link/docs/api/Playnite.SDK.Models.Game.html` — `Id`, `Name`, `CoverImage`, `LastActivity`, `Favorite`, `IsInstalled`, `Hidden`, `Source`, `PluginId`, `PlayCount`, `Playtime`.
- `https://api.playnite.link/docs/manual/advanced/cmdlineArguments.html` — **URI**: `playnite://playnite/start/<gameId>`.

## 2. Lokalizacja pliku

```
%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json
```

- Jest to katalog **należący do VELORA**, nie do instalacji rozszerzenia
  (instalacja/aktualizacja rozszerzenia czyści jego katalog — patrz `dataDirectory.html`).
- Ścieżka rozwiązywana wyłącznie z `LOCALAPPDATA`; parser **odrzuca** ścieżki
  względne, puste, z `..`, ze znakami sterującymi / NUL.
- VELORA wykonuje wyłącznie `fs::read`. Nigdy nie zapisuje do tego pliku ani do
  katalogów Playnite.
- Plik jest limitowany do **32 MiB** przed parsowaniem (ochrona przed nadużyciem pamięci).

## 3. Kształt (schemaVersion = 1)

```json
{
  "schemaVersion": 1,
  "kind": "velora.playnite.library-manifest",
  "generatedAt": "2026-11-12T00:00:00Z",
  "extension": { "id": "velora-library-exporter", "version": "1.0.0" },
  "source": "playnite-api",
  "readOnly": true,
  "games": [
    {
      "id": "64f78cd1-0b00-4271-a9e1-89abc55f66cc",
      "name": "Example Game",
      "cover": "data:image/png;base64,iVBORw0KGgo=",
      "source": "Steam",
      "lastPlayed": "2026-11-10T18:22:00Z",
      "favorite": true,
      "installed": true,
      "playCount": 12,
      "playtimeSeconds": 36000,
      "launch": {
        "kind": "playnite-uri",
        "uri": "playnite://playnite/start/64f78cd1-0b00-4271-a9e1-89abc55f66cc"
      }
    }
  ]
}
```

### Pola główne

| Pole | Typ | Wymagane | Reguła |
| --- | --- | --- | --- |
| `schemaVersion` | integer | ✔ | musi być dokładnie `1` |
| `kind` | string | ✔ | dokładnie `velora.playnite.library-manifest` |
| `generatedAt` | string | ✔ | ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SS(.sss)?Z`, ≤ 64 znaków |
| `extension.id` | string | ✔ | `velora-library-exporter` |
| `extension.version` | string | ✔ | ≤ 32 znaki |
| `source` | string | ✔ | dokładnie `playnite-api` |
| `readOnly` | boolean | ✔ | musi być `true` |
| `games` | array | ✔ | ≤ 10 000 pozycji |

### Pola gry

| Pole | Typ | Reguła |
| --- | --- | --- |
| `id` | string | `Playnite.SDK.Models.Game.Id` (Guid): `^[0-9a-fA-F]{8}-...-{12}$` |
| `name` | string | niepusty, ≤ 512, bez znaków sterujących |
| `cover` | string \| null | `null` **albo** `data:image/(png\|jpeg\|webp\|gif);base64,[A-Za-z0-9+/]+={0,2}`, ≤ 2 000 000 znaków |
| `source` | string | `Game.Source.Name` (lub etyka zapasowa), ≤ 128 |
| `lastPlayed` | string \| null | ISO-8601 UTC albo `null` (`Game.LastActivity`) |
| `favorite` | boolean | `Game.Favorite` |
| `installed` | boolean | `Game.IsInstalled` — **dostępność gry** |
| `playCount` | integer ≥ 0 | opcjonalne, domyślnie 0 |
| `playtimeSeconds` | integer ≥ 0 | opcjonalne, domyślnie 0 |
| `launch` | object \| null | `null` albo `{ kind: "playnite-uri", uri: <dokładnie playnite://playnite/start/<id>> }` |

`cover` jako `data:` URI jest **samowystarczalne** — VELORA nie buduje żadnej
ścieżki do plików biblioteki Playnite. Okładka jest opcjonalna: brak pliku lub
niedozwolony schemat skutkuje `null` i bezpiecznym placeholderem z inicjałami
(istniejący mechanizm `sanitizeCoverSource` w UI).

`launch.uri` jest **jedyną** formą uruchomienia. Parser odrzuca każdą inną
(`file:`, `javascript:`, `http(s)://`, dowolne polecenie) oraz `uri` niezgodne z
`id` — zapobiega to wstrzyknięciu polecenia przez zmanipulowany manifest.

## 4. Czego rozszerzenie NIE eksportuje (twarde wyłączenia)

Aby nie kopiować **tokenów, ciasteczek ani danych logowania**, eksporter używa
**jawnej allowlisty** pól z `Game` (sekcja 3) i celowo pomija:

- `Game.PlayAction` / `Game.GameActions` (argumenty launcherów mogą zawierać
  `-AUTH_PASSWORD=...`, `-AUTH_LOGIN=...`, tokeny Epic/EA/Ubisoft),
- `Game.GameStartedScript`, `PreScript`, `PostScript`, `Notes`, `Links`,
- `Game.GameId` (identyfikator dostawcy / potencjalnie identyfikator konta),
- `Game.InstallDirectory` i wszystkie surowe ścieżki plików biblioteki,
- jakiekolwiek dane z magazynu poświadczeń, ciasteczek, sesji HTTP.

Uruchomienie gry odbywa się **przez Playnite** (`playnite://playnite/start/<id>`),
który sam odtwarza właściwe argumenty startowe. VELORA nie spawnowuje procesów na
podstawie danych z manifestu.

Pomijane są również gry `Hidden == true` (decyzja użytkownika w Playnite).

## 5. Reguły walidacji parsera (Rust, `playnite_manifest.rs`)

1. Limit rozmiaru pliku (32 MiB) → `file-access` / `invalid-manifest`.
2. `serde_json` → typowane struktury z `#[serde(rename_all = "camelCase")]`.
3. Ścisła walidacja każdego pola z sekcji 3; błąd → `invalid-manifest` z
   bezpiecznym, polskim komunikatem (bez surowej ścieżki, bez `os error`).
4. Odrzucenie duplikatów `id` (cały manifest jest nieważny).
5. Odrzucenie niedozwolonych schematów okładek i `launch.uri`.
6. Błędy I/O mapowane na `file-access` z rozróżnieniem `NotFound`,
   `PermissionDenied`, inne — bez wycieku ścieżki.
7. Wynik mapowany do istniejącego `PlayniteLibrarySnapshot`
   (`source: "playnite-api"`, `available: true`, `readOnly: true`) — dzięki temu
   dotychczasowy UI i `normalizeSnapshot()` działają bez zmian.

Gdy manifest jest nieobecny lub nieważny, `get_playnite_library()` wraca do
**bezpiecznego** `unavailable` / `playnite-detected` — nigdy nie zgaduje danych
gier i nie czyta bazy Playnite.

## 6. Wersjonowanie

`schemaVersion` jest **twardą bramą kompatybilności**. Parser v1 akceptuje
wyłącznie `1`. Nowe pola wymagają podniesienia wersji i równoległej aktualizacji
schema, parsera, testów oraz eksportera. Nie stosujemy „przyjmij cokolwiek".

## 7. Honest scope / czego nie twierdzimy

- Rozszerzenie **nie zostało skompilowane ani uruchomione** w tym środowisku
  (brak Windows / Playnite / .NET Framework 4.6.2 / Playnite.SDK).
- Nie wykonano żadnych testów sprzętowych ani testów na MSI.
- Nie potwierdzono jakości 4K/HDR/DRM/HDCP dla serwisów streamingowych.
- Integracja wymaga ręcznej instalacji rozszerzenia na Windows — patrz
  [`docs/playnite-extension-install.md`](playnite-extension-install.md).
