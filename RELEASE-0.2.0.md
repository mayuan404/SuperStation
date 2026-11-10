# SuperWorkStation 0.2.0

> 文件 / 笔记 / 终端 / 远程仓库，一个窗口全搞定。

- **体积**：安装包 1.5 MB，解压后 app 约 3 MB
- **要求**：macOS 13+（Apple Silicon / Intel 均可）
- **下载**：`SuperWorkStation-0.2.0.dmg`
- **校验**：
  ```
  shasum -a 256 SuperWorkStation-0.2.0.dmg
  bd1798d5c87e7dc262e60d0c4b4ca758a807e0119b981e76c5f31114795d87f7
  ```

## 安装

1. 打开 DMG，把 `SuperWorkStation.app` 拖进「应用程序」；
2. 首次启动：**右键 → 打开**（应用是 ad-hoc 签名，Gatekeeper 会拦一次）；
   如果仍被拦：
   ```bash
   xattr -dr com.apple.quarantine /Applications/SuperWorkStation.app
   ```
3. 从 0.1.0 升级：直接覆盖即可，配置、会话、主题都存在
   `~/Library/Application Support/SuperWorkStation/` 与 localStorage 里，不会丢。

## 这一版新增

### 菜单栏模式

不占 Dock。`显示 → 菜单栏模式` 打开后，Dock 图标消失，只在菜单栏留一个图标：

- 点图标 → 「打开 SuperWorkStation」把窗口叫回来；
- 「隐藏窗口」收起窗口，进程继续待命；
- 关窗口（红点 / `⌘W`）不再退出应用；
- 「退出菜单栏模式」一键回到普通应用，Dock 图标回来。

适合把工作台当成常驻工具、不想让 Dock 被占满的人。

### 快速命令

按会话复用常用命令的全局命令库（只存名称 + 内容，不存密码）：

- 侧栏「快速命令」里增删改；
- SSH 会话登录后在状态旁出现按钮，点开列出命令名，鼠标或回车即发送到当前会话；
- 也可在命令面板里调用。

### 文本选择按 Mac 习惯来

| 操作 | 行为 |
| --- | --- |
| 双击 | 选中整行（不再是选词） |
| 三击 | 选中整篇 |
| `⌘↑` / `⌘↓` | 以整行为单位跳，落点在本行行尾，而不是下一行行首 |
| `⌘⇧↑` / `⌘⇧↓` | 按整行扩展选区 |
| 预览区双击 | 按屏幕上的视觉行选中整行；三击选整段 |
| 复制 | 编辑区与预览区的 `⌘C` 一律写系统剪贴板 |

### Atom One Dark 主题

原来的「One Dark」改名为 **Atom One Dark**（配色 `#282c34 / #abb2bf / #61afef`，语法色仍是 Atom 那套），
`id` 没变，之前选过这个主题的配置不受影响。

## 这一版修复

| 问题 | 说明 |
| --- | --- |
| 崩溃：文件面板 | 远端面板点「上传文件」时在后台线程创建 `NSOpenPanel`，AppKit 直接 abort |
| 崩溃：PTY | 缓冲区在串行队列外被读写（数据竞争），以及 fd 可能被关闭两次 |
| 崩溃隐患：文件监听 | FSEvents 回调持有已释放对象；`watch()` 跨线程改引用 |
| 数据丢失：密钥文件 | SSH 密码 / AI Key 的读-改-写没有锁，并发保存会互相覆盖 |
| 白屏：HTML 预览 | 目录授权未生效就渲染 iframe，返回 403 且不会重试 |
| 文件树不刷新 | FSEvents 给的是 `/private/tmp`，与根路径 `/tmp` 对不上 |
| 可观测性 | 未捕获的 ObjC 异常现在写入 `~/Library/Logs/SuperWorkStation.log` |

## 已知限制

- **ad-hoc 签名**：没有公证，所以首次打开需要右键 → 打开；企业分发可以自行重签。
- **HTML 预览里的外部资源**：预览 iframe 带 `sandbox`，页面里引用的外部 css/js/图片加载不到；内联 `<style>`、`data:` 图片正常。
- **菜单栏模式**下应用没有自己的主菜单栏（macOS 对后台应用的行为），需要完整菜单时先退出该模式。

## 反馈

发现问题请带上这两样，定位会快很多：

```bash
# 1) 应用日志
tail -50 ~/Library/Logs/SuperWorkStation.log

# 2) 崩溃报告（如果有）
ls -lt ~/Library/Logs/DiagnosticReports | head -5
```
