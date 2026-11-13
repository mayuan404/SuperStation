using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace SuperWorkStation;

/// <summary>
/// 无边框主窗口：网页自绘标题栏与窗口按钮，边缘交给 WM_NCHITTEST 做缩放，
/// 网页内部的自定义协议由本地 HTTP 服务提供（见 WebServer）。
/// </summary>
internal sealed class MainForm : Form, IMessageFilter
{
    private const int WM_NCHITTEST = 0x0084;
    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int HTCAPTION = 2;
    private const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13,
        HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    private readonly WebServer _server;
    private readonly WatcherX _watcher;
    private readonly Api _api;
    private readonly Bridge _bridge;

    public WebView2 WebView { get; }
    public string BaseUrl => _server.BaseUrl;

    public MainForm()
    {
        Text = "SuperWorkStation";
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(760, 500);
        Size = new Size(1280, 820);
        BackColor = Color.FromArgb(0xF2, 0xF2, 0xF4);
        KeyPreview = true;
        AutoScaleMode = AutoScaleMode.Dpi;

        WebView = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(WebView);

        _api = new Api(this);
        _bridge = new Bridge(this, _api);
        _watcher = new WatcherX(paths => _bridge.Emit("fs.change", new Dictionary<string, object?> { ["paths"] = paths }));
        _server = new WebServer(AppPaths.WebRoot);

        Application.AddMessageFilter(this);
        LoadWindowBounds();
        Load += OnLoaded;
        Resize += (_, _) => _bridge.Emit("ui.maximized", new Dictionary<string, object?> { ["value"] = WindowState == FormWindowState.Maximized });
        FormClosing += (_, _) => SaveBounds();
    }

    private async void OnLoaded(object? sender, EventArgs e)
    {
        AppPaths.Log($"BOOT webroot={AppPaths.WebRoot} port={_server.Port}");
        try
        {
            var userData = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "SuperWorkStation", "WebView2");
            Directory.CreateDirectory(userData);

            var env = await CoreWebView2Environment.CreateAsync(null, userData);
            await WebView.EnsureCoreWebView2Async(env);

            var core = WebView.CoreWebView2!;
            core.Settings.AreDevToolsEnabled = true;
            core.Settings.IsStatusBarEnabled = false;
            core.Settings.AreDefaultContextMenusEnabled = true;
            core.Settings.IsZoomControlEnabled = false;
            core.Settings.IsSwipeNavigationEnabled = false;
            core.Settings.IsPasswordAutosaveEnabled = false;
            core.Settings.IsGeneralAutofillEnabled = false;
            core.WebMessageReceived += _bridge.OnWebMessage;
            core.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                Shell.OpenExternal(args.Uri);
            };
            core.NavigationCompleted += (_, args) =>
            {
                AppPaths.Log($"NAV done success={args.IsSuccess} error={args.WebErrorStatus}");
                _bridge.Emit("ready", new Dictionary<string, object?>());
            };

            core.Navigate($"{BaseUrl}/index.html");
            AppPaths.Log("NAV start " + BaseUrl);
        }
        catch (Exception ex)
        {
            AppPaths.Log("WEBVIEW init fail " + ex);
            MessageBox.Show(
                "WebView2 运行时未安装或启动失败。\n\n请先安装 Microsoft Edge WebView2 Runtime：\nhttps://go.microsoft.com/fwlink/p/?LinkId=2124703\n\n" + ex.Message,
                "SuperWorkStation", MessageBoxButtons.OK, MessageBoxIcon.Error);
            Close();
        }
    }

    // ---- 由网页按钮调用 ----

    public void Watch(string root) => _watcher.Watch(root);

    public void Emit(string name, object? payload) => _bridge.Emit(name, payload);

    public void BeginDrag()
    {
        ReleaseCapture();
        SendMessage(Handle, WM_NCLBUTTONDOWN, HTCAPTION, IntPtr.Zero);
    }

    public void ToggleMaximize()
    {
        if (WindowState == FormWindowState.Maximized)
        {
            WindowState = FormWindowState.Normal;
        }
        else
        {
            MaximizedBounds = Screen.FromControl(this).WorkingArea;
            WindowState = FormWindowState.Maximized;
        }
    }

    public void Minimize() => WindowState = FormWindowState.Minimized;

    public bool IsFullscreen => WindowState == FormWindowState.Maximized;

    // ---- 线程编组 ----

    public void RunOnUi(Action action)
    {
        if (IsDisposed) return;
        try
        {
            if (InvokeRequired) BeginInvoke(action);
            else action();
        }
        catch (Exception ex)
        {
            AppPaths.Log("RunOnUi fail " + ex.Message);
        }
    }

    public T RunOnUiSync<T>(Func<T> func)
    {
        if (!InvokeRequired) return func();
        return (T)Invoke(func);
    }

    // ---- 无边框窗口的缩放：WebView2 覆盖整个客户区，只能在线程消息层拦 WM_NCHITTEST ----

    public bool PreFilterMessage(ref Message m)
    {
        if (m.Msg != WM_NCHITTEST || WindowState == FormWindowState.Maximized) return false;
        if (m.HWnd != Handle && !IsWebViewChild(m.HWnd)) return false;

        var screen = new Point((short)(m.LParam.ToInt64() & 0xFFFF), (short)((m.LParam.ToInt64() >> 16) & 0xFFFF));
        var edge = LogicalToDeviceUnits(6);
        var rect = Bounds;
        var left = screen.X <= rect.Left + edge && screen.X >= rect.Left - edge;
        var right = screen.X >= rect.Right - edge && screen.X <= rect.Right + edge;
        var top = screen.Y <= rect.Top + edge && screen.Y >= rect.Top - edge;
        var bottom = screen.Y >= rect.Bottom - edge && screen.Y <= rect.Bottom + edge;

        int hit = 0;
        if (left && top) hit = HTTOPLEFT;
        else if (right && top) hit = HTTOPRIGHT;
        else if (left && bottom) hit = HTBOTTOMLEFT;
        else if (right && bottom) hit = HTBOTTOMRIGHT;
        else if (left) hit = HTLEFT;
        else if (right) hit = HTRIGHT;
        else if (top) hit = HTTOP;
        else if (bottom) hit = HTBOTTOM;
        if (hit == 0) return false;

        m.Result = hit;
        return true;
    }

    private bool IsWebViewChild(IntPtr hwnd)
    {
        var current = hwnd;
        while (current != IntPtr.Zero)
        {
            if (current == Handle) return true;
            current = GetParent(current);
        }
        return false;
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr hWnd);

    // ---- 窗口位置记忆 ----

    private string BoundsFile => Path.Combine(AppPaths.Support, "window.json");

    private void SaveBounds()
    {
        try
        {
            var payload = new Dictionary<string, object?>
            {
                ["x"] = RestoreBounds.X,
                ["y"] = RestoreBounds.Y,
                ["w"] = RestoreBounds.Width,
                ["h"] = RestoreBounds.Height,
                ["max"] = WindowState == FormWindowState.Maximized
            };
            File.WriteAllText(BoundsFile, JsonSerializer.Serialize(payload));
        }
        catch { }
    }

    private void LoadWindowBounds()
    {
        try
        {
            if (!File.Exists(BoundsFile)) return;
            using var doc = JsonDocument.Parse(File.ReadAllText(BoundsFile));
            var root = doc.RootElement;
            var x = root.GetProperty("x").GetInt32();
            var y = root.GetProperty("y").GetInt32();
            var w = Math.Max(760, root.GetProperty("w").GetInt32());
            var h = Math.Max(500, root.GetProperty("h").GetInt32());
            var rect = new Rectangle(x, y, w, h);
            var visible = Screen.AllScreens.Any(s => s.WorkingArea.IntersectsWith(rect));
            if (visible) Bounds = rect;
            if (root.TryGetProperty("max", out var max) && max.GetBoolean())
            {
                Shown += (_, _) =>
                {
                    MaximizedBounds = Screen.FromControl(this).WorkingArea;
                    WindowState = FormWindowState.Maximized;
                };
            }
        }
        catch { }
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Application.RemoveMessageFilter(this);
            _watcher.Dispose();
            _server.Dispose();
        }
        base.Dispose(disposing);
    }
}
