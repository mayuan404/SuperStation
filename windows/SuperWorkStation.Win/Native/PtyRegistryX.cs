using System.Text;
using Renci.SshNet;

namespace SuperWorkStation;

/// <summary>基于 SSH.NET 的远端交互 shell（用于已保存密码 / 私钥的会话）。</summary>
internal sealed class SshShell : IPtySession
{
    private readonly SshClient _client;
    private readonly ShellStream _stream;
    private readonly object _writeLock = new();
    private bool _closed;

    private readonly Action<byte[]> _onData;
    private readonly Action<int> _onExit;

    private SshShell(SshClient client, ShellStream stream, Action<byte[]> onData, Action<int> onExit)
    {
        _client = client;
        _stream = stream;
        _onData = onData;
        _onExit = onExit;
        _ = Task.Run(ReadLoop);
    }

    public static SshShell Start(SshTarget target, string? remotePath, int cols, int rows,
        Action<byte[]> onData, Action<int> onExit)
    {
        var client = SshAuth.Connect(target);
        var stream = client.CreateShellStream("xterm-256color",
            (uint)Math.Max(20, cols), (uint)Math.Max(4, rows), 0, 0, 8192);
        var shell = new SshShell(client, stream, onData, onExit);
        if (!string.IsNullOrEmpty(remotePath))
        {
            var quoted = SshAuth.Quote(remotePath);
            stream.WriteLine($"cd {quoted} 2>/dev/null; clear");
            stream.Flush();
        }
        return shell;
    }

    private void ReadLoop()
    {
        var buffer = new byte[8192];
        var code = 0;
        try
        {
            while (!_closed)
            {
                var read = _stream.Read(buffer, 0, buffer.Length);
                if (read <= 0) break;
                _onData(buffer[..read]);
            }
        }
        catch
        {
            code = 255;
        }
        finally
        {
            _onExit(code);
        }
    }

    public void Write(byte[] data)
    {
        lock (_writeLock)
        {
            if (_closed) return;
            try
            {
                _stream.Write(data, 0, data.Length);
                _stream.Flush();
            }
            catch
            {
                // 连接已断开
            }
        }
    }

    public void Resize(int cols, int rows)
    {
        if (_closed) return;
        try { _stream.ChangeWindowSize((uint)Math.Max(20, cols), (uint)Math.Max(4, rows), 0, 0); }
        catch { }
    }

    public void Dispose()
    {
        if (_closed) return;
        _closed = true;
        try { _stream.Dispose(); } catch { }
        try { _client.Disconnect(); } catch { }
        try { _client.Dispose(); } catch { }
    }
}

internal static class PtyRegistryX
{
    private static readonly object Lock = new();
    private static readonly Dictionary<string, IPtySession> Sessions = new(StringComparer.Ordinal);

    public static Dictionary<string, object?> Open(Params p, MainForm form)
    {
        var id = Guid.NewGuid().ToString();
        var cols = p.Int("cols", 100);
        var rows = p.Int("rows", 30);
        var kind = p.Str("kind");
        var program = p.Str("program", Shells.Default);

        if (kind == "ssh" || program == "ssh-pty")
        {
            var target = new SshTarget
            {
                Host = p.Str("host"),
                Port = p.Int("port", 22),
                User = p.Str("user", "root"),
                SecretId = p.Str("secretId")
            };
            if (string.IsNullOrEmpty(target.Host)) throw new ApiException("SSH 会话缺少主机地址");
            SshShell shell;
            try
            {
                shell = SshShell.Start(target, p.Str("remotePath"), cols, rows,
                    bytes => EmitData(form, id, bytes),
                    code => EmitExit(form, id, code));
            }
            catch (Exception ex)
            {
                throw new ApiException("SSH 连接失败：" + ex.Message);
            }
            lock (Lock) Sessions[id] = shell;
            return new Dictionary<string, object?> { ["id"] = id };
        }

        var args = p.StrArray("args").ToList();
        if (IsPosixShell(program))
        {
            program = Shells.Default;
            args = ["-NoLogo"];
        }
        else if (program is "ssh" or "ssh.exe" or "/usr/bin/ssh")
        {
            program = Shells.OpenSsh;
        }
        else if (program.EndsWith("/zsh", StringComparison.Ordinal) || program.EndsWith("/bash", StringComparison.Ordinal))
        {
            program = Shells.Default;
            args = ["-NoLogo"];
        }

        var env = p.StrMap("env");
        env.Remove("__secretId");

        var cwd = p.Str("cwd");
        if (string.IsNullOrEmpty(cwd) || !Directory.Exists(PathUtil.FromJs(cwd)))
            cwd = AppPaths.Home;

        var pty = ConPty.Start(program, args, PathUtil.FromJs(cwd), env, cols, rows,
            bytes => EmitData(form, id, bytes),
            code => EmitExit(form, id, code), out var error);
        if (pty is null) throw new ApiException(error ?? "无法创建终端会话");

        lock (Lock) Sessions[id] = pty;
        return new Dictionary<string, object?> { ["id"] = id };
    }

    private static bool IsPosixShell(string program)
    {
        var name = PathUtil.BaseName(program.Replace('\\', '/')).ToLowerInvariant();
        return name is "zsh" or "bash" or "sh" or "fish" or "login" || program is "/bin/zsh" or "/bin/bash";
    }

    private static void EmitData(MainForm form, string id, byte[] bytes)
    {
        form.Emit("pty.data", new Dictionary<string, object?>
        {
            ["id"] = id,
            ["data"] = Convert.ToBase64String(bytes)
        });
    }

    private static void EmitExit(MainForm form, string id, int code)
    {
        form.Emit("pty.exit", new Dictionary<string, object?>
        {
            ["id"] = id,
            ["code"] = code
        });
    }

    public static void Write(string id, string base64)
    {
        if (!TryGet(id, out var session)) return;
        byte[] data;
        try { data = Convert.FromBase64String(base64); }
        catch { return; }
        session.Write(data);
    }

    public static void Resize(string id, int cols, int rows)
    {
        if (TryGet(id, out var session)) session.Resize(cols, rows);
    }

    public static void Close(string id)
    {
        IPtySession? session;
        lock (Lock)
        {
            Sessions.TryGetValue(id, out session);
            Sessions.Remove(id);
        }
        session?.Dispose();
    }

    private static bool TryGet(string id, out IPtySession session)
    {
        lock (Lock)
        {
            if (Sessions.TryGetValue(id, out var found))
            {
                session = found;
                return true;
            }
        }
        session = null!;
        return false;
    }
}
