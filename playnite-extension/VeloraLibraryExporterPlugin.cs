// VeloraLibraryExporterPlugin.cs
//
// VELORA Playnite Library Exporter — module A1.
//
// Exports an EXPLICIT ALLOWLIST of Game metadata to a local, READ-ONLY JSON
// manifest consumed by VELORA. This is SOURCE ONLY: it was NOT compiled or run
// in the authoring environment (macOS; no Windows / Playnite / .NET 4.6.2).
//
// Official SDK references (verified via api.playnite.link, also in README.md):
//   https://api.playnite.link/docs/tutorials/extensions/intro.html
//   https://api.playnite.link/docs/tutorials/extensions/plugins.html
//   https://api.playnite.link/docs/tutorials/extensions/menus.html
//   https://api.playnite.link/docs/tutorials/extensions/extensionsManifest.html
//   https://api.playnite.link/docs/tutorials/extensions/dataDirectory.html
//   https://api.playnite.link/docs/tutorials/extensions/library.html
//   https://api.playnite.link/docs/api/Playnite.SDK.Models.Game.html
//   https://api.playnite.link/docs/manual/advanced/cmdlineArguments.html

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text;
using Playnite.SDK;
using Playnite.SDK.Models;
using Playnite.SDK.Plugins;

namespace VeloraLibraryExporter
{
    public class VeloraLibraryExporterPlugin : Playnite.SDK.Plugins.Plugin
    {
        // Fixed plugin id (chosen once, stable, never changes).
        public override Guid Id { get; } = Guid.Parse("9f3c2a71-6b4d-4e8a-b0c2-7d5e1a9f3c48");

        private const string ManifestFileName = "velora-library-manifest.json";
        private const string ExtensionId = "velora-library-exporter";
        private const string ExtensionVersion = "1.0.0";
        private const string ManifestKind = "velora.playnite.library-manifest";
        private const string ManifestSource = "playnite-api";
        private const int SchemaVersion = 1;

        // A cover file may be at most 2,000,000 bytes (instruction) ...
        private const long MaxCoverBytes = 2000000L;
        // ... and the emitted data-URI at most 2,000,000 chars (schema maxLength).
        private const int MaxCoverChars = 2000000;

        private const int MaxNameChars = 512;
        private const int MaxSourceChars = 128;

        public VeloraLibraryExporterPlugin(IPlayniteAPI api) : base(api)
        {
        }

        // ---- Main menu ------------------------------------------------------
        // https://api.playnite.link/docs/tutorials/extensions/menus.html
        public override IEnumerable<MainMenuItem> GetMainMenuItems(GetMainMenuItemsArgs args)
        {
            yield return new MainMenuItem
            {
                Description = "VELORA: eksportuj bibliotekę",
                MenuSection = "@VELORA",
                Action = (a) => ExportManifest()
            };
        }

        // ---- Best-effort export on startup ----------------------------------
        public override void OnApplicationStarted(OnApplicationStartedArgs args)
        {
            try
            {
                ExportManifest();
            }
            catch (Exception ex)
            {
                // Never let a best-effort background export break Playnite startup.
                Debug.WriteLine("[VELORA] OnApplicationStarted export failed (no file written): " + ex);
            }
        }

        // ---- Export ---------------------------------------------------------
        // The whole manifest is built in memory first. Only when every game has
        // been mapped successfully do we write atomically. If anything throws,
        // the destination file is NEVER created or modified — no partial or
        // corrupt manifest can ever be left behind. All logging is best-effort
        // via System.Diagnostics.Debug.WriteLine (no Playnite UI dependency).
        private void ExportManifest()
        {
            try
            {
                VeloraManifestDto manifest = BuildManifest();
                string json = VeloraManifestJson.ToJson(manifest);
                WriteAtomically(json);
                Debug.WriteLine("[VELORA] Playnite manifest exported (games=" +
                                manifest.games.Count.ToString(CultureInfo.InvariantCulture) + ").");
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[VELORA] Export failed (no file written): " + ex);
            }
        }

        // =====================================================================
        // HARD EXCLUSIONS — fields that are NEVER read or serialized.
        //
        // BuildManifest() below touches ONLY the documented, harmless Game
        // properties listed there (an explicit allowlist). We deliberately DO
        // NOT touch any of the following:
        //   * Game.PlayAction / Game.GameActions     -> launcher command-line
        //     arguments may embed secrets such as -AUTH_PASSWORD=...,
        //     -AUTH_LOGIN=..., Epic/EA/Ubisoft tokens, session cookies.
        //   * Game.GameStartedScript / PreScript / PostScript -> arbitrary
        //     script text / commands.
        //   * Game.Notes / Game.Links                  -> free-form user text.
        //   * Game.GameId                             -> provider id (may be an
        //     account identifier) — NOT the same as the internal Guid Id.
        //   * Game.InstallDirectory and ANY raw path into Playnite's
        //     UNDOCUMENTED library files (library db, SQLite, files/ folder).
        //   * Any credential / cookie / token / HTTP session / Playnite settings
        //     file (no store of login data is ever read).
        //
        // WHY: VELORA must never copy tokens, cookies or login data. Launching a
        // game is delegated back to Playnite via the documented
        // playnite://playnite/start/<id> URI (cmdlineArguments.html); Playnite
        // itself recreates the correct play-action arguments, so we never need
        // to export or reconstruct them. VELORA spawns no process from manifest
        // data. We never read Playnite's undocumented database.
        // =====================================================================
        private VeloraManifestDto BuildManifest()
        {
            var manifest = new VeloraManifestDto
            {
                schemaVersion = SchemaVersion,
                kind = ManifestKind,
                generatedAt = ToUtcIso(DateTime.UtcNow),
                extension = new VeloraExtensionDto
                {
                    id = ExtensionId,
                    version = ExtensionVersion
                },
                source = ManifestSource,
                readOnly = true,
                games = new List<VeloraGameDto>()
            };

            foreach (Game game in PlayniteApi.Database.Games)
            {
                if (game == null)
                {
                    continue;
                }

                // Respect the user's decision: hidden games are intentionally omitted.
                if (game.Hidden)
                {
                    continue;
                }

                // name: strip control chars, cap at 512; the schema requires non-empty.
                string name = SanitizeText(game.Name, MaxNameChars);
                if (string.IsNullOrEmpty(name))
                {
                    Debug.WriteLine("[VELORA] Skipping a game with an empty/blank name.");
                    continue;
                }

                string id = game.Id.ToString();
                bool installed = game.IsInstalled;

                // ONLY allowlisted fields are set below.
                var dto = new VeloraGameDto
                {
                    id = id,
                    name = name,
                    cover = BuildCoverDataUri(game.CoverImage),
                    source = ResolveSource(game),
                    lastPlayed = ToUtcIso(game.LastActivity),
                    favorite = game.Favorite,
                    installed = installed,
                    playCount = NonNegative(game.PlayCount),       // int  -> long
                    playtimeSeconds = NonNegative(game.Playtime),  // ulong (seconds) -> long
                    launch = installed
                        ? new VeloraLaunchDto
                        {
                            kind = "playnite-uri",
                            uri = "playnite://playnite/start/" + id
                        }
                        : null
                };

                manifest.games.Add(dto);
            }

            return manifest;
        }

        // source: documented Game.Source.Name, otherwise a safe fallback label —
        // "playnite-plugin" when the game came from a plugin, "manual" otherwise.
        // Always strip control chars and cap at 128 chars.
        private static string ResolveSource(Game game)
        {
            string raw;
            if (game.Source != null && !string.IsNullOrEmpty(game.Source.Name))
            {
                raw = game.Source.Name;
            }
            else
            {
                raw = (game.PluginId != Guid.Empty) ? "playnite-plugin" : "manual";
            }

            string clean = SanitizeText(raw, MaxSourceChars);
            return string.IsNullOrEmpty(clean) ? "manual" : clean;
        }

        // ---------------------------------------------------------------------
        // Cover -> self-contained data: URI.
        //
        // Only the DOCUMENTED PlayniteApi.Database.GetFullFilePath(game.CoverImage)
        // resolves a cover (library.html). We never build a path into Playnite's
        // undocumented library files ourselves. We emit ONLY sniffed, local image
        // bytes as a data: URI — NEVER file:, http(s):, javascript: or any remote
        // URL. A missing / oversized / unrecognized cover becomes null.
        // ---------------------------------------------------------------------
        private string BuildCoverDataUri(string coverImage)
        {
            if (string.IsNullOrEmpty(coverImage))
            {
                return null;
            }

            string fullPath;
            try
            {
                fullPath = PlayniteApi.Database.GetFullFilePath(coverImage);
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[VELORA] Cover path resolution failed: " + ex);
                return null;
            }

            if (string.IsNullOrEmpty(fullPath))
            {
                return null;
            }

            // Defensive: never follow a remote scheme even if one somehow appears.
            if (fullPath.StartsWith("http:", StringComparison.OrdinalIgnoreCase) ||
                fullPath.StartsWith("https:", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            FileInfo info = new FileInfo(fullPath);
            if (!info.Exists || info.Length <= 0 || info.Length > MaxCoverBytes)
            {
                return null;
            }

            byte[] bytes;
            try
            {
                bytes = File.ReadAllBytes(fullPath);
            }
            catch (Exception ex)
            {
                Debug.WriteLine("[VELORA] Cover read failed (treated as no cover): " + ex);
                return null;
            }

            string mime = SniffImageMime(bytes);
            if (mime == null)
            {
                return null;
            }

            string dataUri = "data:image/" + mime + ";base64," + Convert.ToBase64String(bytes);

            // Base64 expands bytes by ~4/3, so a 2,000,000-byte file yields a string
            // LONGER than the schema's 2,000,000-char cover maxLength. Emit null
            // rather than a value the VELORA parser would reject outright.
            if (dataUri.Length > MaxCoverChars)
            {
                return null;
            }

            return dataUri;
        }

        // Magic-byte sniffing. Returns the image subtype for the data-URI MIME, or
        // null when the bytes are not one of the four allowed image formats.
        private static string SniffImageMime(byte[] b)
        {
            if (b == null)
            {
                return null;
            }

            // PNG: 89 50 4E 47
            if (b.Length >= 4 && b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47)
            {
                return "png";
            }

            // JPEG: FF D8 FF
            if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF)
            {
                return "jpeg";
            }

            // GIF: "GIF8"
            if (b.Length >= 4 && b[0] == 0x47 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x38)
            {
                return "gif";
            }

            // WEBP: "RIFF" .... "WEBP" (the "WEBP" marker sits at offset 8).
            if (b.Length >= 12 &&
                b[0] == 0x52 && b[1] == 0x49 && b[2] == 0x46 && b[3] == 0x46 &&
                b[8] == 0x57 && b[9] == 0x45 && b[10] == 0x42 && b[11] == 0x50)
            {
                return "webp";
            }

            return null;
        }

        // ---------------------------------------------------------------------
        // Atomic write: %LOCALAPPDATA%\VELORA\Playnite\velora-library-manifest.json
        //
        // The file lives in VELORA's own LocalAppData folder — NOT inside the
        // extension install dir, which Playnite wipes on install/update
        // (dataDirectory.html). Written to a .tmp sibling first, then moved into
        // place with File.Replace (existing) / File.Move (new): both atomic on the
        // same volume. On ANY error the .tmp is removed and the existing
        // destination is left untouched. UTF-8, no BOM, so the file starts with '{'.
        // ---------------------------------------------------------------------
        private static void WriteAtomically(string json)
        {
            string dir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "VELORA",
                "Playnite");

            Directory.CreateDirectory(dir);

            string dest = Path.Combine(dir, ManifestFileName);
            string tmp = dest + ".tmp";

            try
            {
                File.WriteAllText(tmp, json, new UTF8Encoding(false));

                if (File.Exists(dest))
                {
                    File.Replace(tmp, dest, null);
                }
                else
                {
                    File.Move(tmp, dest);
                }
            }
            catch
            {
                // Best-effort cleanup; never damage the existing manifest.
                try
                {
                    if (File.Exists(tmp))
                    {
                        File.Delete(tmp);
                    }
                }
                catch
                {
                    // ignore cleanup errors
                }
                throw;
            }
        }

        // ---- small helpers --------------------------------------------------

        // ISO-8601 UTC, e.g. 2026-11-12T00:00:00Z (matches schema isoUtc pattern).
        private static string ToUtcIso(DateTime? value)
        {
            if (!value.HasValue)
            {
                return null;
            }
            // ToUniversalTime(): Local->UTC, Utc->unchanged, Unspecified->assumed
            // local then converted. Deterministic, single representation.
            DateTime utc = value.Value.ToUniversalTime();
            return utc.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
        }

        // Normalizes the SDK's int (PlayCount) / ulong (Playtime, seconds) through
        // one non-negative long clamp. Robust to the exact numeric type (and to
        // nullable boxing) and never emits a negative (schema: integer >= 0).
        private static long NonNegative(object raw)
        {
            if (raw == null)
            {
                return 0L;
            }
            try
            {
                decimal d = Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
                if (d <= 0m)
                {
                    return 0L;
                }
                if (d >= (decimal)long.MaxValue)
                {
                    return long.MaxValue;
                }
                return (long)d;
            }
            catch
            {
                return 0L;
            }
        }

        // Strips control characters (incl. NUL) and truncates to maxLength chars.
        // Used for name and source so their schema constraints always hold.
        private static string SanitizeText(string value, int maxLength)
        {
            if (string.IsNullOrEmpty(value))
            {
                return value;
            }
            var sb = new StringBuilder(value.Length);
            foreach (char c in value)
            {
                if (char.IsControl(c))
                {
                    continue;
                }
                sb.Append(c);
                if (sb.Length >= maxLength)
                {
                    break;
                }
            }
            return sb.ToString();
        }
    }
}
