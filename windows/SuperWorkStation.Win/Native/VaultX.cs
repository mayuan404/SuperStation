using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SuperWorkStation;

/// <summary>
/// 目录级 / 单文件加密。格式与 macOS 端一致（PBKDF2-SHA256 210k + AES-256-GCM），
/// 同一个加密文件在两端可以互相打开。
/// </summary>
internal static class VaultX
{
    public const string Marker = ".bnbook-vault";
    public const string Suffix = ".bnenc";
    private const int Iterations = 210_000;
    private static readonly byte[] CheckPlain = Encoding.UTF8.GetBytes("betternotebook-vault-v1");
    private static readonly byte[] FileMagic = Encoding.UTF8.GetBytes("BNBF1");
    private static readonly byte[] FileVerifier = Encoding.UTF8.GetBytes("bnbook-file-v1");

    private static readonly object KeyLock = new();
    private static readonly Dictionary<string, byte[]> VaultKeys = new(StringComparer.OrdinalIgnoreCase);
    private static readonly Dictionary<string, byte[]> FileKeys = new(StringComparer.OrdinalIgnoreCase);

    // ---------- 通用加解密 ----------

    private static byte[] Derive(string password, byte[] salt, int iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(password, salt, iterations, HashAlgorithmName.SHA256, 32);

    public static byte[] Seal(byte[] plain, byte[] key)
    {
        var box = SealBox(plain, key);
        var outBytes = new byte[5 + box.Length];
        Buffer.BlockCopy(Encoding.ASCII.GetBytes("BNBK1"), 0, outBytes, 0, 5);
        Buffer.BlockCopy(box, 0, outBytes, 5, box.Length);
        return outBytes;
    }

    /// <summary>不带容器头的密封盒：nonce(12) + ciphertext + tag(16)，与 macOS 的 sealBox 一致。</summary>
    public static byte[] SealBox(byte[] plain, byte[] key)
    {
        var nonce = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        using (var aes = new AesGcm(key, 16))
        {
            aes.Encrypt(nonce, plain, cipher, tag);
        }
        var outBytes = new byte[12 + cipher.Length + 16];
        Buffer.BlockCopy(nonce, 0, outBytes, 0, 12);
        Buffer.BlockCopy(cipher, 0, outBytes, 12, cipher.Length);
        Buffer.BlockCopy(tag, 0, outBytes, 12 + cipher.Length, 16);
        return outBytes;
    }

    public static byte[] OpenBox(byte[] blob, byte[] key)
    {
        if (blob.Length < 28) throw new ApiException("加密数据已损坏");
        var nonce = blob.AsSpan(0, 12).ToArray();
        var cipher = blob.AsSpan(12, blob.Length - 12 - 16).ToArray();
        var tag = blob.AsSpan(blob.Length - 16, 16).ToArray();
        var plain = new byte[cipher.Length];
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(nonce, cipher, tag, plain);
        }
        catch (CryptographicException)
        {
            throw new ApiException("解密失败：密码错误或文件已损坏");
        }
        return plain;
    }

    public static byte[] Open(byte[] blob, byte[] key)
    {
        if (blob.Length < 5 + 12 + 16 || Encoding.ASCII.GetString(blob, 0, 5) != "BNBK1")
            throw new ApiException("不是有效的加密文件");
        var nonce = blob.AsSpan(5, 12).ToArray();
        var cipher = blob.AsSpan(17, blob.Length - 17 - 16).ToArray();
        var tag = blob.AsSpan(blob.Length - 16, 16).ToArray();
        var plain = new byte[cipher.Length];
        try
        {
            using var aes = new AesGcm(key, 16);
            aes.Decrypt(nonce, cipher, tag, plain);
        }
        catch (CryptographicException)
        {
            throw new ApiException("解密失败：密码错误或文件已损坏");
        }
        return plain;
    }

    // ---------- 目录级 ----------

    public static bool IsVaultRoot(string jsPath)
    {
        var marker = Path.Combine(PathUtil.FromJs(jsPath), Marker);
        return File.Exists(marker);
    }

    public static string? FindRoot(string jsPath)
    {
        if (string.IsNullOrEmpty(jsPath) || PathUtil.IsRemote(jsPath)) return null;
        var dir = PathUtil.DirName(PathUtil.Full(jsPath));
        for (var i = 0; i < 64; i++)
        {
            if (IsVaultRoot(dir)) return dir;
            var parent = PathUtil.DirName(dir);
            if (parent == dir) break;
            dir = parent;
        }
        return null;
    }

    public static bool IsUnlocked(string root)
    {
        lock (KeyLock) return VaultKeys.ContainsKey(root);
    }

    public static byte[]? KeyFor(string root)
    {
        lock (KeyLock) return VaultKeys.TryGetValue(root, out var key) ? key : null;
    }

    public static string FindRootJs(string jsPath) => FindRoot(jsPath) ?? "";

    public static Dictionary<string, object?> Status(string jsPath)
    {
        var isRoot = IsVaultRoot(jsPath);
        return new Dictionary<string, object?>
        {
            ["isVault"] = isRoot,
            ["unlocked"] = isRoot && IsUnlocked(jsPath)
        };
    }

    public static void Create(string jsPath, string password, bool convert)
    {
        if (password.Length < 4) throw new ApiException("密码至少 4 位");
        var root = PathUtil.FromJs(jsPath);
        Directory.CreateDirectory(root);
        if (IsVaultRoot(jsPath)) throw new ApiException("该文件夹已是加密目录");

        var salt = RandomNumberGenerator.GetBytes(16);
        var key = Derive(password, salt, Iterations);
        var header = new Dictionary<string, object?>
        {
            ["v"] = 1,
            ["kdf"] = "pbkdf2-sha256",
            ["iter"] = Iterations,
            ["salt"] = Convert.ToBase64String(salt),
            ["check"] = Convert.ToBase64String(Seal(CheckPlain, key))
        };
        File.WriteAllText(Path.Combine(root, Marker), JsonSerializer.Serialize(header), Encoding.UTF8);
        lock (KeyLock) VaultKeys[jsPath] = key;

        if (convert) EncryptTree(jsPath, key);
        lock (KeyLock) VaultKeys.Remove(jsPath); // 创建完即上锁
    }

    public static void Unlock(string jsPath, string password)
    {
        var headerPath = Path.Combine(PathUtil.FromJs(jsPath), Marker);
        if (!File.Exists(headerPath)) throw new ApiException("不是有效的加密目录");
        using var doc = JsonDocument.Parse(File.ReadAllText(headerPath, Encoding.UTF8));
        var root = doc.RootElement;
        var iterations = root.TryGetProperty("iter", out var it) ? it.GetInt32() : Iterations;
        var salt = Convert.FromBase64String(root.GetProperty("salt").GetString() ?? "");
        var check = Convert.FromBase64String(root.GetProperty("check").GetString() ?? "");
        var key = Derive(password, salt, iterations);
        byte[] plain;
        try { plain = Open(check, key); }
        catch (ApiException) { throw new ApiException("密码错误"); }
        if (!plain.AsSpan().SequenceEqual(CheckPlain)) throw new ApiException("密码错误");
        lock (KeyLock) VaultKeys[jsPath] = key;
    }

    public static void Lock(string jsPath)
    {
        lock (KeyLock) VaultKeys.Remove(jsPath);
    }

    public static void Remove(string jsPath, string password)
    {
        Unlock(jsPath, password);
        var key = KeyFor(jsPath) ?? throw new ApiException("解锁失败");
        var root = PathUtil.FromJs(jsPath);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).ToList())
        {
            if (!file.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase)) continue;
            var plain = Open(File.ReadAllBytes(file), key);
            var target = file[..^Suffix.Length];
            File.WriteAllBytes(target, plain);
            File.Delete(file);
        }
        File.Delete(Path.Combine(root, Marker));
        lock (KeyLock) VaultKeys.Remove(jsPath);
    }

    private static void EncryptTree(string jsPath, byte[] key)
    {
        var root = PathUtil.FromJs(jsPath);
        foreach (var file in Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).ToList())
        {
            var name = Path.GetFileName(file);
            if (name is Marker || name.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase)) continue;
            var plain = File.ReadAllBytes(file);
            var sealedBytes = Seal(plain, key);
            File.WriteAllBytes(file + Suffix, sealedBytes);
            File.Delete(file);
        }
    }

    // ---------- 单文件 ----------

    public static bool IsFileVault(string jsPath)
    {
        var file = PathUtil.FromJs(jsPath);
        if (!File.Exists(file) || new FileInfo(file).Length < 5) return false;
        using var fs = File.OpenRead(file);
        var head = new byte[5];
        var n = fs.Read(head, 0, 5);
        return n == 5 && head.AsSpan().SequenceEqual(FileMagic);
    }

    public static string EncryptFile(string jsPath, string password)
    {
        if (password.Length < 4) throw new ApiException("密码至少 4 位");
        if (jsPath.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase)) throw new ApiException("该文件已加密");
        var file = PathUtil.FromJs(jsPath);
        var plain = File.ReadAllBytes(file);
        var salt = RandomNumberGenerator.GetBytes(16);
        var key = Derive(password, salt, Iterations);

        var header = new byte[5 + 4 + 16];
        Buffer.BlockCopy(FileMagic, 0, header, 0, 5);
        var iterationsBytes = BitConverter.GetBytes(Iterations);
        Array.Reverse(iterationsBytes);
        Buffer.BlockCopy(iterationsBytes, 0, header, 5, 4);
        Buffer.BlockCopy(salt, 0, header, 9, 16);

        var outPath = file + Suffix;
        using (var fs = File.Create(outPath))
        {
            fs.Write(header);
            fs.Write(SealBox(FileVerifier, key));
            fs.Write(SealBox(plain, key));
        }
        File.Delete(file);
        lock (KeyLock) FileKeys[outPath] = key;
        return PathUtil.ToJs(outPath);
    }

    public static void UnlockFile(string jsPath, string password)
    {
        var file = PathUtil.FromJs(jsPath);
        var blob = File.ReadAllBytes(file);
        if (blob.Length < 5 + 4 + 16 + 42 || !blob.AsSpan(0, 5).SequenceEqual(FileMagic))
            throw new ApiException("不是有效的加密文件");
        var iterations = (int)ReadUInt32BE(blob, 5);
        var salt = blob.AsSpan(9, 16).ToArray();
        var key = Derive(password, salt, iterations);
        var verifier = blob.AsSpan(25, 42).ToArray();
        byte[] plain;
        try { plain = OpenBox(verifier, key); }
        catch (ApiException) { throw new ApiException("密码错误"); }
        if (!plain.AsSpan().SequenceEqual(FileVerifier)) throw new ApiException("密码错误");
        lock (KeyLock) FileKeys[file] = key;
    }

    public static void LockFile(string jsPath)
    {
        lock (KeyLock) FileKeys.Remove(PathUtil.FromJs(jsPath));
    }

    public static string DecryptFile(string jsPath, string password)
    {
        UnlockFile(jsPath, password);
        var file = PathUtil.FromJs(jsPath);
        var blob = File.ReadAllBytes(file);
        var key = FileKey(file) ?? throw new ApiException("该文件已加密，请先解锁");
        var payload = blob.AsSpan(25 + 42).ToArray();
        var plain = OpenBox(payload, key);
        var target = file[..^Suffix.Length];
        File.WriteAllBytes(target, plain);
        File.Delete(file);
        lock (KeyLock) FileKeys.Remove(file);
        return PathUtil.ToJs(target);
    }

    private static uint ReadUInt32BE(byte[] data, int offset) =>
        (uint)(data[offset] << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3]);

    private static byte[]? FileKey(string nativePath)
    {
        lock (KeyLock) return FileKeys.TryGetValue(nativePath, out var key) ? key : null;
    }

    // ---------- 供 FsX 调用 ----------

    public static byte[] DecryptBytes(string jsPath, byte[] raw)
    {
        if (jsPath.EndsWith(Suffix, StringComparison.OrdinalIgnoreCase))
        {
            var root = FindRoot(jsPath);
            if (root is not null)
            {
                var key = KeyFor(root) ?? throw new ApiException("目录已锁定，请先解锁");
                return Open(raw, key);
            }
            var fileKey = FileKey(PathUtil.FromJs(jsPath));
            if (fileKey is not null) return Open(raw, fileKey);
            if (IsFileVault(jsPath)) throw new ApiException("该文件已加密，请先解锁");
            throw new ApiException("该文件已加密，请先解锁所在目录");
        }
        return raw;
    }

    public static byte[] SealForWrite(string jsPath, byte[] plain)
    {
        var root = FindRoot(jsPath);
        if (root is not null)
        {
            var key = KeyFor(root) ?? throw new ApiException("目录已锁定");
            return Seal(plain, key);
        }
        var fileKey = FileKey(PathUtil.FromJs(jsPath));
        if (fileKey is not null)
        {
            // 保留原文件头（salt/iterations），只重新封装正文
            var blob = File.ReadAllBytes(PathUtil.FromJs(jsPath));
            var header = blob.AsSpan(0, 25 + 42).ToArray();
            return header.Concat(SealBox(plain, fileKey)).ToArray();
        }
        throw new ApiException("该文件已加密，请先解锁");
    }
}
