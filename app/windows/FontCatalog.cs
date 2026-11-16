using System.Text;
using System.Text.Json;
using Microsoft.Win32;

namespace FindMyType;

/// <summary>
/// Lists the fonts installed on this PC (machine-wide and per-user), reading each font
/// file's own data: family/style names, weight, width, italic, variable axes and design
/// class (OS/2 sFamilyClass, then PANOSE). Same face format as the Mac app.
/// The list is cached on disk so launches are instant.
/// </summary>
internal sealed class FontCatalog
{
    public const string FontHost = "fonts.findmytype.local";

    private readonly object gate = new();
    private readonly string cachePath;
    private string? catalogJson;
    private Dictionary<string, string> files = new(); // token → font file path

    public FontCatalog()
    {
        var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "FindMyType");
        Directory.CreateDirectory(dir);
        cachePath = Path.Combine(dir, "font-catalog-v2.json");
    }

    /// <summary>JSON array of faces. fresh = ignore memory and disk caches and rescan.</summary>
    public string Get(bool fresh)
    {
        lock (gate)
        {
            if (!fresh && catalogJson != null) return catalogJson;
            if (!fresh && File.Exists(cachePath))
            {
                try
                {
                    var cached = JsonSerializer.Deserialize<List<Dictionary<string, JsonElement>>>(File.ReadAllText(cachePath));
                    if (cached is { Count: > 0 })
                    {
                        var result = Register(cached.Select(ToObjects).ToList());
                        _ = Task.Run(RefreshCache); // pick up newly installed fonts for next time
                        return result;
                    }
                }
                catch { /* unreadable cache: rescan */ }
            }
            var faces = Scan();
            Save(faces);
            return Register(faces);
        }
    }

    /// <summary>Font file bytes for a token URL (served to WebView2).</summary>
    public string? PathForToken(string token)
    {
        lock (gate) return files.TryGetValue(token, out var path) ? path : null;
    }

    private void RefreshCache()
    {
        try { Save(Scan()); } catch { /* best effort */ }
    }

    private void Save(List<Dictionary<string, object?>> faces)
    {
        try { File.WriteAllText(cachePath, JsonSerializer.Serialize(faces)); } catch { /* best effort */ }
    }

    private static Dictionary<string, object?> ToObjects(Dictionary<string, JsonElement> face) =>
        face.ToDictionary(kv => kv.Key, kv => (object?)(kv.Value.ValueKind switch
        {
            JsonValueKind.String => kv.Value.GetString(),
            JsonValueKind.Number => kv.Value.GetDouble(),
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => null,
        }));

    /// <summary>Give each font file a token URL and keep the result in memory.</summary>
    private string Register(List<Dictionary<string, object?>> raw)
    {
        var tokens = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var map = new Dictionary<string, string>();
        var faces = new List<Dictionary<string, object?>>();
        foreach (var face in raw)
        {
            if (face.GetValueOrDefault("path") is not string path || !File.Exists(path)) continue;
            if (!tokens.TryGetValue(path, out var token))
            {
                token = tokens.Count.ToString();
                tokens[path] = token;
                map[token] = path;
            }
            var copy = new Dictionary<string, object?>(face) { ["file"] = $"https://{FontHost}/{token}" };
            copy.Remove("path");
            faces.Add(copy);
        }
        files = map;
        catalogJson = JsonSerializer.Serialize(faces);
        return catalogJson;
    }

    // ---------------------------------------------------------------- scanning

    private static List<Dictionary<string, object?>> Scan()
    {
        var faces = new List<Dictionary<string, object?>>();
        foreach (var path in InstalledFontFiles())
        {
            try { faces.AddRange(OpenTypeReader.ReadFaces(path)); }
            catch { /* skip unreadable or unsupported files */ }
        }
        return faces;
    }

    /// <summary>Font files registered for the machine and for the current user.</summary>
    private static IEnumerable<string> InstalledFontFiles()
    {
        var windowsFonts = Environment.GetFolderPath(Environment.SpecialFolder.Fonts);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var hive in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            using var key = hive.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts");
            if (key == null) continue;
            foreach (var name in key.GetValueNames())
            {
                if (key.GetValue(name) is not string file || file.Length == 0) continue;
                var path = Path.IsPathRooted(file) ? file : Path.Combine(windowsFonts, file);
                var ext = Path.GetExtension(path).ToLowerInvariant();
                if (ext is not (".ttf" or ".otf" or ".ttc" or ".otc")) continue;
                if (seen.Add(path) && File.Exists(path)) yield return path;
            }
        }
    }
}

/// <summary>Minimal OpenType/TrueType reader: just the tables needed for the catalogue.</summary>
internal static class OpenTypeReader
{
    public static IEnumerable<Dictionary<string, object?>> ReadFaces(string path)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 4096, FileOptions.RandomAccess);
        var reader = new BigEndian(file);
        var created = new DateTimeOffset(File.GetCreationTimeUtc(path)).ToUnixTimeMilliseconds();
        var extension = Path.GetExtension(path).ToLowerInvariant();

        var offsets = new List<long>();
        if (reader.U32(0) == 0x74746366) // 'ttcf' collection
        {
            var count = reader.U32(8);
            for (var i = 0; i < count && i < 256; i++) offsets.Add(reader.U32(12 + i * 4));
        }
        else offsets.Add(0);

        var faces = new List<Dictionary<string, object?>>();
        foreach (var offset in offsets)
        {
            var face = ReadFace(reader, offset);
            if (face == null) continue;
            face["path"] = path;
            face["extension"] = extension;
            face["installedAt"] = created;
            faces.Add(face);
        }
        return faces;
    }

    private static Dictionary<string, object?>? ReadFace(BigEndian r, long offset)
    {
        var version = r.U32(offset);
        if (version is not (0x00010000 or 0x4F54544F or 0x74727565)) return null; // TrueType, 'OTTO', 'true'

        var numTables = r.U16(offset + 4);
        var tables = new Dictionary<string, (long Offset, long Length)>();
        for (var i = 0; i < numTables; i++)
        {
            var record = offset + 12 + i * 16;
            var tag = Encoding.ASCII.GetString(r.Bytes(record, 4));
            tables[tag] = (r.U32(record + 8), r.U32(record + 12));
        }
        if (!tables.TryGetValue("name", out var name)) return null;

        var family = NameString(r, name.Offset, 16) ?? NameString(r, name.Offset, 1);
        if (string.IsNullOrWhiteSpace(family) || family.StartsWith('@') || family.StartsWith('.')) return null;
        var style = NameString(r, name.Offset, 17) ?? NameString(r, name.Offset, 2) ?? "Regular";

        var face = new Dictionary<string, object?>
        {
            ["family"] = family.Trim(),
            ["style"] = style.Trim(),
            ["fullName"] = NameString(r, name.Offset, 4) ?? family,
            ["postscriptName"] = NameString(r, name.Offset, 6) ?? "",
            ["variable"] = tables.ContainsKey("fvar"),
        };

        var monospace = tables.TryGetValue("post", out var post) && post.Length >= 16 && r.U32(post.Offset + 12) != 0;
        string? category = monospace ? "Monospace" : null;

        if (tables.TryGetValue("OS/2", out var os2) && os2.Length >= 42)
        {
            var weightClass = r.U16(os2.Offset + 4);
            if (weightClass is > 0 and < 10) weightClass *= 100; // a few old fonts use 1–9
            face["weight"] = Math.Clamp((int)Math.Round(weightClass / 100.0) * 100, 100, 900);

            var widthClass = r.U16(os2.Offset + 6);
            face["width"] = widthClass is > 0 and <= 4 ? "condensed" : widthClass >= 6 ? "expanded" : "normal";

            if (os2.Length >= 64)
            {
                var selection = r.U16(os2.Offset + 62);
                face["italic"] = (selection & 0x1) != 0 || (selection & 0x200) != 0; // ITALIC or OBLIQUE
            }

            var panose = r.Bytes(os2.Offset + 32, 10);
            category ??= FamilyClassCategory(r.Bytes(os2.Offset + 30, 1)[0]) ?? PanoseCategory(panose);
        }
        if (!face.ContainsKey("italic"))
            face["italic"] = style.Contains("italic", StringComparison.OrdinalIgnoreCase) || style.Contains("oblique", StringComparison.OrdinalIgnoreCase);
        if (category != null) face["category"] = category;
        return face;
    }

    /// <summary>OS/2 sFamilyClass (high byte) → category.</summary>
    private static string? FamilyClassCategory(byte familyClass) => familyClass switch
    {
        1 or 2 or 3 or 4 or 5 or 7 => "Serif",
        8 => "Sans serif",
        9 or 12 => "Display",
        10 => "Handwriting",
        _ => null,
    };

    /// <summary>PANOSE family type / serif style / proportion → category.</summary>
    private static string? PanoseCategory(byte[] panose) => panose[0] switch
    {
        2 when panose[3] == 9 => "Monospace",
        2 when panose[1] is >= 2 and <= 10 => "Serif",
        2 when panose[1] is >= 11 and <= 15 => "Sans serif",
        3 => "Handwriting",
        4 or 5 => "Display",
        _ => null,
    };

    /// <summary>Best English string for a name ID (Windows Unicode first, then Mac Roman).</summary>
    private static string? NameString(BigEndian r, long table, int nameId)
    {
        var count = r.U16(table + 2);
        var storage = table + r.U16(table + 4);
        (int Score, long Offset, int Length, bool Unicode)? best = null;
        for (var i = 0; i < count; i++)
        {
            var rec = table + 6 + i * 12;
            if (r.U16(rec + 6) != nameId) continue;
            var platform = r.U16(rec);
            var encoding = r.U16(rec + 2);
            var language = r.U16(rec + 4);
            var score = platform switch
            {
                3 when encoding is 1 or 10 => language == 0x409 ? 100 : 60,
                3 when encoding == 0 => 50,
                0 => 40,
                1 when encoding == 0 => language == 0 ? 30 : 10,
                _ => 0,
            };
            if (score > (best?.Score ?? 0)) best = (score, storage + r.U16(rec + 10), r.U16(rec + 8), platform != 1);
        }
        if (best is not { } b || b.Length == 0) return null;
        var bytes = r.Bytes(b.Offset, b.Length);
        var text = b.Unicode ? Encoding.BigEndianUnicode.GetString(bytes) : Encoding.Latin1.GetString(bytes);
        text = text.Trim('\0', ' ');
        return text.Length > 0 ? text : null;
    }

    private sealed class BigEndian(FileStream stream)
    {
        public byte[] Bytes(long offset, int count)
        {
            if (offset < 0 || offset + count > stream.Length) throw new EndOfStreamException();
            stream.Position = offset;
            var buffer = new byte[count];
            var read = 0;
            while (read < count)
            {
                var n = stream.Read(buffer, read, count - read);
                if (n <= 0) throw new EndOfStreamException();
                read += n;
            }
            return buffer;
        }

        public ushort U16(long offset)
        {
            var b = Bytes(offset, 2);
            return (ushort)((b[0] << 8) | b[1]);
        }

        public uint U32(long offset)
        {
            var b = Bytes(offset, 4);
            return ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];
        }
    }
}
