# tmux「选中即复制到系统剪贴板」配置

OneStation 的终端（xterm.js）实现了 OSC 52，所以 tmux 里选中文本可以直接进 macOS 剪贴板。
但它需要 tmux 侧**两个条件同时满足**，缺一个就会「选中有 buffer、剪贴板没反应」。

## tmux 需要的配置

```tmux
set -g mouse on
set -g set-clipboard on
set -as terminal-features 'xterm*:clipboard'
# 关键：显式声明终端支持设置剪贴板。
# tmux 3.6 上只写 terminal-features 时，内部不一定会给终端补上 Ms 能力，
# 结果就是 copy 完只更新 buffer，不向终端发 OSC 52，表现为「选中复制失效」。
set -as terminal-overrides ',xterm*:Ms=\E]52;%p1%s;%p2%s\007'
```

改完执行 `tmux source-file ~/.tmux.conf`，并且**重新 attach 一次**，让 client 用上新能力。

## 怎么确认

1. 在 tmux 里选中一段文字，看 macOS 剪贴板有没有更新；
2. 或者看 OneStation 日志（`~/Library/Logs/SuperWorkStation.log`）：

```
PTY OSC52 len=5608 head=.]52;;...     ← 序列到了 App
OSC52 copied bytes=12                  ← 解析并写入剪贴板成功
```

只有第一行没有第二行 → App 解析/写剪贴板的问题；
两行都没有 → tmux 没发，回到上面的配置检查。

## 直接验证 App 这一侧

在终端里手发一条 OSC 52（不经过 tmux 的选中逻辑）：

```bash
printf '\033]52;c;%s\a' "$(printf hi | base64)"
```

弹出「已复制到系统剪贴板」且日志出现 `OSC52 copied` → App 侧正常。
