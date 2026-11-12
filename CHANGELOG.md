# 更新记录

## 0.3.0

### 新增

- **路径复制两种形态**：文件树 / 标签页 / 多选右键提供「拷贝路径（绝对）」与「拷贝相对路径」；
  远程条目的绝对路径会去掉内部使用的 `ssh://<会话>` 前缀，复制出来就是可直接用的 `/root/...`。
- **终端 OSC 52（tmux 剪贴板）**：tmux 的 `set-clipboard on`、nvim、fzf 等可以把选中内容写入
  macOS 剪贴板——此前只能「粘进去」，现在双向都通。
- **文件树交互**：行高与缩进引导线、chevron 悬停显形、键盘导航（↑↓←→/Enter/Space/Home/End）、
  目录优先 + 自然序排序、空目录与读取失败单独成行。
- **光标接管**：网页侧推送计算出的光标值，由 AppKit 直接设置，绕开 WKWebView 不按 CSS 刷新光标的问题。

### 修复

- **「在 Finder 中显示」点了没反应**：`activateFileViewerSelecting` 在 macOS 26/27 上不再把 Finder
  带到前台，改走 `open -R`（LaunchServices）；路径不存在时自动退回父目录。
- **远端 HTML 预览白屏**：远端文档的 `ssh://` 路径被拼进 `betternotebook://file`，被白名单拦成
  403（日志里的 `SCHEME 403`）。远端改用已读到的正文渲染 blob，CSP 补上 `blob:`。
- 多选复制路径时用字面量 `\n` 连接，得到的是一行里的 `\n` 而不是换行。
- 远程条目不再显示无意义的「在 Finder 中显示」。

## 0.2.0

### 新增

- **菜单栏模式**：`显示 → 菜单栏模式`，开启后不占 Dock，只留菜单栏图标；
  关窗口不退出进程，点图标随时打开，可一键切回普通模式。
- **快速命令**：侧栏「快速命令」入口，SSH 会话里一键发送常用命令。
- **文本选择**：编辑器双击选整行、三击选全文；`⌘↑/⌘↓` 以整行为单位跳转（落点在本行行尾）；
  预览区双击选整行、三击选段；预览里的复制统一写系统剪贴板。
- **Atom One Dark 主题**（原 One Dark 更名，配色不变）。

### 修复

- 崩溃：`ui.pickFiles` 在后台线程创建 `NSOpenPanel` 导致 abort。
- 崩溃隐患：PTY 缓冲区数据竞争、fd 双重关闭、会话表无锁。
- 崩溃隐患：FileWatcher 在回调里持有已释放对象、`watch()` 跨线程改引用。
- FATAL：密钥文件（SSH 密码 / AI key）并发读改写会丢数据，已加锁。
- HTML 预览偶发白屏：`allowRoot` 未等待生效就渲染 iframe，导致 403。
- 文件监听拿不到变更：FSEvents 给的 `/private/tmp` 与根路径 `/tmp` 对不上。
- 未捕获 ObjC 异常现在会写进 `~/Library/Logs/SuperWorkStation.log`。

### 测试

- 新增 e2e：`select.js`（文本选择）、`remote-panels.js`（远端面板）。
- 全套 61 项检查通过。

## 0.1.0

首个版本：文件树 / 编辑器 / Markdown 预览 / 终端 / SSH / 加密目录。
