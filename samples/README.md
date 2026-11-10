# BetterNoteBook 演示文档

这是一个用来验证 **Markdown 渲染** 的示例文件，支持 *斜体*、**粗体**、`行内代码` 和 [链接](https://example.com)。

## 列表与引用

- 轻量：原生外壳 + 系统 WebView，安装包 1.5 MB
- 美观：九套主题，可随时切换
- 全能：Markdown、图片、CSV、HTML、PDF 直接预览

> 设计目标：像 Sublime 一样快，像 VS Code 一样好用，像 Obsidian 一样好看。

## 代码高亮

```python
def greet(name: str) -> str:
    """打招呼"""
    return f"你好，{name}！"

print(greet("BetterNoteBook"))
```

```javascript
const themes = ['daylight', 'nord', 'gruvbox'];
themes.forEach((t) => console.log(`theme: ${t}`));
```

## 表格

| 需求 | 方案 | 状态 |
| --- | --- | --- |
| 轻型 | Swift + WKWebView | ✅ |
| 界面优美 | 9 套主题 | ✅ |
| 树形导航 | 侧边栏文件树 | ✅ |
| 本地渲染 | md / 图片 / csv / html | ✅ |
| 加密 | AES-256-GCM | ✅ |

## 图片

![演示图](assets/sample.png)

---

1. 第一步：打开文件夹
2. 第二步：⌘P 快速跳转
3. 第三步：⌘K 打开命令面板
