# Playnite C# Extension — Build Status (honest report)

## What is in the repository

`playnite-extension/` contains the full exporter source:

- `VeloraLibraryExporterPlugin.cs`
- `VeloraManifestDto.cs`
- `VeloraManifestJson.cs`
- `VeloraLibraryExporter.csproj`
- `extension.yaml`
- `ManifestExample.json`

It targets `net462` (Playnite's .NET Framework runtime), `AnyCPU`, `LangVersion
7.3`, and references only `PlayniteSDK`.

## What was verified here

- Source files and project exist and are internally consistent by inspection.
- The Rust-side manifest parser validates the documented JSON schema.
- The Rust-side launcher accepts only the canonical
  `playnite://playnite/start/<guid>` URI.
- **No C# compiler is available in this environment**: `dotnet`, `msbuild`,
  `csc`, `mcs` and `mono` are all absent.
- The repository has no Windows CI step that restores/builds the C# project.

## Blockers

| Blocker | Detail |
|---|---|
| Toolchain | Windows + Visual Studio/MSBuild with the .NET Framework 4.6.2 developer pack. A cross-platform verification also succeeded with the official .NET 8 SDK plus `Microsoft.NETFramework.ReferenceAssemblies` (conditional package). |
| Playnite SDK | **Resolved for Playnite 10:** pinned to official `PlayniteSDK 6.18.0` (latest 6.x, `lib/net462`, compatible with Playnite 10). Playnite 11 moved to .NET 10 / SDK 11 and needs a separate `net10.0` build; that is not covered here. |
| Runtime proof | The extension must be loaded by Playnite and export a real manifest; a successful compile alone is not proof. |
| UI proof | Playnite's main-menu item and startup export must be exercised on the MSI target. |

## Windows build procedure (not yet executed)

```powershell
cd playnite-extension
# 1. Pin the real PlayniteSDK version in the csproj.
msbuild VeloraLibraryExporter.csproj /t:Restore /p:Configuration=Release
msbuild VeloraLibraryExporter.csproj /p:Configuration=Release
# 2. Copy extension.yaml + bin/Release/VeloraLibraryExporter.dll into the
#    Playnite Extensions folder.
# 3. Start Playnite, run the VELORA menu item, verify the manifest path.
```

## Status

**BUILD VERIFIED LOCALLY; PLAYNITE LOAD TEST PENDING.** The source also had an API typo (`OnApplicationStartedArgs`); it now uses the
SDK 6.18.0 type `OnApplicationStartedEventArgs`. `dotnet build -c Release`
produced `VeloraLibraryExporter.dll` with 0 warnings/errors. A Windows CI job
(`Windows / Playnite extension (net462)`) rebuilds and uploads the DLL. Compile
success is not runtime proof: keep the extension out of the “working” feature
list until Playnite loads it and writes a manifest. Record that in
[`velora-v1-msi-acceptance.md`](velora-v1-msi-acceptance.md) (rows E2/E5).
