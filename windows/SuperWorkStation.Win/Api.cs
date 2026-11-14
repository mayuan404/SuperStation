using System.Text;
using System.Windows.Forms;

namespace SuperWorkStation;

internal sealed partial class Api(MainForm form)
{
    private readonly MainForm _form = form;

    public object? Handle(string method, Params p)
    {
        // ssh:// 路径上的 fs.* 交给远端实现，网页层无感
        if (method.StartsWith("fs.", StringComparison.Ordinal))
        {
            var candidate = p.Str("path", p.Str("from"));
            if (candidate.StartsWith("ssh://", StringComparison.Ordinal))
            {
                var remoteResult = RemoteFsX.Handle(method, p);
                if (remoteResult is Dictionary<string, object?> dict &&
                    dict.TryGetValue("error", out var remoteError) && remoteError is not null)
                {
                    throw new ApiException(remoteError.ToString() ?? "远端操作失败");
                }
                return remoteResult;
            }
        }

        switch (method)
        {
            case "dev.snapshot":
                return null;

            case "app.log":
                AppPaths.Log(p.Str("line"));
                return null;

            case "app.info":
                return AppInfo();

            case "ui.openFolder":
                return _form.RunOnUiSync(() =>
                {
                    using var dialog = new FolderBrowserDialog
                    {
                        Description = "选择一个文件夹作为工作区",
                        UseDescriptionForTitle = true,
                        ShowNewFolderButton = true
                    };
                    return dialog.ShowDialog(_form) == DialogResult.OK ? PathUtil.ToJs(dialog.SelectedPath) : null;
                });

            case "ui.savePanel":
                return _form.RunOnUiSync(() =>
                {
                    using var dialog = new SaveFileDialog
                    {
                        FileName = p.Str("name", "untitled.txt"),
                        OverwritePrompt = true,
                        AddExtension = false
                    };
                    return dialog.ShowDialog(_form) == DialogResult.OK ? PathUtil.ToJs(dialog.FileName) : null;
                });

            case "ui.confirm":
                return _form.RunOnUiSync(() =>
                {
                    var result = MessageBox.Show(_form, p.Str("message"), p.Str("title", "确认"),
                        MessageBoxButtons.OKCancel, MessageBoxIcon.Question);
                    return result == DialogResult.OK;
                });

            case "ui.openExternal":
                Shell.OpenExternal(p.Str("url"));
                return null;

            case "ui.openPath":
                Shell.OpenPath(p.Str("path"));
                return null;

            case "ui.zoomWindow":
                _form.RunOnUi(_form.ToggleMaximize);
                return null;

            case "ui.beginDrag":
                _form.RunOnUi(_form.BeginDrag);
                return null;

            case "ui.reveal":
                Shell.Reveal(PathUtil.FromJs(p.Str("path")));
                return null;

            case "ui.setTitle":
                var title = p.Str("title");
                _form.RunOnUi(() => _form.Text = string.IsNullOrEmpty(title) ? "SuperWorkStation" : title);
                return null;

            case "ui.cursor":
                // Windows 上光标由 Chromium 自己管，不需要桥接
                return null;

            case "ui.pickFiles":
                return _form.RunOnUiSync(() =>
                {
                    using var dialog = new OpenFileDialog { Multiselect = true, Title = "选择" };
                    return dialog.ShowDialog(_form) == DialogResult.OK
                        ? dialog.FileNames.Select(PathUtil.ToJs).ToArray()
                        : Array.Empty<string>();
                });

            case "ui.isFullscreen":
                return _form.IsFullscreen;

            case "ui.copy":
                var text = p.Str("text");
                _form.RunOnUi(() =>
                {
                    try { Clipboard.SetText(text); }
                    catch (Exception ex) { AppPaths.Log("CLIPBOARD fail " + ex.Message); }
                });
                return null;

            case "ui.window":
                switch (p.Str("action"))
                {
                    case "min": _form.RunOnUi(_form.Minimize); break;
                    case "max": _form.RunOnUi(_form.ToggleMaximize); break;
                    case "close": _form.RunOnUi(_form.Close); break;
                }
                return null;

            case "fs.list":
                var listPath = p.Str("path");
                if (!FsX.IsDir(listPath)) throw new ApiException("目录不存在");
                return FsX.List(listPath);

            case "fs.read":
                return FsX.Read(p.Str("path"));

            case "fs.write":
                return FsX.Write(p.Str("path", p.Str("to")), p.Str("text"));

            case "fs.mkdir":
                FsX.Mkdir(p.Str("path"));
                return null;

            case "fs.create":
                FsX.CreateFile(p.Str("path"), p.Str("text"));
                return null;

            case "fs.rename":
                FsX.Rename(p.Str("from"), p.Str("to"));
                return null;

            case "fs.trash":
                FsX.Trash(p.Str("path"));
                return null;

            case "fs.exists":
                return FsX.Exists(p.Str("path"));

            case "fs.search":
                return SearchX.Search(
                    p.Str("root"), p.Str("query"), p.Int("limit", 200),
                    p.Bool("caseSensitive"), p.Bool("wholeWord"), p.Bool("namesOnly"), p.Dbl("budget", 8));

            case "fs.index":
                return FsX.Index(p.Str("path"));

            case "fs.stat":
                return FsX.Stat(p.Str("path"));

            case "fs.size":
                return FsX.Size(p.Str("path"));

            case "fs.copy":
                FsX.Copy(p.Str("from"), p.Str("to"));
                return null;

            case "fs.move":
                FsX.Move(p.Str("from"), p.Str("to"));
                return null;

            case "fs.writeBytes":
                var raw = p.Str("base64");
                try { FsX.WriteBytes(p.Str("path", p.Str("to")), Convert.FromBase64String(raw)); }
                catch (FormatException) { throw new ApiException("数据无效"); }
                return null;

            case "fs.unzip":
                AllowedRoots.GuardWrite(p.Str("path", p.Str("to")));
                return ArchiveX.Extract(p.Str("path"));

            case "fs.check":
                return ChecksX.Run(p.Str("path"), p.Str("text"));

            case "fs.textOf":
                return TextX.Extract(p.Str("path"));

            case "fs.watch":
                _form.RunOnUi(() => _form.Watch(p.Str("root")));
                return null;

            case "history.list":
                return DocsStore.HistoryList(p.Str("path"));

            case "history.read":
                return DocsStore.HistoryRead(p.Str("path"), p.Str("id"));

            case "drafts.put":
                DocsStore.PutDraft(p.Str("path"), p.Str("name"), p.Str("text"));
                return null;

            case "drafts.drop":
                DocsStore.DropDraft(p.Str("path"));
                return null;

            case "drafts.list":
                return DocsStore.ListDrafts();

            case "drafts.read":
                return DocsStore.ReadDraft(p.Str("path"));

            case "app.allowRoot":
                AllowedRoots.Allow(p.Str("path"));
                return null;

            case "pdf.info":
                return PdfX.Info(p.Str("path"));

            case "pdf.render":
                return PdfX.Render(p.Str("path"), p.Int("page"), p.Dbl("width", 1000));

            case "office.thumb":
                return null;

            case "office.quickLook":
                Shell.Open(PathUtil.FromJs(p.Str("path")));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "epub.info":
                throw new ApiException("Windows 版暂不支持 EPUB 预览，请用默认阅读器打开");

            case "vault.isFileVault":
                return VaultX.IsFileVault(p.Str("path"));

            case "vault.encryptFile":
                return new Dictionary<string, object?> { ["path"] = VaultX.EncryptFile(p.Str("path"), p.Str("password")) };

            case "vault.unlockFile":
                VaultX.UnlockFile(p.Str("path"), p.Str("password"));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "vault.lockFile":
                VaultX.LockFile(p.Str("path"));
                return null;

            case "vault.decryptFile":
                return new Dictionary<string, object?> { ["path"] = VaultX.DecryptFile(p.Str("path"), p.Str("password")) };

            case "vault.status":
                var vp = p.Str("path");
                return VaultX.Status(vp);

            case "vault.findRoot":
                return VaultX.FindRoot(p.Str("path"));

            case "vault.create":
                VaultX.Create(p.Str("path"), p.Str("password"), p.Bool("convert"));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "vault.unlock":
                VaultX.Unlock(p.Str("path"), p.Str("password"));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "vault.remove":
                VaultX.Remove(p.Str("path"), p.Str("password"));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "vault.lock":
                VaultX.Lock(p.Str("path"));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "ai.setKey":
                AiX.SetKey(p.Str("key"));
                return null;

            case "ai.hasKey":
                return AiX.HasKey;

            case "ai.test":
                return AiX.Test(p);

            case "ai.chat":
                return AiX.Chat(p, _form);

            case "ai.cancel":
                AiX.Cancel(p.Str("id"));
                return null;

            case "ssh.setSecret":
                SshSecretsX.Set(p.Str("id"), p.Str("password"));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "ssh.hasSecret":
                return new Dictionary<string, object?> { ["has"] = SshSecretsX.Has(p.Str("id")) };

            case "remote.register":
                RemoteX.Register(p.Str("id"), p.Str("host"), p.Int("port", 22), p.Str("user", "root"), p.Str("secretId"));
                return new Dictionary<string, object?> { ["ok"] = true };

            case "remote.forget":
                RemoteX.Forget(p.Str("id"));
                return null;

            case "remote.warm":
                return RemoteX.Warm(TargetFrom(p));

            case "remote.search":
                return RemoteX.Search(TargetFrom(p), p.Str("path", "."), p.Str("query"),
                    p.Int("limit", 60), p.Bool("caseSensitive"));

            case "remote.list":
                return RemoteX.List(TargetFrom(p), p.Str("path", "."));

            case "remote.download":
                return RemoteX.Download(TargetFrom(p), p.Str("path"), p.Str("to"));

            case "remote.upload":
                return RemoteX.Upload(TargetFrom(p), p.Str("local"), p.Str("to"));

            case "remote.mkdir":
                return RemoteX.Mkdir(TargetFrom(p), p.Str("path"));

            case "remote.remove":
                return RemoteX.Remove(TargetFrom(p), p.Str("path"));

            case "remote.rename":
                return RemoteX.Rename(TargetFrom(p), p.Str("from"), p.Str("to"));

            case "remote.git":
                return RemoteX.Git(p.Str("path"), p.Str("action", "status"), p.Str("message", "update"));

            case "remote.exec":
                return RemoteX.Exec(p.Str("path"), p.Str("cmd"), p.Int("timeout", 60));

            case "remote.gitStatus":
                return RemoteX.GitStatus(p.Str("path"));

            case "pty.open":
                return PtyRegistryX.Open(p, _form);

            case "pty.write":
                PtyRegistryX.Write(p.Str("id"), p.Str("data"));
                return null;

            case "pty.resize":
                PtyRegistryX.Resize(p.Str("id"), p.Int("cols", 100), p.Int("rows", 30));
                return null;

            case "pty.close":
                PtyRegistryX.Close(p.Str("id"));
                return null;

            default:
                throw new ApiException("未知方法: " + method);
        }
    }

    private Dictionary<string, object?> AppInfo()
    {
        return new Dictionary<string, object?>
        {
            ["version"] = Program.Version,
            ["home"] = AppPaths.Home,
            ["temp"] = PathUtil.ToJs(Path.GetTempPath()),
            ["os"] = Environment.OSVersion.VersionString,
            ["initial"] = Environment.GetEnvironmentVariable("BNB_OPEN") ?? "",
            ["initialFile"] = Environment.GetEnvironmentVariable("BNB_FILE") ?? "",
            ["samples"] = AppPaths.EnsureSamples(),
            ["platform"] = "windows",
            ["defaultShell"] = Shells.Default,
            ["fileBase"] = _form.BaseUrl + "/__file/",
            ["allowedRoots"] = AllowedRoots.Snapshot()
        };
    }

    private static SshTarget TargetFrom(Params p)
    {
        return new SshTarget
        {
            Host = p.Str("host"),
            Port = p.Int("port", 22),
            User = p.Str("user", "root"),
            SecretId = p.Str("secretId")
        };
    }
}

internal static class Shells
{
    /// <summary>Windows 自带 PowerShell 5.1，最稳；有 pwsh 也优先用系统自带那个。</summary>
    public static string Default
    {
        get
        {
            var system = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System),
                "WindowsPowerShell", "v1.0", "powershell.exe");
            return File.Exists(system) ? system : "powershell.exe";
        }
    }

    public static string OpenSsh
    {
        get
        {
            var system = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.System), "OpenSSH", "ssh.exe");
            return File.Exists(system) ? system : "ssh.exe";
        }
    }
}
