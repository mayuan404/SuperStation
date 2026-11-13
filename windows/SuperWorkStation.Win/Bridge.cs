using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;

namespace SuperWorkStation;

/// <summary>把网页 postMessage 的 {id, method, params} 路由到 Api，并把事件推回网页。</summary>
internal sealed class Bridge(MainForm form, Api api)
{
    private readonly MainForm _form = form;
    private readonly Api _api = api;

    public void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        long id;
        string method;
        Params p;
        try
        {
            using var doc = JsonDocument.Parse(e.WebMessageAsJson);
            var root = doc.RootElement;
            if (!root.TryGetProperty("id", out var idEl) || !idEl.TryGetInt64(out id)) return;
            method = root.TryGetProperty("method", out var m) ? m.GetString() ?? "" : "";
            p = new Params(root.TryGetProperty("params", out var pe) ? pe.Clone() : default);
        }
        catch (Exception ex)
        {
            AppPaths.Log("BRIDGE parse fail " + ex.Message);
            return;
        }

        _ = Task.Run(() =>
        {
            object? result = null;
            string? error = null;
            try
            {
                result = _api.Handle(method, p);
            }
            catch (ApiException ex)
            {
                error = ex.Message;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                AppPaths.Log($"API fail {method}: {ex}");
            }
            Reply(id, result, error);
        });
    }

    public void Emit(string name, object? payload)
    {
        Post(new Dictionary<string, object?>
        {
            ["event"] = name,
            ["payload"] = payload
        });
    }

    private void Reply(long id, object? result, string? error)
    {
        Post(new Dictionary<string, object?>
        {
            ["id"] = id,
            ["ok"] = error is null,
            ["result"] = result,
            ["error"] = error
        });
    }

    private void Post(object message)
    {
        var json = JsonSerializer.Serialize(message);
        _form.RunOnUi(() =>
        {
            try { _form.WebView.CoreWebView2?.PostWebMessageAsJson(json); }
            catch (Exception ex) { AppPaths.Log("BRIDGE post fail " + ex.Message); }
        });
    }
}
