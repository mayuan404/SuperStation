using System.Text;

namespace SuperWorkStation;

/// <summary>本地文件读写与目录遍历。返回结构对齐 macOS 端的 fs.* 结果。</summary>
internal static class FsX
{
    private const long MaxReadBytes = 24L * 1024 * 1024;

    private static readonly HashSet<string> SkipDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        "node_modules", ".git", "dist", "build", ".next", "__pycache__", ".venv", "venv",
        "target", ".idea", "Pods"
    };

    public static bool IsDir(string path) => !string.IsNullOrEmpty(path) && Directory.Exists(PathUtil.FromJs(path));

    public static bool IsFile(string path) => !string.IsNullOrEmpty(path) && File.Exists(PathUtil.FromJs(path));

    public static List<Dictionary<string, object?>> List(string path)
    {
        var dir = PathUtil.FromJs(path);
        if (!Directory.Exists(dir)) throw new ApiException("目录不存在");
        if (VaultX.IsVaultRoot(path) && !VaultX.IsUnlocked(path))
            throw new ApiException("目录已锁定，请先解锁");

        var containingVault = VaultX.IsVaultRoot(path) ? path : VaultX.FindRoot(path);
        var outList = new List<Dictionary<string, object?>>();
        var di = new DirectoryInfo(dir);
        foreach (var entry in di.EnumerateFileSystemInfos())
        {
            var name = entry.Name;
            if (name is ".DS_Store" or "desktop.ini" or ".bnbook-vault") continue;
            if (entry is DirectoryInfo sub && sub.Name.EndsWith(".app", StringComparison.OrdinalIgnoreCase)) continue;

            var isDir = entry is DirectoryInfo;
            var full = PathUtil.ToJs(entry.FullName);
            var encrypted = !isDir && name.EndsWith(VaultX.Suffix, StringComparison.OrdinalIgnoreCase);
            var display = encrypted ? name[..^VaultX.Suffix.Length] : name;
            long size = 0;
            double mtime = 0;
            try
            {
                if (!isDir) size = ((FileInfo)entry).Length;
                mtime = new DateTimeOffset(entry.LastWriteTimeUtc).ToUnixTimeSeconds();
            }
            catch
            {
                // 无权限/已被删除的条目照常显示
            }

            outList.Add(new Dictionary<string, object?>
            {
                ["name"] = name,
                ["displayName"] = display,
                ["path"] = full,
                ["isDir"] = isDir,
                ["size"] = size,
                ["mtime"] = mtime,
                ["encrypted"] = encrypted,
                ["ext"] = isDir ? "" : PathUtil.Ext(display),
                ["hidden"] = display.StartsWith('.'),
                ["vault"] = isDir && VaultX.IsVaultRoot(full),
                ["inVault"] = containingVault is not null,
                ["vaultRoot"] = containingVault ?? ""
            });
        }

        outList.Sort((a, b) =>
        {
            var ad = (bool)(a["isDir"] ?? false);
            var bd = (bool)(b["isDir"] ?? false);
            if (ad != bd) return ad ? -1 : 1;
            return string.Compare((string?)a["displayName"], (string?)b["displayName"],
                StringComparison.CurrentCultureIgnoreCase);
        });
        return outList;
    }

    public static Dictionary<string, object?> Read(string path)
    {
        var file = PathUtil.FromJs(path);
        if (!File.Exists(file)) throw new ApiException("文件不存在");
        var info = new FileInfo(file);
        var mtime = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeSeconds();

        if (info.Length > MaxReadBytes)
            throw new ApiException($"文件过大（{info.Length / 1024 / 1024} MB）");

        var data = File.ReadAllBytes(file);
        if (path.EndsWith(VaultX.Suffix, StringComparison.OrdinalIgnoreCase))
            data = VaultX.DecryptBytes(path, data);
        if (LooksLikeText(data))
        {
            return new Dictionary<string, object?>
            {
                ["kind"] = "text",
                ["text"] = Encoding.UTF8.GetString(data).TrimStart('\uFEFF'),
                ["size"] = data.Length,
                ["mtime"] = mtime,
                ["truncated"] = false
            };
        }
        return new Dictionary<string, object?>
        {
            ["kind"] = "binary",
            ["size"] = data.Length,
            ["mtime"] = mtime
        };
    }

    public static Dictionary<string, object?> Write(string path, string text)
    {
        AllowedRoots.GuardWrite(path);
        var file = PathUtil.FromJs(path);
        if (File.Exists(file))
        {
            var info = new FileInfo(file);
            if (info.Length < 8 * 1024 * 1024)
            {
                var previous = File.ReadAllBytes(file);
                DocsStore.SnapshotHistory(path, previous, info.LastWriteTimeUtc);
            }
        }
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var bytes = Encoding.UTF8.GetBytes(text);
        if (path.EndsWith(VaultX.Suffix, StringComparison.OrdinalIgnoreCase))
            bytes = VaultX.SealForWrite(path, bytes);
        WriteAtomic(file, bytes);
        return new Dictionary<string, object?>
        {
            ["mtime"] = new DateTimeOffset(File.GetLastWriteTimeUtc(file)).ToUnixTimeSeconds()
        };
    }

    public static void WriteBytes(string path, byte[] data)
    {
        AllowedRoots.GuardWrite(path);
        var file = PathUtil.FromJs(path);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        WriteAtomic(file, data);
    }

    public static void CreateFile(string path, string text)
    {
        AllowedRoots.GuardWrite(path);
        var file = PathUtil.FromJs(path);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        if (File.Exists(file)) throw new ApiException("文件已存在");
        var vaultRoot = VaultX.FindRoot(path);
        if (vaultRoot is not null)
        {
            var sealedBytes = VaultX.SealForWrite(path + VaultX.Suffix, Encoding.UTF8.GetBytes(text));
            WriteAtomic(file + VaultX.Suffix, sealedBytes);
            return;
        }
        WriteAtomic(file, Encoding.UTF8.GetBytes(text));
    }

    public static void Mkdir(string path)
    {
        AllowedRoots.GuardWrite(path);
        Directory.CreateDirectory(PathUtil.FromJs(path));
    }

    public static void Rename(string from, string to)
    {
        AllowedRoots.GuardWrite(from);
        AllowedRoots.GuardWrite(to);
        var src = PathUtil.FromJs(from);
        var dst = PathUtil.FromJs(to);
        if (Directory.Exists(src)) Directory.Move(src, dst);
        else File.Move(src, dst, overwrite: false);
    }

    public static void Copy(string from, string to)
    {
        AllowedRoots.GuardWrite(to);
        var src = PathUtil.FromJs(from);
        var dst = PathUtil.FromJs(to);
        if (Directory.Exists(src))
        {
            CopyDir(src, dst);
        }
        else
        {
            Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
            File.Copy(src, dst, overwrite: false);
        }
    }

    private static void CopyDir(string src, string dst)
    {
        Directory.CreateDirectory(dst);
        foreach (var dir in Directory.EnumerateDirectories(src, "*", SearchOption.AllDirectories))
        {
            Directory.CreateDirectory(Path.Combine(dst, Path.GetRelativePath(src, dir)));
        }
        foreach (var file in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
        {
            var target = Path.Combine(dst, Path.GetRelativePath(src, file));
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, overwrite: false);
        }
    }

    public static void Move(string from, string to)
    {
        AllowedRoots.GuardWrite(to);
        var src = PathUtil.FromJs(from);
        var dst = PathUtil.FromJs(to);
        if (Directory.Exists(src)) Directory.Move(src, dst);
        else File.Move(src, dst, overwrite: false);
    }

    public static void Trash(string path)
    {
        AllowedRoots.GuardWrite(path);
        var file = PathUtil.FromJs(path);
        if (!File.Exists(file) && !Directory.Exists(file)) throw new ApiException("文件不存在");
        Shell.Recycle(file);
    }

    public static Dictionary<string, object?> Stat(string path)
    {
        var p = PathUtil.FromJs(path);
        if (Directory.Exists(p))
        {
            return new Dictionary<string, object?>
            {
                ["size"] = DirectorySize(p),
                ["mtime"] = new DateTimeOffset(Directory.GetLastWriteTimeUtc(p)).ToUnixTimeSeconds(),
                ["isDir"] = true
            };
        }
        if (!File.Exists(p)) throw new ApiException("文件不存在");
        var info = new FileInfo(p);
        return new Dictionary<string, object?>
        {
            ["size"] = info.Length,
            ["mtime"] = new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeSeconds(),
            ["isDir"] = false
        };
    }

    public static Dictionary<string, object?> Size(string path)
    {
        var p = PathUtil.FromJs(path);
        if (!Directory.Exists(p) && !File.Exists(p)) throw new ApiException("文件不存在");
        return Directory.Exists(p)
            ? new Dictionary<string, object?> { ["size"] = DirectorySize(p), ["isDir"] = true }
            : new Dictionary<string, object?> { ["size"] = new FileInfo(p).Length, ["isDir"] = false };
    }

    public static bool Exists(string path)
    {
        var p = PathUtil.FromJs(path);
        return File.Exists(p) || Directory.Exists(p);
    }

    private static long DirectorySize(string dir, int limit = 200_000)
    {
        long total = 0;
        var count = 0;
        try
        {
            foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
            {
                if (++count > limit) break;
                try { total += new FileInfo(file).Length; } catch { }
            }
        }
        catch
        {
            // 遇到无权限的子目录就返回已统计的部分
        }
        return total;
    }

    /// <summary>快速打开用的文件索引（只收常规文件，跳过依赖/构建目录）。</summary>
    public static List<Dictionary<string, object?>> Index(string root, int limit = 40000)
    {
        var outList = new List<Dictionary<string, object?>>();
        var baseDir = PathUtil.FromJs(root);
        if (!Directory.Exists(baseDir)) return outList;

        var stack = new Stack<string>();
        stack.Push(baseDir);
        while (stack.Count > 0)
        {
            var dir = stack.Pop();
            IEnumerable<string> entries;
            try { entries = Directory.EnumerateFileSystemEntries(dir); }
            catch { continue; }

            foreach (var full in entries)
            {
                if (outList.Count >= limit) return outList;
                var name = Path.GetFileName(full);
                if (name is ".DS_Store" or "desktop.ini" or ".bnbook-vault") continue;
                if (Directory.Exists(full))
                {
                    if (name.StartsWith('.') || SkipDirs.Contains(name)) continue;
                    stack.Push(full);
                }
                else
                {
                    if (name.StartsWith('.')) continue;
                    outList.Add(new Dictionary<string, object?>
                    {
                        ["name"] = name,
                        ["path"] = PathUtil.ToJs(full),
                        ["ext"] = PathUtil.Ext(name)
                    });
                }
            }
        }
        return outList;
    }

    public static bool LooksLikeText(byte[] data)
    {
        var head = data.AsSpan(0, Math.Min(8192, data.Length));
        if (head.IndexOf((byte)0) >= 0) return false;

        // 用严格 UTF-8 校验，二进制文件基本都会失败
        try
        {
            var decoder = new UTF8Encoding(false, true).GetDecoder();
            var chars = new char[8192];
            decoder.Convert(head, chars, flush: true, out _, out _, out _);
        }
        catch (DecoderFallbackException)
        {
            return false;
        }

        var control = 0;
        foreach (var b in head)
        {
            if (b < 9 || (b > 13 && b < 32)) control++;
        }
        return control * 100 / Math.Max(head.Length, 1) < 2;
    }

    public static void WriteAtomic(string nativePath, byte[] data)
    {
        var dir = Path.GetDirectoryName(nativePath)!;
        Directory.CreateDirectory(dir);
        var tmp = Path.Combine(dir, "." + Path.GetFileName(nativePath) + ".tmp" + Guid.NewGuid().ToString("N")[..6]);
        File.WriteAllBytes(tmp, data);
        File.Move(tmp, nativePath, overwrite: true);
    }

    public static bool IsArchive(string path)
    {
        var ext = PathUtil.Ext(path);
        return ext is "zip" or "tar" or "gz" or "tgz" or "bz2" or "xz" or "zst" or "7z";
    }
}
