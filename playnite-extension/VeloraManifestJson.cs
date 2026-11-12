// VeloraManifestJson.cs
//
// SERIALIZER CHOICE (deliberate, see README.md):
//   The Playnite SDK documents Playnite.SDK.Data.Serialization.ToJson(obj) with
//   [SerializationPropertyName("...")]-style attributes, but the exact attribute
//   name, null-handling and casing behavior are SDK-version dependent. To
//   guarantee 100% exact camelCase keys, explicit `null` emission, and strict
//   compliance with additionalProperties:false in the VELORA schema, we DO NOT
//   use any reflection-based serializer here. Instead we use a tiny StringBuilder
//   JSON writer with a proper JsonEscape() string escaper: every key is an
//   explicit string literal, so the output is completely under our control and
//   matches the contract exactly. This is the preferred approach for correctness.
//
//   (If the SDK serializer were used instead, EVERY property would need the exact
//    attribute AND nulls would still have to be emitted, otherwise the parser's
//    additionalProperties:false / required checks would reject the manifest.)

using System.Globalization;
using System.Text;

namespace VeloraLibraryExporter
{
    internal static class VeloraManifestJson
    {
        public static string ToJson(VeloraManifestDto m)
        {
            var sb = new StringBuilder(4096);
            sb.Append('{');

            sb.Append("\"schemaVersion\":").Append(m.schemaVersion.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"kind\":").Append(JsonString(m.kind));
            sb.Append(",\"generatedAt\":").Append(JsonString(m.generatedAt));
            sb.Append(",\"extension\":{\"id\":").Append(JsonString(m.extension.id))
              .Append(",\"version\":").Append(JsonString(m.extension.version)).Append('}');
            sb.Append(",\"source\":").Append(JsonString(m.source));
            sb.Append(",\"readOnly\":").Append(m.readOnly ? "true" : "false");
            sb.Append(",\"games\":[");
            for (int i = 0; i < m.games.Count; i++)
            {
                if (i > 0)
                {
                    sb.Append(',');
                }
                AppendGame(sb, m.games[i]);
            }
            sb.Append(']');
            sb.Append('}');
            return sb.ToString();
        }

        private static void AppendGame(StringBuilder sb, VeloraGameDto g)
        {
            sb.Append('{');
            sb.Append("\"id\":").Append(JsonString(g.id));
            sb.Append(",\"name\":").Append(JsonString(g.name));
            sb.Append(",\"cover\":").Append(JsonStringOrNull(g.cover));
            sb.Append(",\"source\":").Append(JsonString(g.source));
            sb.Append(",\"lastPlayed\":").Append(JsonStringOrNull(g.lastPlayed));
            sb.Append(",\"favorite\":").Append(g.favorite ? "true" : "false");
            sb.Append(",\"installed\":").Append(g.installed ? "true" : "false");
            sb.Append(",\"playCount\":").Append(g.playCount.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"playtimeSeconds\":").Append(g.playtimeSeconds.ToString(CultureInfo.InvariantCulture));
            sb.Append(",\"launch\":");
            if (g.launch == null)
            {
                sb.Append("null");
            }
            else
            {
                sb.Append("{\"kind\":").Append(JsonString(g.launch.kind))
                  .Append(",\"uri\":").Append(JsonString(g.launch.uri)).Append('}');
            }
            sb.Append('}');
        }

        private static string JsonStringOrNull(string s)
        {
            return s == null ? "null" : JsonString(s);
        }

        private static string JsonString(string s)
        {
            return "\"" + JsonEscape(s) + "\"";
        }

        // Proper JSON string escaper: quote / backslash, the standard short
        // escapes, and any remaining C0/C1 control characters as \uXXXX.
        // Non-control Unicode is left as-is (the file is written as UTF-8).
        // Defense in depth: name/source are already control-char-stripped.
        public static string JsonEscape(string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                return string.Empty;
            }
            var sb = new StringBuilder(s.Length + 8);
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || (c >= 0x7f && c <= 0x9f))
                        {
                            sb.Append("\\u");
                            sb.Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            return sb.ToString();
        }
    }
}
