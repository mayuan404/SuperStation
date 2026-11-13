namespace SuperWorkStation;

/// <summary>
/// 网页只能读取/写入被显式授权过的目录：用户通过「打开文件夹 / 另存为」选中的路径，
/// 加上默认的个人目录、应用数据目录和临时目录。其余位置一律拒绝，避免笔记内容被当成任意文件通道。
/// </summary>
internal static class AllowedRoots
{
    private static readonly object Lock = new();
    private static readonly List<string> Roots =
    [
        AppPaths.Home,
        PathUtil.ToJs(AppPaths.Support),
        PathUtil.ToJs(Path.GetTempPath())
    ];

    public static void Allow(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        var p = PathUtil.Full(path);
        lock (Lock)
        {
            if (!Roots.Contains(p, StringComparer.OrdinalIgnoreCase)) Roots.Add(p);
        }
    }

    public static bool Allows(string path)
    {
        if (string.IsNullOrEmpty(path)) return false;
        var p = PathUtil.Full(path);
        lock (Lock)
        {
            return Roots.Any(root => PathUtil.IsUnder(root, p));
        }
    }

    public static void GuardWrite(string path)
    {
        if (!Allows(path))
        {
            throw new ApiException("该位置未授权写入：在「打开」对话框里选择过这个目录后才能修改");
        }
    }

    public static IReadOnlyList<string> Snapshot()
    {
        lock (Lock) return Roots.ToArray();
    }
}
