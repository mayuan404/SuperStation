using System.Text.Json;

namespace SuperWorkStation;

internal sealed class ApiException(string message) : Exception(message);

/// <summary>桥接参数的只读视图，补上 macOS 端 [String: Any] 那套取值习惯。</summary>
internal readonly struct Params(JsonElement root)
{
    private readonly JsonElement _root = root;

    private bool TryGet(string key, out JsonElement el)
    {
        el = default;
        return _root.ValueKind == JsonValueKind.Object && _root.TryGetProperty(key, out el);
    }

    public string Str(string key, string fallback = "")
    {
        if (!TryGet(key, out var el)) return fallback;
        return el.ValueKind switch
        {
            JsonValueKind.String => el.GetString() ?? fallback,
            JsonValueKind.Null => fallback,
            JsonValueKind.Undefined => fallback,
            _ => el.ToString()
        };
    }

    public int Int(string key, int fallback = 0)
    {
        if (!TryGet(key, out var el)) return fallback;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n)) return n;
        if (el.ValueKind == JsonValueKind.String && int.TryParse(el.GetString(), out var s)) return s;
        return fallback;
    }

    public long Long(string key, long fallback = 0)
    {
        if (!TryGet(key, out var el)) return fallback;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out var n)) return n;
        if (el.ValueKind == JsonValueKind.String && long.TryParse(el.GetString(), out var s)) return s;
        return fallback;
    }

    public double Dbl(string key, double fallback = 0)
    {
        if (!TryGet(key, out var el)) return fallback;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetDouble(out var n)) return n;
        if (el.ValueKind == JsonValueKind.String && double.TryParse(el.GetString(), out var s)) return s;
        return fallback;
    }

    public bool Bool(string key, bool fallback = false)
    {
        if (!TryGet(key, out var el)) return fallback;
        return el.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            JsonValueKind.Number => el.GetDouble() != 0,
            JsonValueKind.String => el.GetString() is "1" or "true" or "yes",
            _ => fallback
        };
    }

    public string[] StrArray(string key)
    {
        if (!TryGet(key, out var el) || el.ValueKind != JsonValueKind.Array) return [];
        return el.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.String)
            .Select(x => x.GetString() ?? "")
            .ToArray();
    }

    public Dictionary<string, string> StrMap(string key)
    {
        var map = new Dictionary<string, string>();
        if (!TryGet(key, out var el) || el.ValueKind != JsonValueKind.Object) return map;
        foreach (var p in el.EnumerateObject())
        {
            if (p.Value.ValueKind == JsonValueKind.String) map[p.Name] = p.Value.GetString() ?? "";
        }
        return map;
    }

    public Params? Obj(string key)
    {
        if (!TryGet(key, out var el) || el.ValueKind != JsonValueKind.Object) return null;
        return new Params(el);
    }

    public JsonElement El(string key)
    {
        return TryGet(key, out var el) ? el : default;
    }
}
