using System.Diagnostics;
using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace SuperWorkStation;

/// <summary>压缩包解压：zip 用内置实现，tar 系交给系统自带的 tar.exe。</summary>
internal static class ArchiveX
{
    public static Dictionary<string, object?> Extract(string path)
    {
        var archive = PathUtil.FromJs(path);
        if (!FsX.IsArchive(path) || !File.Exists(archive))
            throw new ApiException("不支持的压缩格式");

        var ext = PathUtil.Ext(path);
        var baseDir = Path.GetDirectoryName(archive)!;
        var name = Path.GetFileNameWithoutExtension(archive);
        if (ext is "gz" or "bz2" or "xz" or "tgz" or "zst")
        {
            var inner = Path.GetExtension(name).TrimStart('.').ToLowerInvariant();
            if (inner is "tar" or "") name = Path.GetFileNameWithoutExtension(name);
        }

        var dest = Path.Combine(baseDir, name);
        var n = 2;
        while (Directory.Exists(dest) || File.Exists(dest)) dest = Path.Combine(baseDir, $"{name} {n++}");
        Directory.CreateDirectory(dest);

        try
        {
            if (ext is "zip")
            {
                ZipFile.ExtractToDirectory(archive, dest, overwriteFiles: true);
            }
            else
            {
                var psi = new ProcessStartInfo("tar.exe", $"-xf \"{archive}\" -C \"{dest}\"")
                {
                    UseShellExecute = false,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };
                using var proc = Process.Start(psi)!;
                var err = proc.StandardError.ReadToEnd();
                proc.WaitForExit();
                if (proc.ExitCode != 0) throw new ApiException("解压失败：" + err.Trim());
            }
        }
        catch (Exception ex) when (ex is not ApiException)
        {
            try { Directory.Delete(dest, recursive: true); } catch { }
            throw new ApiException("解压失败：" + ex.Message);
        }

        return new Dictionary<string, object?> { ["dir"] = PathUtil.ToJs(dest) };
    }
}

/// <summary>轻量语法检查：有 node/python 就用，没有就静默跳过。</summary>
internal static class ChecksX
{
    public static List<Dictionary<string, object?>> Run(string path, string text)
    {
        var ext = PathUtil.Ext(path);
        if (ext is not ("py" or "js" or "mjs" or "cjs")) return [];

        var tmp = Path.Combine(Path.GetTempPath(), "SuperWorkStation", "check",
            $"check-{Guid.NewGuid():N}.{ext}");
        Directory.CreateDirectory(Path.GetDirectoryName(tmp)!);
        File.WriteAllText(tmp, text, new UTF8Encoding(false));
        try
        {
            string output;
            if (ext == "py")
            {
                var script = "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read(),sys.argv[1])";
                output = Exec(FindOnPath("python") ?? FindOnPath("python3"), ["-c", script, tmp]);
                return ParsePython(output, text);
            }
            output = Exec(FindOnPath("node"), ["--check", tmp]);
            return ParseNode(output, text);
        }
        finally
        {
            try { File.Delete(tmp); } catch { }
        }
    }

    private static string? FindOnPath(string exe)
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            if (string.IsNullOrWhiteSpace(dir)) continue;
            var candidate = Path.Combine(dir.Trim(), exe + ".exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    private static string Exec(string? exe, string[] args)
    {
        if (exe is null) return "";
        try
        {
            var psi = new ProcessStartInfo(exe)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            foreach (var a in args) psi.ArgumentList.Add(a);
            using var proc = Process.Start(psi);
            if (proc is null) return "";
            var output = proc.StandardOutput.ReadToEnd() + proc.StandardError.ReadToEnd();
            if (!proc.WaitForExit(4000)) { try { proc.Kill(); } catch { } }
            return output;
        }
        catch
        {
            return "";
        }
    }

    private static List<Dictionary<string, object?>> ParsePython(string output, string source)
    {
        var line = 0;
        var m = Regex.Match(output, @"line (\d+)");
        if (m.Success) int.TryParse(m.Groups[1].Value, out line);
        var msg = Regex.Match(output, @"(SyntaxError|IndentationError|TabError)[:\s]*(.*)");
        return
        [
            new Dictionary<string, object?>
            {
                ["line"] = line,
                ["message"] = msg.Success && msg.Groups[2].Value.Length > 0 ? msg.Groups[2].Value.Trim() : "语法错误",
                ["severity"] = "error"
            }
        ];
    }

    private static List<Dictionary<string, object?>> ParseNode(string output, string source)
    {
        var m = Regex.Match(output, @"\w+\.(?:js|mjs|cjs):(\d+)");
        var line = m.Success ? int.Parse(m.Groups[1].Value) : 0;
        var msg = Regex.Match(output, @"(SyntaxError|ReferenceError)[:\s]*(.*)");
        if (line == 0 && !msg.Success) return [];
        return
        [
            new Dictionary<string, object?>
            {
                ["line"] = line,
                ["message"] = msg.Success && msg.Groups[2].Value.Length > 0 ? msg.Groups[2].Value.Trim() : "语法错误",
                ["severity"] = "error"
            }
        ];
    }
}

/// <summary>给 AI 用的纯文本抽取（PDF 由 PdfX 负责）。</summary>
internal static class TextX
{
    public static Dictionary<string, object?> Extract(string path, int limit = 240_000)
    {
        var native = PathUtil.FromJs(path);
        var ext = PathUtil.Ext(path);
        var text = "";
        try
        {
            switch (ext)
            {
                case "pdf":
                    text = PdfX.Text(path);
                    break;
                case "html" or "htm" or "xhtml":
                    text = StripTags(File.ReadAllText(native, Encoding.UTF8));
                    break;
                default:
                    var bytes = File.ReadAllBytes(native);
                    if (FsX.LooksLikeText(bytes)) text = Encoding.UTF8.GetString(bytes);
                    break;
            }
        }
        catch
        {
            text = "";
        }

        var truncated = text.Length > limit;
        if (truncated) text = text[..limit];
        return new Dictionary<string, object?>
        {
            ["text"] = text,
            ["truncated"] = truncated,
            ["chars"] = text.Length
        };
    }

    public static string StripTags(string html)
    {
        var s = Regex.Replace(html, @"(?is)<(script|style)[^>]*>.*?</\1>", " ");
        s = Regex.Replace(s, @"(?is)<(br|/p|/div|/h[1-6]|/li)[^>]*>", "\n");
        s = Regex.Replace(s, "(?is)<[^>]+>", " ");
        s = s.Replace("&nbsp;", " ").Replace("&amp;", "&").Replace("&lt;", "<")
             .Replace("&gt;", ">").Replace("&quot;", "\"");
        s = Regex.Replace(s, @"[ \t]+", " ");
        s = Regex.Replace(s, @"\n{3,}", "\n\n");
        return s.Trim();
    }
}
