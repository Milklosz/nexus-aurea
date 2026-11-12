// VeloraManifestDto.cs
//
// Plain POCO DTOs with EXPLICIT camelCase property names.
//
// These types mirror docs/schemas/velora-playnite-manifest.schema.json exactly:
// that schema sets additionalProperties:false at EVERY level, so no extra field
// may ever be emitted, and the JSON keys must match byte-for-byte. The keys are
// written as explicit string literals by VeloraManifestJson, so their casing does
// not depend on any serializer's naming convention.

using System.Collections.Generic;

namespace VeloraLibraryExporter
{
    internal sealed class VeloraManifestDto
    {
        public int schemaVersion { get; set; }
        public string kind { get; set; }
        public string generatedAt { get; set; }
        public VeloraExtensionDto extension { get; set; }
        public string source { get; set; }
        public bool readOnly { get; set; }
        public List<VeloraGameDto> games { get; set; }
    }

    internal sealed class VeloraExtensionDto
    {
        public string id { get; set; }
        public string version { get; set; }
    }

    internal sealed class VeloraGameDto
    {
        public string id { get; set; }
        public string name { get; set; }
        // JSON null is allowed for cover / lastPlayed / launch.
        public string cover { get; set; }
        public string source { get; set; }
        public string lastPlayed { get; set; }
        public bool favorite { get; set; }
        public bool installed { get; set; }
        public long playCount { get; set; }
        public long playtimeSeconds { get; set; }
        public VeloraLaunchDto launch { get; set; }
    }

    internal sealed class VeloraLaunchDto
    {
        public string kind { get; set; }
        public string uri { get; set; }
    }
}
