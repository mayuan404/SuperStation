using System.Text;
using System.Text.Json;

namespace SuperWorkStation;

/// <summary>保存历史（覆盖写前的旧版本）与崩溃草稿，目录布局对齐 macOS 端。</summary>
internal static class DocsStore
{
    private const int Keep = 20;
    private static readonly TimeSpan MinInterval = TimeSpan.FromSeconds(45);
    private static readonly object Lock = new();

    private static string HistoryRoot => Path.Combine(AppPaths.Support, "history");
    private static string DraftsRoot => Path.Combine(AppPaths.Support, "drafts");

    private static string HistoryDir(string path)
    {
        var dir = Path.Combine(HistoryRoot, PathUtil.StableHash(path));
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string DraftFile(string path)
    {
        Directory.CreateDirectory(DraftsRoot);
        return Path.Combine(DraftsRoot, PathUtil.StableHash(path) + ".json");
    }

    public static void SnapshotHistory(string path, byte[] previous, DateTime mtimeUtc)
    {
        lock (Lock)
        {
            try
            {
                var dir = HistoryDir(path);
                var files = Directory.EnumerateFiles(dir, "*.bak")
                    .OrderBy(f => f, StringComparer.Ordinal).ToList();
                if (files.Count > 0)
                {
                    var last = Path.GetFileNameWithoutExtension(files[^1]);
                    if (long.TryParse(last, out var stamp))
                    {
                        var age = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - stamp;
                        if (age < MinInterval.TotalSeconds) return;
                    }
                }
                var ts = DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString();
                var target = Path.Combine(dir, ts + ".bak");
                int n = 1;
                while (File.Exists(target)) target = Path.Combine(dir, ts + "-" + n++ + ".bak");
                File.WriteAllBytes(target, previous);

                var all = Directory.EnumerateFiles(dir, "*.bak")
                    .OrderBy(f => f, StringComparer.Ordinal).ToList();
                foreach (var old in all.Take(Math.Max(0, all.Count - Keep))) File.Delete(old);
            }
            catch
            {
                // 历史快照失败不影响保存
            }
        }
    }

    public static List<Dictionary<string, object?>> HistoryList(string path)
    {
        var dir = HistoryDir(path);
        var outList = new List<Dictionary<string, object?>>();
        foreach (var file in Directory.EnumerateFiles(dir, "*.bak").OrderByDescending(f => f, StringComparer.Ordinal))
        {
            var name = Path.GetFileName(file);
            var stem = Path.GetFileNameWithoutExtension(name);
            var tsText = stem.Split('-')[0];
            _ = long.TryParse(tsText, out var ts);
            outList.Add(new Dictionary<string, object?>
            {
                ["id"] = name,
                ["ts"] = ts,
                ["size"] = new FileInfo(file).Length
            });
        }
        return outList;
    }

    public static string? HistoryRead(string path, string id)
    {
        if (string.IsNullOrEmpty(id) || id.Contains('/') || id.Contains('\\')) return null;
        if (!id.EndsWith(".bak", StringComparison.OrdinalIgnoreCase)) return null;
        var file = Path.Combine(HistoryDir(path), id);
        if (!File.Exists(file)) return null;
        return File.ReadAllText(file, Encoding.UTF8);
    }

    public static void PutDraft(string path, string name, string text)
    {
        var payload = new Dictionary<string, object?>
        {
            ["path"] = path,
            ["name"] = name,
            ["text"] = text,
            ["at"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() / 1000.0
        };
        File.WriteAllText(DraftFile(path), JsonSerializer.Serialize(payload), Encoding.UTF8);
    }

    public static void DropDraft(string path)
    {
        try { File.Delete(DraftFile(path)); } catch { }
    }

    public static List<Dictionary<string, object?>> ListDrafts()
    {
        var outList = new List<Dictionary<string, object?>>();
        if (!Directory.Exists(DraftsRoot)) return outList;
        foreach (var file in Directory.EnumerateFiles(DraftsRoot, "*.json"))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(file, Encoding.UTF8));
                var root = doc.RootElement;
                var text = root.TryGetProperty("text", out var t) ? t.GetString() ?? "" : "";
                outList.Add(new Dictionary<string, object?>
                {
                    ["path"] = root.TryGetProperty("path", out var p) ? p.GetString() ?? "" : "",
                    ["name"] = root.TryGetProperty("name", out var n) ? n.GetString() ?? "" : "",
                    ["at"] = root.TryGetProperty("at", out var a) ? a.GetDouble() : 0,
                    ["size"] = text.Length,
                    ["preview"] = text.Length > 120 ? text[..120] : text
                });
            }
            catch
            {
                // 损坏的草稿文件跳过
            }
        }
        return outList.OrderByDescending(x => (double)(x["at"] ?? 0.0)).ToList();
    }

    public static string? ReadDraft(string path)
    {
        var file = DraftFile(path);
        if (!File.Exists(file)) return null;
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(file, Encoding.UTF8));
            return doc.RootElement.TryGetProperty("text", out var t) ? t.GetString() : null;
        }
        catch
        {
            return null;
        }
    }
}
