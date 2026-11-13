using System.Diagnostics;
using System.Text;
using Renci.SshNet;
using Renci.SshNet.Sftp;

namespace SuperWorkStation;

/// <summary>SSH 远端操作：连接池 + SFTP 文件操作 + 远端命令（git / find / du）。</summary>
internal static class RemoteX
{
    private static readonly object Lock = new();
    private static readonly Dictionary<string, SshTarget> Registry = new(StringComparer.Ordinal);

    public static void Register(string id, string host, int port, string user, string secretId)
    {
        if (string.IsNullOrEmpty(id) || string.IsNullOrEmpty(host)) return;
        lock (Lock)
        {
            Registry[id] = new SshTarget
            {
                Host = host,
                Port = port <= 0 ? 22 : port,
                User = string.IsNullOrEmpty(user) ? "root" : user,
                SecretId = secretId ?? ""
            };
        }
    }

    public static SshTarget? Lookup(string id)
    {
        lock (Lock) return Registry.TryGetValue(id, out var target) ? target : null;
    }

    public static void Forget(string id)
    {
        SshTarget? target;
        lock (Lock)
        {
            Registry.TryGetValue(id, out target);
            Registry.Remove(id);
        }
        if (target is not null) SshPool.Drop(target);
    }

    private static Dictionary<string, object?> Error(string message) =>
        new() { ["error"] = message };

    public static Dictionary<string, object?> Warm(SshTarget target, bool mockLocal = false)
    {
        var started = Stopwatch.StartNew();
        if (mockLocal)
        {
            return new Dictionary<string, object?> { ["ok"] = true, ["ms"] = 0 };
        }
        try
        {
            var conn = SshPool.Get(target);
            lock (conn.Gate)
            {
                using var cmd = conn.Client.CreateCommand("true");
                cmd.CommandTimeout = TimeSpan.FromSeconds(20);
                cmd.Execute();
            }
            return new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["ms"] = (int)started.ElapsedMilliseconds
            };
        }
        catch (Exception ex)
        {
            SshPool.Drop(target);
            return Error(ex.Message);
        }
    }

    public static Dictionary<string, object?> List(SshTarget target, string path)
    {
        try
        {
            var conn = SshPool.Get(target);
            List<Dictionary<string, object?>> entries;
            lock (conn.Gate)
            {
                entries = conn.Sftp.ListDirectory(path)
                    .Where(e => e.Name is not ("." or ".."))
                    .Select(e => new Dictionary<string, object?>
                    {
                        ["name"] = e.Name,
                        ["isDir"] = e.IsDirectory,
                        ["size"] = e.IsRegularFile ? e.Attributes.Size : 0,
                        ["mode"] = ModeString(e),
                        ["mtime"] = new DateTimeOffset(e.LastWriteTimeUtc).ToUnixTimeSeconds()
                    })
                    .OrderByDescending(e => (bool)(e["isDir"] ?? false))
                    .ThenBy(e => (string?)e["name"], StringComparer.OrdinalIgnoreCase)
                    .ToList();
            }
            return new Dictionary<string, object?> { ["entries"] = entries };
        }
        catch (Exception ex)
        {
            SshPool.Drop(target);
            return Error("无法列目录：" + ex.Message);
        }
    }

    private static string ModeString(SftpFile file)
    {
        var attrs = file.Attributes;
        var sb = new StringBuilder(10);
        sb.Append(attrs.IsDirectory ? 'd' : attrs.IsSymbolicLink ? 'l' : '-');
        var perms = attrs.Permissions;
        sb.Append((perms & 0x100) != 0 ? 'r' : '-');
        sb.Append((perms & 0x080) != 0 ? 'w' : '-');
        sb.Append((perms & 0x040) != 0 ? 'x' : '-');
        sb.Append((perms & 0x020) != 0 ? 'r' : '-');
        sb.Append((perms & 0x010) != 0 ? 'w' : '-');
        sb.Append((perms & 0x008) != 0 ? 'x' : '-');
        sb.Append((perms & 0x004) != 0 ? 'r' : '-');
        sb.Append((perms & 0x002) != 0 ? 'w' : '-');
        sb.Append((perms & 0x001) != 0 ? 'x' : '-');
        return sb.ToString();
    }

    public static Dictionary<string, object?> Download(SshTarget target, string path, string to)
    {
        try
        {
            var conn = SshPool.Get(target);
            var local = PathUtil.FromJs(to);
            Directory.CreateDirectory(Path.GetDirectoryName(local)!);
            long bytes;
            lock (conn.Gate)
            {
                using var input = conn.Sftp.OpenRead(path);
                using var output = File.Create(local);
                input.CopyTo(output);
                bytes = output.Length;
            }
            return new Dictionary<string, object?>
            {
                ["path"] = PathUtil.ToJs(local),
                ["bytes"] = bytes
            };
        }
        catch (Exception ex)
        {
            SshPool.Drop(target);
            return Error("下载失败：" + ex.Message);
        }
    }

    public static Dictionary<string, object?> Upload(SshTarget target, string localPath, string to)
    {
        try
        {
            var local = PathUtil.FromJs(localPath);
            if (!File.Exists(local)) return Error("本地文件不存在");
            var conn = SshPool.Get(target);
            lock (conn.Gate)
            {
                using var input = File.OpenRead(local);
                conn.Sftp.UploadFile(input, to, canOverride: true);
            }
            return new Dictionary<string, object?>
            {
                ["ok"] = true,
                ["bytes"] = new FileInfo(local).Length
            };
        }
        catch (Exception ex)
        {
            SshPool.Drop(target);
            return Error("上传失败：" + ex.Message);
        }
    }

    public static Dictionary<string, object?> Mkdir(SshTarget target, string path)
    {
        try
        {
            var conn = SshPool.Get(target);
            lock (conn.Gate)
            {
                if (!conn.Sftp.Exists(path)) conn.Sftp.CreateDirectory(path);
            }
            return new Dictionary<string, object?> { ["ok"] = true };
        }
        catch (Exception ex)
        {
            return Error("创建失败：" + ex.Message);
        }
    }

    public static Dictionary<string, object?> Remove(SshTarget target, string path)
    {
        try
        {
            var conn = SshPool.Get(target);
            lock (conn.Gate)
            {
                var attrs = conn.Sftp.GetAttributes(path);
                if (attrs.IsDirectory) DeleteDirectory(conn.Sftp, path);
                else conn.Sftp.DeleteFile(path);
            }
            return new Dictionary<string, object?> { ["ok"] = true };
        }
        catch (Exception ex)
        {
            return Error("删除失败：" + ex.Message);
        }
    }

    private static void DeleteDirectory(SftpClient sftp, string path)
    {
        foreach (var entry in sftp.ListDirectory(path).Where(e => e.Name is not ("." or "..")))
        {
            if (entry.IsDirectory) DeleteDirectory(sftp, entry.FullName);
            else sftp.DeleteFile(entry.FullName);
        }
        sftp.DeleteDirectory(path);
    }

    public static Dictionary<string, object?> Rename(SshTarget target, string from, string to)
    {
        try
        {
            var conn = SshPool.Get(target);
            lock (conn.Gate) conn.Sftp.RenameFile(from, to);
            return new Dictionary<string, object?> { ["ok"] = true };
        }
        catch (Exception ex)
        {
            return Error("重命名失败：" + ex.Message);
        }
    }

    public static Dictionary<string, object?> Search(SshTarget target, string root, string query,
        int limit, bool caseSensitive)
    {
        var q = (query ?? "").Trim();
        if (q.Length == 0) return new Dictionary<string, object?> { ["hits"] = Array.Empty<object>() };
        var escaped = new StringBuilder();
        foreach (var ch in q)
        {
            if ("*?[]\\".Contains(ch)) escaped.Append('\\');
            escaped.Append(ch);
        }
        var pattern = "*" + escaped + "*";
        var opt = caseSensitive ? "-name" : "-iname";
        var n = Math.Clamp(limit, 1, 200);
        var cmd = $"cd {SshAuth.Quote(root)} 2>/dev/null || exit 7; LC_ALL=C find . -type f -not -path './.git/*' {opt} {SshAuth.Quote(pattern)} -print 2>/dev/null | head -n {n}";

        var result = Run(target, cmd, 12);
        if (result.ExitCode != 0 && result.Output.Length == 0)
        {
            return Error(result.Error.Length > 0 ? result.Error : "远端搜索失败（退出码 " + result.ExitCode + "）");
        }

        var hits = new List<Dictionary<string, object?>>();
        foreach (var raw in result.Output.Split('\n'))
        {
            var line = raw.Trim();
            if (line.Length == 0) continue;
            var rel = line.StartsWith("./", StringComparison.Ordinal) ? line[2..] : line;
            if (rel.Length == 0) continue;
            hits.Add(new Dictionary<string, object?>
            {
                ["rel"] = rel,
                ["name"] = PathUtil.BaseName(rel)
            });
            if (hits.Count >= n) break;
        }
        return new Dictionary<string, object?> { ["hits"] = hits };
    }

    public static Dictionary<string, object?> Git(string path, string action, string message)
    {
        if (!RemoteFsX.Parse(path, out _, out var target, out var abs)) return Error("会话未注册");
        var quoted = SshAuth.Quote(abs);
        var cmd = action switch
        {
            "pull" => $"git -C {quoted} pull --ff-only 2>&1",
            "push" => $"git -C {quoted} push 2>&1",
            "fetch" => $"git -C {quoted} fetch --all 2>&1",
            "commit" => $"git -C {quoted} add -A && git -C {quoted} commit -m {SshAuth.Quote(message)} 2>&1",
            _ => $"git -C {quoted} status -sb 2>&1 | head -5"
        };
        var result = Run(target, cmd, 90);
        var output = result.Output;
        if (output.Length > 800) output = output[^800..];
        return new Dictionary<string, object?>
        {
            ["ok"] = result.ExitCode == 0,
            ["output"] = output
        };
    }

    public static Dictionary<string, object?> GitStatus(string path)
    {
        if (!RemoteFsX.Parse(path, out _, out var target, out var abs))
            return new Dictionary<string, object?> { ["entries"] = Array.Empty<object>(), ["branch"] = "" };

        var quoted = SshAuth.Quote(abs);
        var status = Run(target, $"cd {quoted} 2>/dev/null && git status --porcelain -z 2>/dev/null", 30);
        var entries = new List<Dictionary<string, object?>>();
        foreach (var item in status.Output.Split('\0'))
        {
            if (item.Length <= 3) continue;
            var code = item[..2].Trim();
            var rel = item[3..];
            var arrow = rel.IndexOf(" -> ", StringComparison.Ordinal);
            if (arrow >= 0) rel = rel[(arrow + 4)..];
            entries.Add(new Dictionary<string, object?>
            {
                ["path"] = rel,
                ["code"] = code.Length == 0 ? "M" : code
            });
        }

        var branchResult = Run(target, $"git -C {quoted} rev-parse --abbrev-ref HEAD 2>/dev/null", 20);
        return new Dictionary<string, object?>
        {
            ["entries"] = entries,
            ["branch"] = branchResult.Output.Trim()
        };
    }

    internal readonly record struct ExecResult(int ExitCode, string Output, string Error);

    internal static ExecResult Run(SshTarget target, string command, int timeoutSeconds = 45)
    {
        try
        {
            var conn = SshPool.Get(target);
            lock (conn.Gate)
            {
                using var cmd = conn.Client.CreateCommand(command);
                cmd.CommandTimeout = TimeSpan.FromSeconds(timeoutSeconds);
                var output = cmd.Execute() ?? "";
                return new ExecResult(cmd.ExitStatus ?? 0, output, cmd.Error ?? "");
            }
        }
        catch (Exception ex)
        {
            SshPool.Drop(target);
            return new ExecResult(-1, "", ex.Message);
        }
    }
}

/// <summary>把 ssh://&lt;id&gt;/&lt;abs&gt; 接进 fs.* 接口。</summary>
internal static class RemoteFsX
{
    public const string Prefix = "ssh://";

    public static bool Parse(string path, out string id, out SshTarget target, out string abs)
    {
        id = "";
        target = null!;
        abs = "";
        if (!path.StartsWith(Prefix, StringComparison.Ordinal)) return false;
        var rest = path[Prefix.Length..];
        var slash = rest.IndexOf('/');
        if (slash <= 0) return false;
        id = rest[..slash];
        abs = rest[slash..];
        var found = RemoteX.Lookup(id);
        if (found is null) return false;
        target = found;
        return true;
    }

    public static string Join(string id, string abs) =>
        Prefix + id + (abs.StartsWith('/') ? abs : "/" + abs);

    public static object? Handle(string method, Params p)
    {
        var rawPath = p.Str("path", p.Str("from"));
        if (!rawPath.StartsWith(Prefix, StringComparison.Ordinal)) return null;
        if (!Parse(rawPath, out var id, out var target, out var abs))
            return new Dictionary<string, object?> { ["error"] = "远端会话未注册" };

        switch (method)
        {
            case "fs.list":
            {
                var res = RemoteX.List(target, abs);
                if (res.TryGetValue("error", out var err)) return new Dictionary<string, object?> { ["error"] = err?.ToString() };
                var raw = res["entries"] as List<Dictionary<string, object?>> ?? [];
                var entries = raw.Select(e =>
                {
                    var name = e["name"]?.ToString() ?? "";
                    var isDir = (bool)(e["isDir"] ?? false);
                    var childAbs = abs.EndsWith('/') ? abs + name : abs + "/" + name;
                    return new Dictionary<string, object?>
                    {
                        ["name"] = name,
                        ["displayName"] = name,
                        ["path"] = Join(id, childAbs),
                        ["isDir"] = isDir,
                        ["size"] = e["size"] ?? 0,
                        ["mtime"] = e["mtime"] ?? 0,
                        ["ext"] = isDir ? "" : PathUtil.Ext(name),
                        ["hidden"] = name.StartsWith('.'),
                        ["encrypted"] = false,
                        ["vault"] = false
                    };
                }).ToList();
                return entries;
            }

            case "fs.read":
            {
                var tmp = Path.Combine(Path.GetTempPath(), "SuperWorkStation", "remote-read", Guid.NewGuid().ToString("N"));
                var res = RemoteX.Download(target, abs, PathUtil.ToJs(tmp));
                if (res.TryGetValue("error", out var err)) return new Dictionary<string, object?> { ["error"] = err?.ToString() };
                try
                {
                    var bytes = File.ReadAllBytes(tmp);
                    var isText = FsX.LooksLikeText(bytes);
                    return new Dictionary<string, object?>
                    {
                        ["kind"] = isText ? "text" : "binary",
                        ["text"] = isText ? Encoding.UTF8.GetString(bytes) : "",
                        ["size"] = bytes.Length,
                        ["mtime"] = 0,
                        ["binary"] = !isText
                    };
                }
                finally
                {
                    try { File.Delete(tmp); } catch { }
                }
            }

            case "fs.write":
            {
                var tmp = Path.Combine(Path.GetTempPath(), "SuperWorkStation", "remote-write", Guid.NewGuid().ToString("N"));
                Directory.CreateDirectory(Path.GetDirectoryName(tmp)!);
                File.WriteAllBytes(tmp, Encoding.UTF8.GetBytes(p.Str("text")));
                var res = RemoteX.Upload(target, PathUtil.ToJs(tmp), abs);
                try { File.Delete(tmp); } catch { }
                if (res.TryGetValue("error", out var err)) return new Dictionary<string, object?> { ["error"] = err?.ToString() };
                return new Dictionary<string, object?> { ["mtime"] = 0 };
            }

            case "fs.mkdir":
            {
                var res = RemoteX.Mkdir(target, abs);
                return res.TryGetValue("error", out var err)
                    ? new Dictionary<string, object?> { ["error"] = err?.ToString() }
                    : null;
            }

            case "fs.remove":
            case "fs.trash":
            {
                var res = RemoteX.Remove(target, abs);
                return res.TryGetValue("error", out var err)
                    ? new Dictionary<string, object?> { ["error"] = err?.ToString() }
                    : null;
            }

            case "fs.rename":
            {
                var toRaw = p.Str("to");
                if (!Parse(toRaw, out _, out var toTarget, out var toAbs) || toTarget.Key != target.Key)
                    return new Dictionary<string, object?> { ["error"] = "不能跨会话重命名" };
                var res = RemoteX.Rename(target, abs, toAbs);
                return res.TryGetValue("error", out var err)
                    ? new Dictionary<string, object?> { ["error"] = err?.ToString() }
                    : null;
            }

            case "fs.stat":
            {
                try
                {
                    var conn = SshPool.Get(target);
                    lock (conn.Gate)
                    {
                        var attrs = conn.Sftp.GetAttributes(abs);
                        return new Dictionary<string, object?>
                        {
                            ["size"] = attrs.Size,
                            ["mtime"] = new DateTimeOffset(attrs.LastWriteTimeUtc).ToUnixTimeSeconds(),
                            ["isDir"] = attrs.IsDirectory
                        };
                    }
                }
                catch (Exception ex)
                {
                    return new Dictionary<string, object?> { ["error"] = ex.Message };
                }
            }

            case "fs.exists":
            {
                try
                {
                    var conn = SshPool.Get(target);
                    lock (conn.Gate) return conn.Sftp.Exists(abs);
                }
                catch
                {
                    return false;
                }
            }

            case "fs.size":
            {
                var res = RemoteX.Run(target, $"du -sk {SshAuth.Quote(abs)} 2>/dev/null | cut -f1");
                _ = long.TryParse(res.Output.Trim(), out var kb);
                return new Dictionary<string, object?> { ["size"] = kb * 1024, ["isDir"] = true };
            }
        }

        return null;
    }
}
