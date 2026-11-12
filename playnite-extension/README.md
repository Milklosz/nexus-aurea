# VELORA — Playnite Library Exporter (moduł A1)

> **STATUS UCZCIWY / SOURCE PROJECT.** To jest **kompletny projekt źródłowy**
> rozszerzenia Playnite. **NIE został skompilowany ani uruchomiony** w środowisku,
> w którym powstał (macOS; brak Windows, Playnite, .NET Framework 4.6.2 i
> Playnite.SDK). Przed użyciem **należy zbudować i zweryfikować go na Windows /
> Playnite**. Nie wykonano żadnych testów sprzętowych ani testów na MSI.

Rozszerzenie (`GenericPlugin`, .NET Framework 4.6.2) eksportuje **jawnie
allowlistowaną** porcję metadanych biblioteki Playnite do lokalnego pliku JSON,
który VELORA otwiera **wyłącznie do odczytu**. VELORA nigdy nie czyta
nieudokumentowanej bazy danych Playnite, nie otrzymuje tokenów, ciasteczek ani
danych logowania, a uruchomienie gier deleguje z powrotem do Playnite przez
udokumentowane URI `playnite://playnite/start/<id>`.

Pliki w tym katalogu:

| Plik | Rola |
| --- | --- |
| `extension.yaml` | manifest rozszerzenia (`Id`, `Name`, `Author`, `Version`, `Module`, `Type: GenericPlugin`) |
| `VeloraLibraryExporter.csproj` | projekt klasy .NET Framework 4.6.2, `PlayniteSDK` (PackageReference) |
| `VeloraLibraryExporterPlugin.cs` | `VeloraLibraryExporterPlugin : Plugin` — menu, auto-eksport, allowlista, zapis atomowy |
| `VeloraManifestDto.cs` | proste POCO DTO z jawnymi nazwami pól camelCase |
| `VeloraManifestJson.cs` | mały writer JSON (`StringBuilder` + `JsonEscape`) — patrz „Serializer" niżej |
| `ManifestExample.json` | mały, poprawny fixture zgodny ze schemą (2 gry) |

## Dokładna ścieżka manifestu

```
%LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json
```

Katalog należy do VELORY (nie do instalacji rozszerzenia — tej nie wolno używać do
danych generowanych, bo jest czyszczona przy aktualizacji; patrz `dataDirectory.html`).
Zapis jest **atomowy** (plik `.tmp` → `File.Replace` / `File.Move`), więc awaria
nigdy nie zostawia uszkodzonego ani częściowego manifestu, a błąd eksportu nigdy
nie nadpisuje poprzedniej poprawnej wersji.

## Kontrakt = jedyne źródło prawdy

Jedynym, jawnym kontraktem jest
[`docs/playnite-manifest-contract.md`](../docs/playnite-manifest-contract.md) oraz
maszynowa [`docs/schemas/velora-playnite-manifest.schema.json`](../docs/schemas/velora-playnite-manifest.schema.json).
Generowany JSON **musi** zgadzać się z nimi dokładnie: nazwy pól (camelCase), typy i
stałe wartości. Schema ustawia `additionalProperties: false` na każdym poziomie —
dlatego eksporter nie emituje ŻADNYCH dodatkowych pól.

### Emitowane pola główne

`schemaVersion` (= `1`), `kind` (= `velora.playnite.library-manifest`),
`generatedAt` (ISO-8601 UTC `yyyy-MM-ddTHH:mm:ssZ`),
`extension.id` (= `velora-library-exporter`), `extension.version` (= `1.0.0`),
`source` (= `playnite-api`), `readOnly` (= `true`), `games[]`.

### Emitowane pola gry (allowlista)

`id`, `name`, `cover`, `source`, `lastPlayed`, `favorite`, `installed`,
`playCount`, `playtimeSeconds`, `launch`.

- `id` — `Game.Id` (Guid) w formacie z myślnikami.
- `name` — `Game.Name`, bez znaków sterujących, ≤ 512 znaków, niepusty.
- `cover` — `null` albo samowystarczalny `data:image/(png|jpeg|webp|gif);base64,...`
  z lokalnych bajtów okładki rozwiązanych **wyłącznie** przez udokumentowane
  `PlayniteApi.Database.GetFullFilePath(game.CoverImage)`; rozpoznanie po magic
  bytes (PNG `89 50 4E 47`, JPEG `FF D8 FF`, GIF `GIF8`, WEBP `RIFF`+`WEBP`).
  Plik ≤ 2 000 000 B, wynikowy URI ≤ 2 000 000 znaków. **Nigdy** `file:`,
  `http(s):`, `javascript:` ani zdalny URL; VELORA nie buduje ścieżek do plików
  biblioteki Playnite.
- `source` — `Game.Source.Name`, albo etykieta `playnite-plugin` / `manual`;
  bez znaków sterujących, ≤ 128 znaków.
- `lastPlayed` — `Game.LastActivity` → UTC `yyyy-MM-ddTHH:mm:ssZ` lub `null`.
- `favorite` = `Game.Favorite`; `installed` = `Game.IsInstalled`.
- `playCount` / `playtimeSeconds` — z `Game.PlayCount` / `Game.Playtime` (sekundy),
  zawsze ≥ 0.
- `launch` — **tylko** dla gier zainstalowanych:
  `{ "kind": "playnite-uri", "uri": "playnite://playnite/start/<id>" }`
  (`<id>` identyczne z polem `id`); w przeciwnym razie `null`. Jedyna dozwolona
  forma uruchomienia — VELORA nie spawnowuje procesów z manifestu.
- Pomijane są gry z `Hidden == true` (decyzja użytkownika w Playnite).

### Czego NIE eksportujemy (twarde wyłączenia)

`PlayAction`, `GameActions`, `Notes`, `Links`, `GameStartedScript`, `PreScript`,
`PostScript`, `GameId` (identyfikator dostawcy), `InstallDirectory`, wszelkie
surowe ścieżki do nieudokumentowanych plików biblioteki Playnite oraz
**jakiekolwiek** poświadczenia / ciasteczka / tokeny / sesje HTTP / pliki
ustawień Playnite.

**Dlaczego:** argumenty launcherów w play-action mogą zawierać sekrety
(`-AUTH_PASSWORD=...`, `-AUTH_LOGIN=...`, tokeny Epic/EA/Ubisoft). VELORA ich nie
kopiuje — Playnite sam odtwarza właściwe argumenty startowe na podstawie URI
`playnite://playnite/start/<id>` (`cmdlineArguments.html`). Eksporter nigdy nie
czyta nieudokumentowanej bazy danych Playnite.

## Serializer — uzasadnienie wyboru

SDK dokumentuje `Playnite.SDK.Data.Serialization.ToJson(obj)` z atrybutami w stylu
`[SerializationPropertyName("...")]`, ale dokładna nazwa atrybutu, obsługa `null` i
konwencja wielkości liter zależą od wersji SDK. Aby **zagwarantować** w 100%
poprawne klucze camelCase, jawne emitowanie `null` oraz zgodność z
`additionalProperties: false`, **nie używamy** tu żadnego serializera refleksyjnego.
Zamiast tego `VeloraManifestJson.cs` zawiera mały writer oparty na `StringBuilder`
i poprawnym escapingu (`JsonEscape`), który wypisuje każdy klucz jako jawny
literal znakowy. Daje to pełną kontrolę nad wynikiem i dokładną zgodność z
kontraktem — to podejście preferowane dla poprawności. (DTO w
`VeloraManifestDto.cs` mają jawne nazwy właściwości camelCase.)

## Oficjalne źródła API (zweryfikowane na api.playnite.link)

- https://api.playnite.link/docs/tutorials/extensions/intro.html — `extension.yaml`, katalog `Extensions` (`%AppData%\Playnite\Extensions`), typy rozszerzeń.
- https://api.playnite.link/docs/tutorials/extensions/plugins.html — `Plugin(IPlayniteAPI)`, właściwość `PlayniteApi`, .NET Framework 4.6.2, `Playnite.SDK.Data.Serialization`.
- https://api.playnite.link/docs/tutorials/extensions/menus.html — `GetMainMenuItems(GetMainMenuItemsArgs)` → `MainMenuItem { Description, MenuSection, Action }`.
- https://api.playnite.link/docs/tutorials/extensions/extensionsManifest.html — `Id` / `Name` / `Author` / `Version` / `Module` / `Type: GenericPlugin`.
- https://api.playnite.link/docs/tutorials/extensions/dataDirectory.html — `GetPluginUserDataPath()`; nie trzymamy danych w katalogu instalacji rozszerzenia.
- https://api.playnite.link/docs/tutorials/extensions/library.html — `PlayniteApi.Database.GetFullFilePath(game.CoverImage)` jako udokumentowany sposób rozwiązania okładki.
- https://api.playnite.link/docs/api/Playnite.SDK.Models.Game.html — `Id`, `Name`, `CoverImage`, `LastActivity`, `Favorite`, `IsInstalled`, `Hidden`, `Source`, `PluginId`, `PlayCount`, `Playtime`.
- https://api.playnite.link/docs/manual/advanced/cmdlineArguments.html — URI `playnite://playnite/start/<gameId>`.

## Budowanie (Windows)

Wymagania: Windows, Visual Studio 2017+ (lub MSBuild Build Tools + `msbuild`),
**.NET Framework 4.6.2** (targeting pack), pakiet NuGet **`PlayniteSDK 6.18.0`**,
Playnite 10 desktop. Playnite 11 wymaga osobnego builda `net10.0` / SDK 11.
Projekt **nie** referuje assembly nie-SDK (`Playnite`, `Playnite.Common`).

1. Pozostaw przypiętą wersję `PlayniteSDK 6.18.0` (komentarz w csproj wyjaśnia
   zakres Playnite 10).
2. `msbuild VeloraLibraryExporter.csproj /t:Restore /p:Configuration=Release`
3. `msbuild VeloraLibraryExporter.csproj /p:Configuration=Release`
   (albo: otwórz projekt w Visual Studio, wybierz `Release`, Build).
4. Wynik: `bin/Release/VeloraLibraryExporter.dll`. `ExcludeAssets=runtime`
   zapobiega skopiowaniu prywatnej kopii `Playnite.SDK.dll` — w runtime dostarcza
   ją sam Playnite.
5. Zainstaluj wg [`docs/playnite-extension-install.md`](../docs/playnite-extension-install.md):
   skopiuj `extension.yaml` + DLL do
   `%AppData%\Playnite\Extensions\VeloraLibraryExporter\` albo dodaj folder
   buildu przez „For developers → External extensions".

`ManifestExample.json` to mały, poprawny fixture z 2 grami (jedna zainstalowana z
PNG data-URI + `launch`, jedna niezainstalowana z `cover: null` / `launch: null`).
Służy do ręcznego sprawdzenia parsera VELORY; nie jest kompilowany ani wczytywany
przez rozszerzenie.

## Jak dane pozostają tylko do odczytu po stronie VELORY

Rozszerzenie jest **jedynym** producentem pliku. VELORA wykonuje wyłącznie
`fs::read` na powyższej ścieżce, waliduje manifest względem schemy (odrzuca
duplikaty `id`, niedozwolone schematy okładek / `launch.uri`, błędne stałe) i
mapuje go do `PlayniteLibrarySnapshot` (`source: "playnite-api"`,
`available: true`, `readOnly: true`). VELORA **nigdy nie zapisuje** do tego pliku ani
do katalogów Playnite, nie zgaduje danych gier przy braku / błędzie manifestu i
nie czyta bazy Playnite.

## Czego nie twierdzimy

- Rozszerzenie **nie zostało skompilowane ani uruchomione** tutaj (macOS; brak
  Windows / Playnite / .NET Framework 4.6.2 / Playnite.SDK).
- **Nie wykonano** testów na MSI, testów sprzętowych, ani weryfikacji
  4K / HDR / DRM / HDCP dla serwisów streamingowych.
- Integracja wymaga ręcznej instalacji i weryfikacji na Windows — patrz
  [`docs/playnite-extension-install.md`](../docs/playnite-extension-install.md).
