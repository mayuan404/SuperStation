using System.Diagnostics;
using System.Runtime.InteropServices;

namespace SuperWorkStation;

/// <summary>和 Windows 外壳打交道的零碎操作：回收站、资源管理器定位、默认程序打开。</summary>
internal static class Shell
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string? pTo;
        public ushort fFlags;
        public bool fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string? lpszProgressTitle;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern int SHFileOperation(ref SHFILEOPSTRUCT fileOp);

    private const uint FO_DELETE = 0x0003;
    private const ushort FOF_SILENT = 0x0004;
    private const ushort FOF_NOCONFIRMATION = 0x0010;
    private const ushort FOF_ALLOWUNDO = 0x0040;
    private const ushort FOF_NOERRORUI = 0x0400;

    /// <summary>删除到回收站（可撤销），失败时退回普通删除。</summary>
    public static void Recycle(string nativePath)
    {
        try
        {
            var op = new SHFILEOPSTRUCT
            {
                wFunc = FO_DELETE,
                pFrom = nativePath + "\0\0",
                fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
            };
            var code = SHFileOperation(ref op);
            if (code == 0 && !op.fAnyOperationsAborted) return;
        }
        catch
        {
            // 落到普通删除
        }

        if (Directory.Exists(nativePath)) Directory.Delete(nativePath, recursive: true);
        else if (File.Exists(nativePath)) File.Delete(nativePath);
    }

    public static void Reveal(string nativePath)
    {
        var target = nativePath;
        if (!File.Exists(target) && !Directory.Exists(target))
        {
            var parent = Path.GetDirectoryName(target);
            if (parent is null || (!File.Exists(parent) && !Directory.Exists(parent))) return;
            target = parent;
        }
        Start("explorer.exe", $"/select,\"{target}\"");
    }

    public static void Open(string nativePath)
    {
        if (!File.Exists(nativePath) && !Directory.Exists(nativePath)) return;
        try
        {
            Process.Start(new ProcessStartInfo(nativePath) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppPaths.Log("OPEN fail " + nativePath + " " + ex.Message);
        }
    }

    /// <summary>用系统默认程序打开本地文件（HEIC/TIFF 之类浏览器解不了的格式靠它兜底）。</summary>
    public static void OpenPath(string jsPath)
    {
        if (string.IsNullOrWhiteSpace(jsPath)) return;
        try
        {
            var native = PathUtil.FromJs(jsPath);
            if (!File.Exists(native)) return;
            Process.Start(new ProcessStartInfo(native) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppPaths.Log("OPEN-PATH fail " + ex.Message);
        }
    }

    public static void OpenExternal(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme is not ("http" or "https" or "mailto")) return;
        try
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppPaths.Log("OPEN-EXTERNAL fail " + ex.Message);
        }
    }

    public static void Start(string exe, string args)
    {
        try
        {
            Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = true });
        }
        catch (Exception ex)
        {
            AppPaths.Log("START fail " + exe + " " + ex.Message);
        }
    }
}
