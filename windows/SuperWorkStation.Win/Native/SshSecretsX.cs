using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SuperWorkStation;

/// <summary>SSH 密码：DPAPI 加密后落在本机应用数据目录，不进入设置、不经过网页层。</summary>
internal static class SshSecretsX
{
    private static readonly object Lock = new();
    private static string FilePath => Path.Combine(AppPaths.Support, "ssh-secrets.json");

    private static Dictionary<string, string> Load()
    {
        try
        {
            if (!File.Exists(FilePath)) return new Dictionary<string, string>();
            var text = File.ReadAllText(FilePath, Encoding.UTF8).Trim();
            if (text.Length == 0) return new Dictionary<string, string>();

            // 先按 DPAPI 密文解，失败则当成旧的明文 JSON（迁移用）
            try
            {
                var blob = Convert.FromBase64String(text);
                var plain = ProtectedData.Unprotect(blob, null, DataProtectionScope.CurrentUser);
                return JsonSerializer.Deserialize<Dictionary<string, string>>(plain) ?? new();
            }
            catch
            {
                return JsonSerializer.Deserialize<Dictionary<string, string>>(text) ?? new();
            }
        }
        catch
        {
            return new Dictionary<string, string>();
        }
    }

    private static void Save(Dictionary<string, string> map)
    {
        var plain = JsonSerializer.SerializeToUtf8Bytes(map);
        var blob = ProtectedData.Protect(plain, null, DataProtectionScope.CurrentUser);
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, Convert.ToBase64String(blob), Encoding.UTF8);
    }

    public static void Set(string id, string? password)
    {
        if (string.IsNullOrEmpty(id)) return;
        lock (Lock)
        {
            var map = Load();
            if (!string.IsNullOrEmpty(password)) map[id] = password;
            else map.Remove(id);
            Save(map);
        }
    }

    public static string? Get(string? id)
    {
        if (string.IsNullOrEmpty(id)) return null;
        lock (Lock)
        {
            return Load().TryGetValue(id, out var pw) && !string.IsNullOrEmpty(pw) ? pw : null;
        }
    }

    public static bool Has(string? id) => Get(id) is not null;
}
