namespace SuperWorkStation;

/// <summary>目录监听 → fs.change 事件（防抖 120ms），对应 macOS 端的 FSEvents。</summary>
internal sealed class WatcherX : IDisposable
{
    private FileSystemWatcher? _watcher;
    private readonly Action<string[]> _onChange;
    private readonly object _lock = new();
    private readonly HashSet<string> _pending = new(StringComparer.OrdinalIgnoreCase);
    private System.Threading.Timer? _timer;
    private string _root = "";

    public WatcherX(Action<string[]> onChange)
    {
        _onChange = onChange;
    }

    public void Watch(string root)
    {
        var native = PathUtil.FromJs(root);
        lock (_lock)
        {
            if (_root.Equals(native, StringComparison.OrdinalIgnoreCase) && _watcher is not null) return;
            DisposeWatcher();
            _root = native;
            if (!Directory.Exists(native)) return;

            _watcher = new FileSystemWatcher(native)
            {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName |
                               NotifyFilters.LastWrite | NotifyFilters.Size,
                InternalBufferSize = 64 * 1024
            };
            _watcher.Created += OnChange;
            _watcher.Changed += OnChange;
            _watcher.Deleted += OnChange;
            _watcher.Renamed += OnRename;
            _watcher.Error += (_, e) => AppPaths.Log("WATCHER error " + e.GetException().Message);
            _watcher.EnableRaisingEvents = true;
        }
    }

    private void OnRename(object sender, RenamedEventArgs e)
    {
        Enqueue(e.OldFullPath);
        Enqueue(e.FullPath);
    }

    private void OnChange(object sender, FileSystemEventArgs e) => Enqueue(e.FullPath);

    private void Enqueue(string fullPath)
    {
        lock (_lock)
        {
            _pending.Add(PathUtil.ToJs(fullPath));
            _timer ??= new System.Threading.Timer(_ => Flush(), null, 120, Timeout.Infinite);
            _timer.Change(120, Timeout.Infinite);
        }
    }

    private void Flush()
    {
        string[] batch;
        lock (_lock)
        {
            if (_pending.Count == 0) return;
            batch = _pending.ToArray();
            _pending.Clear();
        }
        try { _onChange(batch); }
        catch (Exception ex) { AppPaths.Log("WATCHER emit fail " + ex.Message); }
    }

    private void DisposeWatcher()
    {
        if (_watcher is null) return;
        _watcher.EnableRaisingEvents = false;
        _watcher.Dispose();
        _watcher = null;
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _timer?.Dispose();
            _timer = null;
            DisposeWatcher();
        }
    }
}
