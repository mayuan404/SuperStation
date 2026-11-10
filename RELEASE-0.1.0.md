# SuperWorkStation 0.1.0

第一个可用版本：文件 / 笔记 / 终端 / 远程仓库合到一个窗口。

*First usable release: documents, notes, terminal and remote repos in one window.*

## 下载 / Download

- `SuperWorkStation-0.1.0.dmg`（macOS 13+，Apple Silicon / Intel 需各自构建）
- 校验：`shasum -a 256 SuperWorkStation-0.1.0.dmg`

首次打开：**右键 → 打开**；若被 Gatekeeper 拦住：

```bash
xattr -dr com.apple.quarantine /Applications/SuperWorkStation.app
```

## 亮点 / Highlights

- **一个窗口三种形态**：本地文档编辑预览、双栏文件管理、SSH 终端与远程仓库，全部以标签页存在
- **本地 / 远程分区**：左侧导航栏是两个独立 tab，本地的文件夹和 SSH 上的仓库不再挤在同一棵树里
- **远程工作区**：左侧「远程」tab 里挂服务器上的 git 仓库，直接读写；树里显示 `⎇ 分支` 和 M/A/D/?? 标记，右键可 pull / push / commit
- **终端**：多标签、会话保存（分组、颜色、初始目录、密码）、终端内 ⌘F 搜索、8000 行回滚
- **文档**：Markdown / 代码 / 图片 / CSV / HTML / PDF / EPUB / Office，编辑·对比·预览三态
- **AI 助手**（DeepSeek 驱动）：自动附带当前文档，可整体改写或替换选中
- **加密**：目录或单文件 AES-256-GCM，空闲 15 分钟自动锁定
- **外观**：100 套深浅主题 + 4 套文件图标配色，全局字号 14

## 安全 / Security

- Markdown 不执行内联 HTML，页面严格 CSP
- 自定义协议与写操作都受目录白名单限制
- SSH 密码与 AI Key 存在 `~/Library/Application Support/SuperWorkStation/`，权限 0600

## 已知限制 / Known limits

- 远程仓库没有文件监听：切回窗口或切标签会自动刷新一次，精确状态请右键「刷新」
- 远程文档停止输入 3 秒后写回服务器；断网时会在提示条报错
- 未做代码签名与公证（ad-hoc 签名），分发需手动去隔离属性

## 感谢 / Credits

AI 助手由 **DeepSeek** 驱动，整个项目也是用 **DeepSeek Harness** 结对开发的。
