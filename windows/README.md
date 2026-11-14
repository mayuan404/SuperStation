# Windows 版（x64）

macOS 版是 Swift + WKWebView 原生外壳；Windows 版把外壳换成 **.NET 8 (WinForms) + WebView2**，
网页层（`src/`）几乎原样复用，桥接协议保持一致（77 个 `fs.* / ui.* / pty.* / remote.*` 命令）。

## 结构

```
windows/SuperWorkStation.Win/
  Program.cs            入口
  MainForm.cs           无边框窗口、WebView2 初始化、边缘缩放
  Bridge.cs             postMessage ↔ Api 的 JSON 桥
  Api.cs                fs.* / ui.* / history.* / drafts.* / vault.* 分发
  Native/
    WebServer.cs        127.0.0.1 本地 HTTP 服务：静态资源 + /__file/ 授权文件（支持 Range）
    FsX.cs              文件读写、目录遍历、索引
    DocsStore.cs        保存历史 + 崩溃草稿
    SearchX.cs          文件名 / 内容搜索
    WatcherX.cs         FileSystemWatcher → fs.change
    ConPty.cs           ConPTY（CreatePseudoConsole）本地终端
    PtyRegistryX.cs     终端注册表 + SSH.NET 交互 shell
    Ssh.cs / RemoteX.cs SSH 连接池、SFTP、远端 git
    VaultX.cs           AES-256-GCM + PBKDF2（与 macOS 端格式兼容）
    PdfX.cs             Windows.Data.Pdf 渲染 PDF 页面
    ArchiveAndText.cs   zip/tar 解压、语法检查、文本抽取
    AiX.cs              OpenAI 兼容的流式代理
    SshSecretsX.cs      DPAPI 加密保存 SSH 密码
```

## 构建

Windows 机器或 CI（推荐后者）：

```powershell
npm ci
npx vite build
dotnet publish windows/SuperWorkStation.Win/SuperWorkStation.Win.csproj `
  -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o out/win-x64
Compress-Archive -Path out/win-x64/* -DestinationPath SuperWorkStation-win-x64.zip
```

GitHub Actions：`.github/workflows/windows.yml`（windows-latest，自包含发布，产物为 artifact）。

## 运行要求

- Windows 10 1809+ / Windows 11，**x64**（ARM64 机器通过系统 x64 模拟运行）
- **WebView2 Runtime**：Win11 一般自带；缺失时程序会提示下载
  <https://go.microsoft.com/fwlink/p/?LinkId=2124703>
- 自包含发布，不需要单独装 .NET 运行时

## 平台差异（与 macOS 版相比）

| 能力 | Windows 实现 |
| --- | --- |
| 快速查看 / Office 预览 | 用系统默认程序打开（无 Quick Look） |
| 在 Finder 中显示 | 资源管理器 `/select` |
| 加密目录 | 兼容 `.bnbook-vault` 与 `.bnenc`，同一密码两边可互开 |
| 终端 | 本地 PowerShell（ConPTY）；SSH 有密码时走 SSH.NET，无密码时走系统 `ssh.exe` 交互输入 |
| PDF | `Windows.Data.Pdf` 渲染成 PNG，交互与 macOS 版一致 |
| EPUB | 暂不支持（用默认阅读器打开） |
| 全局热键 | 暂未实现 |
| ⌘ 快捷键 | 映射为 Ctrl（界面文案自动替换） |

## 已知限制

- Office 缩略图没有（`office.thumb` 返回 null，界面提示用默认程序打开）
- 远端终端不支持 ControlMaster 复用（用连接池替代，行为等价）
- 未签名 exe 首次运行会触发 SmartScreen「未知发布者」
