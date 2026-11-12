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
| Toolchain | Requires Windows + Visual Studio/MSBuild with .NET Framework 4.6.2 developer pack, or an equivalent .NET SDK capable of `net462`. |
| Playnite SDK | `PackageReference Include="PlayniteSDK" Version="6.0.0"` is explicitly marked as a **placeholder**. It must be pinned to the exact SDK version shipped with the target Playnite installation. |
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

**BLOCKED.** The Rust parser/launcher integration is implemented and tested with
mocked manifests; it is not evidence that the C# extension compiles or runs.
Keep the extension out of the “working” feature list until the Windows build and
Playnite load test are recorded in
[`velora-v1-msi-acceptance.md`](velora-v1-msi-acceptance.md) (rows E2/E5).
