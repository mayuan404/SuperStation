using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;

namespace SuperWorkStation;

/// <summary>
/// 用户自备的 AI 配置：请求由原生发出（不受 CORS 限制），接口格式与 OpenAI 一致。
/// 密钥存在应用数据目录，不进设置、不进日志。
/// </summary>
internal static class AiX
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(5) };
    private static readonly object Lock = new();
    private static readonly Dictionary<string, CancellationTokenSource> Running = new();

    private static string KeyFile => Path.Combine(AppPaths.Support, "ai.key");

    public static bool HasKey => !string.IsNullOrWhiteSpace(ApiKey());

    public static string? ApiKey()
    {
        try
        {
            if (!File.Exists(KeyFile)) return null;
            var text = File.ReadAllText(KeyFile, Encoding.UTF8).Trim();
            return text.Length == 0 ? null : text;
        }
        catch
        {
            return null;
        }
    }

    public static void SetKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            try { File.Delete(KeyFile); } catch { }
            return;
        }
        File.WriteAllText(KeyFile, key.Trim(), new UTF8Encoding(false));
    }

    private static Uri? Endpoint(string baseUrl)
    {
        var s = (baseUrl ?? "").Trim().TrimEnd('/');
        if (s.Length == 0) s = "https://api.deepseek.com";
        if (s.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) return new Uri(s);
        return new Uri(s + "/chat/completions");
    }

    public static Dictionary<string, object?> Chat(Params p, MainForm form)
    {
        var id = p.Str("id");
        if (string.IsNullOrEmpty(id)) id = Guid.NewGuid().ToString("N");

        var key = ApiKey();
        if (key is null) return new Dictionary<string, object?> { ["error"] = "还没有配置 API Key" };
        var endpoint = Endpoint(p.Str("baseURL", "https://api.deepseek.com"));
        if (endpoint is null) return new Dictionary<string, object?> { ["error"] = "API 地址无效" };

        var messages = p.El("messages");
        var body = new Dictionary<string, object?>
        {
            ["model"] = p.Str("model", "deepseek-chat"),
            ["messages"] = messages.ValueKind == JsonValueKind.Array ? messages : Array.Empty<object>(),
            ["stream"] = true,
            ["temperature"] = p.Dbl("temperature", 0.7)
        };
        var payload = JsonSerializer.Serialize(body);

        var cts = new CancellationTokenSource();
        lock (Lock) Running[id] = cts;

        _ = Task.Run(async () =>
        {
            var full = new StringBuilder();
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
                request.Content = new StringContent(payload, Encoding.UTF8, "application/json");

                using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cts.Token);
                if (!response.IsSuccessStatusCode)
                {
                    var text = await response.Content.ReadAsStringAsync(cts.Token);
                    if (text.Length > 400) text = text[..400];
                    form.Emit("ai.error", new Dictionary<string, object?>
                    {
                        ["id"] = id,
                        ["message"] = $"HTTP {(int)response.StatusCode}：{text}"
                    });
                    return;
                }

                await using var stream = await response.Content.ReadAsStreamAsync(cts.Token);
                using var reader = new StreamReader(stream, Encoding.UTF8);
                while (!reader.EndOfStream)
                {
                    var line = await reader.ReadLineAsync(cts.Token);
                    if (line is null) break;
                    if (!line.StartsWith("data:", StringComparison.Ordinal)) continue;
                    var data = line[5..].Trim();
                    if (data == "[DONE]") break;
                    try
                    {
                        using var doc = JsonDocument.Parse(data);
                        var choices = doc.RootElement.GetProperty("choices");
                        if (choices.GetArrayLength() == 0) continue;
                        if (!choices[0].TryGetProperty("delta", out var delta)) continue;
                        if (!delta.TryGetProperty("content", out var content)) continue;
                        var piece = content.GetString();
                        if (string.IsNullOrEmpty(piece)) continue;
                        full.Append(piece);
                        form.Emit("ai.delta", new Dictionary<string, object?>
                        {
                            ["id"] = id,
                            ["text"] = piece
                        });
                    }
                    catch (JsonException)
                    {
                        // 单条 SSE 解析失败不影响整段
                    }
                }
                form.Emit("ai.done", new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["text"] = full.ToString()
                });
            }
            catch (OperationCanceledException)
            {
                form.Emit("ai.done", new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["text"] = full.ToString(),
                    ["cancelled"] = true
                });
            }
            catch (Exception ex)
            {
                form.Emit("ai.error", new Dictionary<string, object?>
                {
                    ["id"] = id,
                    ["message"] = ex.Message
                });
            }
            finally
            {
                lock (Lock) Running.Remove(id);
                cts.Dispose();
            }
        });

        return new Dictionary<string, object?> { ["id"] = id };
    }

    public static void Cancel(string id)
    {
        CancellationTokenSource? cts;
        lock (Lock)
        {
            Running.TryGetValue(id, out cts);
            Running.Remove(id);
        }
        try { cts?.Cancel(); } catch { }
    }

    public static Dictionary<string, object?> Test(Params p)
    {
        var key = ApiKey();
        if (key is null) return new Dictionary<string, object?> { ["ok"] = false, ["message"] = "还没有配置 API Key" };
        var endpoint = Endpoint(p.Str("baseURL", "https://api.deepseek.com"));
        if (endpoint is null) return new Dictionary<string, object?> { ["ok"] = false, ["message"] = "API 地址无效" };

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", key);
            var body = new Dictionary<string, object?>
            {
                ["model"] = p.Str("model", "deepseek-chat"),
                ["messages"] = new object[] { new Dictionary<string, string> { ["role"] = "user", ["content"] = "ping" } },
                ["max_tokens"] = 1,
                ["stream"] = false
            };
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

            using var response = Http.SendAsync(request).GetAwaiter().GetResult();
            if (response.IsSuccessStatusCode)
                return new Dictionary<string, object?> { ["ok"] = true, ["message"] = "连接成功" };

            var text = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            if (text.Length > 300) text = text[..300];
            return new Dictionary<string, object?>
            {
                ["ok"] = false,
                ["message"] = $"HTTP {(int)response.StatusCode}：{text}"
            };
        }
        catch (Exception ex)
        {
            return new Dictionary<string, object?> { ["ok"] = false, ["message"] = ex.Message };
        }
    }
}
