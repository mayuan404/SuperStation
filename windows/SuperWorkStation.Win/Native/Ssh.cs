using System.Diagnostics;
using System.Text;
using Renci.SshNet;

namespace SuperWorkStation;

internal sealed class SshTarget
{
    public string Host { get; init; } = "";
    public int Port { get; init; } = 22;
    public string User { get; init; } = "root";
    public string SecretId { get; init; } = "";

    public string Key => $"{User}@{Host}:{Port}";

    public override string ToString() => Key;
}

internal static class SshAuth
{
    /// <summary>拼认证方式：保存的密码 → 私钥 → keyboard-interactive（部分服务器只认这个）。</summary>
    public static ConnectionInfo Build(SshTarget target, string? passwordOverride = null)
    {
        var user = string.IsNullOrEmpty(target.User) ? "root" : target.User;
        var password = passwordOverride ?? SshSecretsX.Get(target.SecretId);
        var methods = new List<AuthenticationMethod>();

        if (!string.IsNullOrEmpty(password))
        {
            methods.Add(new PasswordAuthenticationMethod(user, password));
            var keyboard = new KeyboardInteractiveAuthenticationMethod(user);
            keyboard.AuthenticationPrompt += (_, e) =>
            {
                foreach (var prompt in e.Prompts) prompt.Response = password;
            };
            methods.Add(keyboard);
        }

        foreach (var keyFile in CandidateKeys())
        {
            try
            {
                methods.Add(new PrivateKeyAuthenticationMethod(user, new PrivateKeyFile(keyFile)));
            }
            catch
            {
                // 带口令的私钥这里解不开，跳过
            }
        }

        if (methods.Count == 0)
            throw new ApiException("这个 SSH 会话还没有保存密码，也没有可用的私钥；请编辑会话填密码后再试");

        var info = new ConnectionInfo(target.Host, target.Port <= 0 ? 22 : target.Port, user, methods.ToArray())
        {
            Timeout = TimeSpan.FromSeconds(15)
        };
        return info;
    }

    private static IEnumerable<string> CandidateKeys()
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        foreach (var name in new[] { "id_ed25519", "id_ecdsa", "id_rsa" })
        {
            var path = Path.Combine(home, ".ssh", name);
            if (File.Exists(path)) yield return path;
        }
    }

    public static SshClient Connect(SshTarget target, string? passwordOverride = null)
    {
        var client = new SshClient(Build(target, passwordOverride));
        // 与 macOS 端 StrictHostKeyChecking=accept-new 一致：首次接受并记录指纹
        client.HostKeyReceived += (_, e) =>
        {
            e.CanTrust = true;
            AppPaths.Log($"SSH hostkey {target.Host} {e.HostKeyName} {e.FingerPrint}");
        };
        client.Connect();
        return client;
    }

    /// <summary>远端命令统一用单引号包裹，避免路径里的空格和特殊符号。</summary>
    public static string Quote(string s) => "'" + s.Replace("'", "'\\''") + "'";
}

/// <summary>按目标复用一条 SSH + SFTP 连接；ControlMaster 在 Windows 上不存在，这里用连接池等价替代。</summary>
internal sealed class SshConn : IDisposable
{
    public SshClient Client { get; }
    public SftpClient Sftp { get; }
    public object Gate { get; } = new();

    private SshConn(SshClient client, SftpClient sftp)
    {
        Client = client;
        Sftp = sftp;
    }

    public static SshConn Open(SshTarget target)
    {
        var client = SshAuth.Connect(target);
        var sftp = new SftpClient(SshAuth.Build(target));
        sftp.Connect();
        return new SshConn(client, sftp);
    }

    public bool Alive => Client.IsConnected && Sftp.IsConnected;

    public void Dispose()
    {
        try { Sftp.Dispose(); } catch { }
        try { Client.Dispose(); } catch { }
    }
}

internal static class SshPool
{
    private static readonly object Lock = new();
    private static readonly Dictionary<string, SshConn> Pool = new();

    public static SshConn Get(SshTarget target)
    {
        lock (Lock)
        {
            if (Pool.TryGetValue(target.Key, out var conn))
            {
                if (conn.Alive) return conn;
                Pool.Remove(target.Key);
                conn.Dispose();
            }
            var fresh = SshConn.Open(target);
            Pool[target.Key] = fresh;
            return fresh;
        }
    }

    public static void Drop(SshTarget target)
    {
        lock (Lock)
        {
            if (!Pool.TryGetValue(target.Key, out var conn)) return;
            Pool.Remove(target.Key);
            conn.Dispose();
        }
    }

    public static void Forget(string id)
    {
        // 会话移除后无需保留连接，交给下次访问时的惰性重建
        lock (Lock)
        {
            foreach (var key in Pool.Keys.Where(k => k.EndsWith(":" + id, StringComparison.Ordinal)).ToArray())
            {
                if (Pool.Remove(key, out var conn)) conn.Dispose();
            }
        }
    }
}
