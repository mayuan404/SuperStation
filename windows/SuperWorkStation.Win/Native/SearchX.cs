using System.Text;
using System.Text.RegularExpressions;

namespace SuperWorkStation;

/// <summary>文件名 + 内容搜索，行为与 macOS 端一致（文件名命中排在内容命中之前）。</summary>
internal static class SearchX
{
    private static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv",
        "target", ".idea", "Pods"
    };

    private static readonly HashSet<string> SkipFiles = new(StringComparer.OrdinalIgnoreCase)
    {
        "package-lock.json"
    };

    public static List<Dictionary<string, object?>> Search(
        string root, string query, int limit, bool caseSensitive, bool wholeWord, bool namesOnly, double budget)
    {
        var outList = new List<Dictionary<string, object?>>();
        var baseDir = PathUtil.FromJs(root);
        if (string.IsNullOrEmpty(query) || !Directory.Exists(baseDir)) return outList;

        var started = DateTime.UtcNow;
        var pattern = Regex.Escape(query);
        if (wholeWord) pattern = @"(?<![\p{L}\p{N}_])" + pattern + @"(?![\p{L}\p{N}_])";
        var options = RegexOptions.CultureInvariant;
        if (!caseSensitive) options |= RegexOptions.IgnoreCase;
        Regex re;
        try { re = new Regex(pattern, options, TimeSpan.FromSeconds(2)); }
        catch (ArgumentException) { return outList; }

        var nameHits = new List<Dictionary<string, object?>>();
        var contentHits = new List<Dictionary<string, object?>>();
        const int nameCap = 60;

        foreach (var file in Walk(baseDir))
        {
            if (nameHits.Count >= nameCap && contentHits.Count >= limit) break;
            if ((DateTime.UtcNow - started).TotalSeconds > budget) break;

            var name = Path.GetFileName(file);
            var display = name;
            if (name.StartsWith('.')) continue;

            try
            {
                if (re.IsMatch(display) && nameHits.Count < nameCap)
                {
                    nameHits.Add(new Dictionary<string, object?>
                    {
                        ["path"] = PathUtil.ToJs(file),
                        ["name"] = display,
                        ["line"] = 0,
                        ["preview"] = "文件名匹配",
                        ["kind"] = "name",
                        ["encrypted"] = false
                    });
                }
                if (namesOnly || contentHits.Count >= limit) continue;

                var info = new FileInfo(file);
                if (info.Length > 2_000_000) continue;
                var bytes = File.ReadAllBytes(file);
                if (!FsX.LooksLikeText(bytes)) continue;

                var text = Encoding.UTF8.GetString(bytes);
                var lines = text.Split('\n');
                var found = 0;
                for (var i = 0; i < lines.Length && found < 3 && contentHits.Count < limit; i++)
                {
                    var line = lines[i].TrimEnd('\r');
                    if (!re.IsMatch(line)) continue;
                    var preview = line.Trim();
                    if (preview.Length > 180) preview = preview[..180];
                    contentHits.Add(new Dictionary<string, object?>
                    {
                        ["path"] = PathUtil.ToJs(file),
                        ["name"] = display,
                        ["line"] = i + 1,
                        ["preview"] = preview,
                        ["kind"] = "content",
                        ["encrypted"] = false
                    });
                    found++;
                }
            }
            catch
            {
                // 单个文件读失败不影响整轮搜索
            }
        }

        outList.AddRange(nameHits);
        outList.AddRange(contentHits);
        return outList;
    }

    private static IEnumerable<string> Walk(string root)
    {
        var stack = new Stack<string>();
        stack.Push(root);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            string[] entries;
            try { entries = Directory.GetFileSystemEntries(dir); }
            catch { continue; }

            foreach (var full in entries)
            {
                var name = Path.GetFileName(full);
                if (name.StartsWith('.')) continue;
                if (Directory.Exists(full))
                {
                    if (SkipDirs.Contains(name)) continue;
                    stack.Push(full);
                }
                else
                {
                    if (SkipFiles.Contains(name)) continue;
                    yield return full;
                }
            }
        }
    }
}
