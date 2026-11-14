# SuperWorkStation 0.4.0 — Windows x64 首发

> 同一个窗口里的文件 / 笔记 / 终端 / 远程仓库，第一次跑在 Windows 上。

- **平台**：Windows 10 1809+ / Windows 11，x64（ARM64 机器通过系统 x64 模拟运行）
- **体积**：zip 约 71 MB，解压约 179 MB；自包含发布，无需安装 .NET
- **下载**：`SuperWorkStation-0.4.0-win-x64.zip`
- **校验**：

  ```
  SHA256: 9e0a1dc0c8c4a182cd5d59dc7e0f23108854a5cc8e70a0340b2c777ec49c6ac9
  ```

- **macOS**：本次未更新，仍为 0.3.1（DMG 见 v0.3.1 发布页）

## 安装

1. 解压整个 zip（不要只拷 exe）；
2. 若提示缺少 WebView2：运行 `scripts\install-webview2.ps1`，或手动安装 x64 版 WebView2 Runtime；
3. 双击 `SuperWorkStation.exe`。

首次运行 SmartScreen 会提示「未知发布者」：更多信息 → 仍要运行。

数据目录：`%APPDATA%\SuperWorkStation`（草稿、保存历史、SSH 密码、AI Key）；
日志：`%LOCALAPPDATA%\SuperWorkStation\logs\SuperWorkStation.log`。

## 已实现（在 Win11 24H2 ARM64 的 x64 模拟环境实测）

| 能力 | 说明 |
| --- | --- |
| 文件 | 文件树、读写、搜索（文件名 + 内容）、保存历史、崩溃草稿、回收站 |
| 编辑 | CodeMirror 6；Markdown 预览、代码高亮、编辑 / 对比 / 预览三态 |
| PDF | 系统 PDF 引擎渲染，多页懒加载与缩放 |
| 加密 | 目录 / 单文件 AES-256-GCM + PBKDF2，与 macOS 格式互通 |
| 终端 | ConPTY 本地终端（PowerShell），多标签、搜索、快速命令 |
| 远程 | SSH 会话（密码 / 私钥）、SFTP 远程工作区、远端 git 状态与拉取推送 |
| 外观 | 与 macOS 同一套主题与图标；⌘ 快捷键自动映射为 Ctrl，窗口按钮自绘 |

## 已知限制

- Office 文档没有缩略图，改用系统默认程序打开
- EPUB 暂不支持内置阅读
- 全局热键（macOS 的 ⌥⌘N）未实现
- 未做代码签名，企业分发建议自备证书签名
- 远端终端连到 Windows 服务端时受 GBK 代码页影响（连 Linux 服务器正常）

## 从源码构建

见 [windows/README.md](windows/README.md)；CI 工作流为 `.github/workflows/windows.yml`。
