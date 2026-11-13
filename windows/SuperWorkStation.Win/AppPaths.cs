using System.Text;

namespace SuperWorkStation;

/// <summary>应用数据目录、日志、示例文档。</summary>
internal static class AppPaths
{
    private static readonly object LogLock = new();

    public static string Home { get; } =
        PathUtil.ToJs(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));

    /// <summary>%APPDATA%\SuperWorkStation，等价于 macOS 的 Application Support。</summary>
    public static string Support { get; } = InitSupport();

    public static string Logs { get; } = InitLogs();

    public static string LogFile { get; } = Path.Combine(Logs, "SuperWorkStation.log");

    public static string WebRoot { get; } = FindWebRoot();

    private static string InitSupport()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "SuperWorkStation");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string InitLogs()
    {
        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SuperWorkStation", "logs");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static string FindWebRoot()
    {
        var baseDir = AppContext.BaseDirectory;
        var web = Path.Combine(baseDir, "web");
        return Directory.Exists(web) ? web : baseDir;
    }

    /// <summary>把内置 samples 复制到用户目录，只补缺失文件。</summary>
    public static string EnsureSamples()
    {
        var src = Path.Combine(AppContext.BaseDirectory, "samples");
        var dest = Path.Combine(Support, "samples");
        if (!Directory.Exists(src)) return Directory.Exists(dest) ? PathUtil.ToJs(dest) : "";
        Directory.CreateDirectory(dest);
        foreach (var file in Directory.EnumerateFiles(src, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(src, file);
            var target = Path.Combine(dest, rel);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            if (!File.Exists(target)) File.Copy(file, target);
        }
        return PathUtil.ToJs(dest);
    }

    public static void Log(string line)
    {
        try
        {
            lock (LogLock)
            {
                var stamp = DateTimeOffset.Now.ToString("yyyy-MM-ddTHH:mm:ssK");
                File.AppendAllText(LogFile, $"[{stamp}] {line}{Environment.NewLine}", Encoding.UTF8);
                // 超过 8MB 就轮换一次，避免长跑把盘写满
                var info = new FileInfo(LogFile);
                if (info.Exists && info.Length > 8 * 1024 * 1024)
                {
                    var old = LogFile + ".1";
                    if (File.Exists(old)) File.Delete(old);
                    File.Move(LogFile, old);
                }
            }
        }
        catch
        {
            // 日志失败不能影响主流程
        }
    }
}
