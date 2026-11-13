using System.Text;

namespace SuperWorkStation;

/// <summary>
/// 网页层全程使用 POSIX 风格路径（C:/Users/x/…）。原生层在进/出边界处转换，
/// 其余逻辑一律用正斜杠，避免每个命令都做一次替换。
/// </summary>
internal static class PathUtil
{
    public static bool IsRemote(string path) => path.StartsWith("ssh://", StringComparison.Ordinal);

    public static string ToJs(string path)
    {
        if (string.IsNullOrEmpty(path)) return path;
        if (IsRemote(path)) return path;
        var p = path.Replace('\\', '/');
        // 去掉末尾斜杠，但保留盘符根：C:/
        if (p.Length > 3 && p.EndsWith('/')) p = p.TrimEnd('/');
        return p;
    }

    public static string FromJs(string path)
    {
        if (string.IsNullOrEmpty(path)) return path;
        if (IsRemote(path)) return path;
        return path.Replace('/', '\\');
    }

    /// <summary>解析成绝对路径，再转回 POSIX 形态。</summary>
    public static string Full(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return path;
        if (IsRemote(path)) return path;
        var full = Path.GetFullPath(FromJs(path));
        return ToJs(full);
    }

    public static bool IsUnder(string root, string path)
    {
        if (string.IsNullOrEmpty(root) || string.IsNullOrEmpty(path)) return false;
        var r = root.Replace('\\', '/').TrimEnd('/');
        var p = path.Replace('\\', '/').TrimEnd('/');
        if (p.Equals(r, StringComparison.OrdinalIgnoreCase)) return true;
        return p.StartsWith(r + "/", StringComparison.OrdinalIgnoreCase);
    }

    public static string Join(string dir, string name)
    {
        if (string.IsNullOrEmpty(dir)) return name;
        var d = dir.TrimEnd('/');
        var n = name.TrimStart('/');
        return IsRemote(dir) ? $"{d}/{n}" : $"{d}/{n}";
    }

    public static string DirName(string path)
    {
        var i = path.LastIndexOf('/');
        if (i <= 0) return path.Length > 2 && path[1] == ':' ? path[..3] : "/";
        return path[..i];
    }

    public static string BaseName(string path)
    {
        var i = path.LastIndexOf('/');
        return i < 0 ? path : path[(i + 1)..];
    }

    public static string Ext(string path)
    {
        var name = BaseName(path);
        var i = name.LastIndexOf('.');
        return i <= 0 ? "" : name[(i + 1)..].ToLowerInvariant();
    }

    public static string Base64UrlEncode(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(text);
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    public static string? Base64UrlDecode(string text)
    {
        try
        {
            var s = text.Replace('-', '+').Replace('_', '/');
            switch (s.Length % 4)
            {
                case 2: s += "=="; break;
                case 3: s += "="; break;
            }
            return Encoding.UTF8.GetString(Convert.FromBase64String(s));
        }
        catch
        {
            return null;
        }
    }

    /// <summary>稳定哈希（FNV-1a 64），与 macOS 端同一算法，历史/草稿目录名可对齐。</summary>
    public static string StableHash(string s)
    {
        ulong h = 0xcbf29ce484222325UL;
        foreach (var b in Encoding.UTF8.GetBytes(s))
        {
            h ^= b;
            h *= 0x100000001b3UL;
        }
        return h.ToString("x");
    }
}
