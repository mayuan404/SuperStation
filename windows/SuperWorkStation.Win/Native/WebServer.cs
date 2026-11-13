using System.Net;
using System.Net.Sockets;
using System.Text;

namespace SuperWorkStation;

/// <summary>
/// 只监听 127.0.0.1 的极简 HTTP 服务：既服务前端静态资源，也通过 /__file/ 提供
/// 已授权目录里的文件（图片 / 音视频 / 字体），支持 Range，避免自定义协议的兼容坑。
/// </summary>
internal sealed class WebServer : IDisposable
{
    private readonly TcpListener _listener;
    private readonly string _webRoot;
    private readonly CancellationTokenSource _cts = new();

    public int Port { get; }

    public WebServer(string webRoot)
    {
        _webRoot = webRoot;
        // 端口尽量固定：localStorage 按 origin 隔离，换端口等于丢设置
        var preferred = ReadPreferredPort();
        _listener = new TcpListener(IPAddress.Loopback, preferred);
        try
        {
            _listener.Start();
        }
        catch (SocketException)
        {
            _listener = new TcpListener(IPAddress.Loopback, 0);
            _listener.Start();
        }
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        SavePreferredPort(Port);
        _ = AcceptLoop();
    }

    private static int ReadPreferredPort()
    {
        try
        {
            var file = Path.Combine(AppPaths.Support, "port");
            if (File.Exists(file) && int.TryParse(File.ReadAllText(file).Trim(), out var port) &&
                port is > 1024 and < 65535)
            {
                return port;
            }
        }
        catch { }
        return 47117;
    }

    private static void SavePreferredPort(int port)
    {
        try { File.WriteAllText(Path.Combine(AppPaths.Support, "port"), port.ToString()); }
        catch { }
    }

    public string BaseUrl => $"http://127.0.0.1:{Port}";

    private async Task AcceptLoop()
    {
        while (!_cts.IsCancellationRequested)
        {
            TcpClient client;
            try { client = await _listener.AcceptTcpClientAsync(_cts.Token); }
            catch { break; }
            _ = Task.Run(() => Handle(client));
        }
    }

    private async Task Handle(TcpClient client)
    {
        using (client)
        {
            try
            {
                using var stream = client.GetStream();
                var header = await ReadHeaders(stream);
                if (header is null) return;

                var lines = header.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
                var requestLine = lines[0].Split(' ');
                if (requestLine.Length < 2) return;
                var method = requestLine[0].ToUpperInvariant();
                var rawPath = requestLine[1];

                var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                foreach (var line in lines.Skip(1))
                {
                    var i = line.IndexOf(':');
                    if (i <= 0) continue;
                    headers[line[..i].Trim()] = line[(i + 1)..].Trim();
                }

                var pathPart = rawPath.Split('?')[0];

                if (pathPart.StartsWith("/__file/", StringComparison.Ordinal))
                {
                    var token = pathPart["/__file/".Length..];
                    var decoded = PathUtil.Base64UrlDecode(token);
                    if (decoded is null)
                    {
                        await WriteStatus(stream, method, 400, "Bad Request", "text/plain; charset=utf-8", "bad path");
                        return;
                    }
                    var native = PathUtil.FromJs(decoded);
                    if (!AllowedRoots.Allows(decoded) || (!File.Exists(native) && !Directory.Exists(native)))
                    {
                        await WriteStatus(stream, method, 403, "Forbidden", "text/plain; charset=utf-8", "forbidden");
                        return;
                    }
                    if (Directory.Exists(native))
                    {
                        await WriteStatus(stream, method, 404, "Not Found", "text/plain; charset=utf-8", "is a directory");
                        return;
                    }
                    await ServeFile(stream, method, native, Mime.TypeFor(native), headers, noCache: true);
                    return;
                }

                var rel = pathPart == "/" ? "/index.html" : pathPart;
                rel = Uri.UnescapeDataString(rel);
                var full = Path.GetFullPath(Path.Combine(_webRoot, rel.TrimStart('/').Replace('/', Path.DirectorySeparatorChar)));
                if (!PathUtil.IsUnder(PathUtil.ToJs(_webRoot), PathUtil.ToJs(full)))
                {
                    await WriteStatus(stream, method, 403, "Forbidden", "text/plain; charset=utf-8", "forbidden");
                    return;
                }
                if (!File.Exists(full))
                {
                    await WriteStatus(stream, method, 404, "Not Found", "text/plain; charset=utf-8", "not found");
                    return;
                }
                await ServeFile(stream, method, full, Mime.TypeFor(full), headers, noCache: true);
            }
            catch (Exception ex)
            {
                AppPaths.Log("HTTP fail " + ex.Message);
            }
        }
    }

    private static async Task<string?> ReadHeaders(NetworkStream stream)
    {
        var buffer = new List<byte>(4096);
        var one = new byte[1];
        while (buffer.Count < 64 * 1024)
        {
            var n = await stream.ReadAsync(one);
            if (n <= 0) return null;
            buffer.Add(one[0]);
            if (buffer.Count >= 4 &&
                buffer[^1] == '\n' && buffer[^2] == '\r' && buffer[^3] == '\n' && buffer[^4] == '\r')
            {
                return Encoding.UTF8.GetString(buffer.ToArray());
            }
        }
        return null;
    }

    private static async Task ServeFile(
        NetworkStream stream, string method, string nativePath, string contentType,
        Dictionary<string, string> headers, bool noCache)
    {
        var info = new FileInfo(nativePath);
        var total = info.Length;
        long start = 0;
        long end = total - 1;
        var partial = false;

        if (headers.TryGetValue("Range", out var range) && range.StartsWith("bytes=", StringComparison.Ordinal))
        {
            var spec = range["bytes=".Length..];
            var parts = spec.Split('-', 2);
            if (parts.Length == 2)
            {
                _ = long.TryParse(parts[0], out start);
                if (parts[1].Length > 0 && long.TryParse(parts[1], out var e)) end = e;
                if (start < 0) start = 0;
                if (end >= total) end = total - 1;
                if (start <= end && start < total) partial = true;
            }
        }

        var length = partial ? end - start + 1 : total;
        var sb = new StringBuilder();
        sb.Append(partial ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n");
        sb.Append($"Content-Type: {contentType}\r\n");
        sb.Append($"Content-Length: {length}\r\n");
        sb.Append("Accept-Ranges: bytes\r\n");
        sb.Append(noCache ? "Cache-Control: no-cache\r\n" : "Cache-Control: max-age=60\r\n");
        if (partial) sb.Append($"Content-Range: bytes {start}-{end}/{total}\r\n");
        sb.Append("Connection: close\r\n");
        sb.Append("\r\n");
        var head = Encoding.UTF8.GetBytes(sb.ToString());
        await stream.WriteAsync(head);

        if (method == "HEAD") return;

        using var fs = new FileStream(nativePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        fs.Seek(start, SeekOrigin.Begin);
        var buffer = new byte[64 * 1024];
        var remaining = length;
        while (remaining > 0)
        {
            var want = (int)Math.Min(buffer.Length, remaining);
            var read = await fs.ReadAsync(buffer.AsMemory(0, want));
            if (read <= 0) break;
            await stream.WriteAsync(buffer.AsMemory(0, read));
            remaining -= read;
        }
    }

    private static async Task WriteStatus(NetworkStream stream, string method, int code, string reason,
        string contentType, string body)
    {
        var bytes = Encoding.UTF8.GetBytes(body);
        var head = $"HTTP/1.1 {code} {reason}\r\nContent-Type: {contentType}\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.UTF8.GetBytes(head));
        if (method != "HEAD") await stream.WriteAsync(bytes);
    }

    public void Dispose()
    {
        _cts.Cancel();
        try { _listener.Stop(); } catch { }
        _cts.Dispose();
    }
}

internal static class Mime
{
    public static string TypeFor(string path)
    {
        return PathUtil.Ext(path) switch
        {
            "html" or "htm" => "text/html; charset=utf-8",
            "js" or "mjs" => "text/javascript; charset=utf-8",
            "css" => "text/css; charset=utf-8",
            "json" => "application/json; charset=utf-8",
            "svg" => "image/svg+xml",
            "png" => "image/png",
            "jpg" or "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "avif" => "image/avif",
            "ico" => "image/x-icon",
            "bmp" => "image/bmp",
            "pdf" => "application/pdf",
            "mp4" or "m4v" => "video/mp4",
            "webm" => "video/webm",
            "mov" => "video/quicktime",
            "mp3" => "audio/mpeg",
            "wav" => "audio/wav",
            "m4a" => "audio/mp4",
            "flac" => "audio/flac",
            "ogg" => "audio/ogg",
            "woff2" => "font/woff2",
            "woff" => "font/woff",
            "ttf" => "font/ttf",
            "otf" => "font/otf",
            "txt" or "md" => "text/plain; charset=utf-8",
            _ => "application/octet-stream"
        };
    }
}
