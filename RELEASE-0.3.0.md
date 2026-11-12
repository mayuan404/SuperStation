# SuperWorkStation 0.3.0

> 文件 / 笔记 / 终端 / 远程仓库，一个窗口全搞定。

- **体积**：安装包 1.8 MB
- **要求**：macOS 13+（Apple Silicon）
- **下载**：`SuperWorkStation-0.3.0.dmg`
- **校验**：
  ```
  shasum -a 256 SuperWorkStation-0.3.0.dmg
  b901086e22d05e1a41c642602e98d3628e99f6add2024f941a5713c44dd8b35b
  ```

## 安装

1. 打开 DMG，把 `SuperWorkStation.app` 拖进「应用程序」；
2. 首次启动：**右键 → 打开**（应用是 ad-hoc 签名，Gatekeeper 会拦一次）；
   如果仍被拦：
   ```bash
   xattr -dr com.apple.quarantine /Applications/SuperWorkStation.app
   ```
3. 从 0.2.0 升级：直接覆盖即可，配置、会话、主题都在
   `~/Library/Application Support/SuperWorkStation/` 与 localStorage 里，不会丢。

## 这一版修掉的三件事

### 「在 Finder 中显示」终于会弹出 Finder

`NSWorkspace.activateFileViewerSelecting` 在 macOS 26/27 上不再把 Finder 带到前台
（实测调用后 frontmost 仍是本应用）。改成走 LaunchServices 的 `open -R`，能稳定调起
并在 Finder 里选中目标；路径已被删除时自动退回它的父目录。

远程条目不再显示这一项——本地根本没有那个文件，点了只会让人怀疑人生。

### 远程 HTML 预览不再白屏

远端文档的 `ssh://<会话>/...` 路径被直接拼进了 `betternotebook://file`，自定义 scheme
只服务本机文件系统，于是被白名单拦成 `SCHEME 403`（日志里能看到这一行），iframe 就是白屏。

现在远端 HTML 用已经读到的正文生成 blob 渲染（CSP 的 `frame-src` 放行 `blob:`），
本地文件仍走自定义 scheme，相对资源照常加载。

### 复制路径：去掉内部前缀，并且给两种形态

远程文件右键复制出来的路径以前是
`ssh://r1794035246251utl/root/dev/.../juzheng.png`——那个前缀只是程序内部用来区分
「哪个 SSH 会话」，对人没有意义。

现在文件树 / 标签页 / 多选右键都给两项：

- **拷贝路径（绝对）** → `/root/dev/rgp/rgp-pentest/reference/juzheng.png`
- **拷贝相对路径** → `reference/juzheng.png`（相对所属工作区根）

多选复制还修了一个隐性 bug：原来用字面量 `\n` 连接，实际粘出来是一行 `\n` 而不是换行。

## 终端：tmux 复制终于能通向 macOS

xterm.js 默认忽略 **OSC 52**——tmux 的 `set-clipboard on`、nvim、fzf 都靠这条序列把内容
写进系统剪贴板，被丢掉之后表现就是「macOS 能粘进 tmux，但 tmux 里选中的东西粘不出来」。

现在终端注册了 OSC 52 处理器：解码 → 写入系统剪贴板 → 轻提示。tmux 里选中即复制，
在别的 app 里直接 `⌘V` 即可。

> 如果 tmux 仍不生效，检查配置里的 `terminal-features`：写 `set -as terminal-features '*:clipboard'`，
> 不要带前导逗号；tmux < 3.2 用 `set -g terminal-overrides ',*:Ms=\E]52;c;%p2%s\7'`。

## 顺带合入：文件树与光标

- 文件树：行高与缩进引导线、chevron 悬停显形、当前文件左缘竖条；
- 键盘导航：↑↓←→ / Enter / Space / Home / End，重绘后保持焦点与滚动位置；
- 排序：目录优先 + 自然序，空目录与读取失败单独成行；
- 光标：网页侧把 `getComputedStyle(el).cursor` 推给原生，由 AppKit 直接设置，
  绕开 WKWebView 某些版本不按 CSS 刷新光标的问题（手形时有时无的根因）。
