import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import '@xterm/xterm/css/xterm.css'
import { invoke } from '../lib/bridge'
import { defaultShell, isWindows } from '../lib/platform'
import { el } from '../lib/dom'
import { icon } from '../lib/icons'
import { closeQuickCommandPicker, openQuickCommandManager, openQuickCommandPicker } from './quickcmd'

export interface TermProfile {
  id: string
  name: string
  kind: 'local' | 'ssh'
  host?: string
  port?: number
  user?: string
  cwd?: string
  group?: string
  color?: string
  /** 是否已在原生端保存密码（密码本身不进设置） */
  hasPassword?: boolean
  remotePath?: string
}

export interface TermDeps {
  onExit: (id: string, code: number) => void
  onBrowseRemote?: (p: TermProfile) => void
  toast: (msg: string, ms?: number) => void
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** 粗略判断主题底色，决定终端搜索命中用亮黄还是深黄（xterm decoration 只能设背景色）。 */
function isDarkColor(color: string): boolean {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return false
  const n = parseInt(m[1], 16)
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5
}

function searchDecorations() {
  const dark = isDarkColor(cssVar('--bg', '#ffffff'))
  return dark
    ? {
        matchBackground: '#7A5D00',
        matchBorder: '#FFD84D',
        matchOverviewRuler: '#FFD84D',
        activeMatchBackground: '#B8860B',
        activeMatchBorder: '#FFE066',
        activeMatchColorOverviewRuler: '#FFE066'
      }
    : {
        matchBackground: '#FFE066',
        matchBorder: '#D4A400',
        matchOverviewRuler: '#D4A400',
        activeMatchBackground: '#FFB300',
        activeMatchBorder: '#B87400',
        activeMatchColorOverviewRuler: '#FFB300'
      }
}

function b64(bytes: Uint8Array): string {
  let s = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(s)
}

export class TermSession {
  readonly el: HTMLElement
  readonly docId: string
  readonly profile: TermProfile
  private term: Terminal
  private fit: FitAddon
  private search: SearchAddon
  searchBar!: HTMLElement
  private searchInput!: HTMLInputElement
  ptyId = ''
  private deps: TermDeps
  private disposed = false
  private started = false
  private opened = false
  private connected = false
  private probe = ''
  private statusEl!: HTMLElement
  private body!: HTMLElement
  private quickBtn: HTMLButtonElement | null = null
  private retryBtn: HTMLButtonElement | null = null
  private live = false

  constructor(docId: string, profile: TermProfile, deps: TermDeps) {
    this.docId = docId
    this.profile = profile
    this.deps = deps

    const bg = cssVar('--bg', '#ffffff')
    const fg = cssVar('--fg', '#1d1d1f')
    const accent = cssVar('--accent', '#3b82f6')
    const sel = cssVar('--accent-soft', 'rgba(59,130,246,.25)')

    this.term = new Terminal({
      fontFamily: '"SF Mono", Menlo, Monaco, "PingFang SC", monospace',
      fontSize: Number(cssVar('--editor-font-size', '14px').replace('px', '')) || 14,
      lineHeight: 1.25,
      scrollback: 8000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: bg,
        foreground: fg,
        cursor: accent,
        selectionBackground: sel,
        black: '#1c1c1e',
        brightBlack: '#6b6b70'
      }
    })
    this.fit = new FitAddon()
    this.term.loadAddon(this.fit)
    this.search = new SearchAddon()
    this.term.loadAddon(this.search)

    // OSC 52：让远端程序（tmux 的 set-clipboard、nvim、fzf 等）把文本写进系统剪贴板。
    // xterm.js 默认忽略这条序列，所以 tmux 里「选中即复制到开发机剪贴板」一直不生效，
    // 只有反向（macOS → tmux）能通——因为那是浏览器原生粘贴。这里补上正向通道。
    this.term.parser.registerOscHandler(52, (data: string) => {
      try {
        const rest = data.startsWith('52;') ? data.slice(3) : data
        const sep = rest.indexOf(';')
        if (sep < 0) return true
        const payload = rest.slice(sep + 1)
        if (!payload || payload === '?') return true
        const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
        const text = new TextDecoder().decode(bytes)
        if (!text) return true
        invoke('ui.copy', { text }).catch(() => {})
        this.deps.toast('已复制到系统剪贴板', 1200)
        return true
      } catch {
        return true
      }
    })

    const dot = el('span', { class: 'term-dot' })
    if (profile.color) dot.style.background = profile.color
    const meta = profile.kind === 'ssh'
      ? `${profile.user || 'root'}@${profile.host}${profile.port && profile.port !== 22 ? ':' + profile.port : ''}`
      : '本地会话'
    this.statusEl = el('span', { class: 'term-status' }, profile.kind === 'ssh' ? '连接中…' : '就绪')
    if (profile.kind === 'ssh') this.statusEl.classList.add('pending')
    const head = el('div', { class: 'term-head' },
      dot,
      el('span', { class: 'term-name' }, profile.name),
      el('span', { class: 'term-meta' }, meta),
      el('span', { class: 'spacer' }),
      this.statusEl
    )
    if (profile.kind === 'ssh') {
      // 登录上之后才有意义，所以先置灰；收到远端的第一个字节就亮起来
      const quick = el('button', { class: 'term-quick-btn', title: '快速命令：选一条直接发到当前会话' }) as HTMLButtonElement
      quick.append(icon('command'), el('span', {}, '快速命令'))
      quick.disabled = true
      quick.hidden = true
      quick.addEventListener('click', () => this.showQuickCommands())
      this.quickBtn = quick
      head.append(quick)
      const filesBtn = el('button', { class: 'term-file-btn', title: '浏览这台机器的文件' }, '文件')
      filesBtn.addEventListener('click', () => deps.onBrowseRemote?.(profile))
      head.append(filesBtn)
      const retry = el('button', { class: 'term-file-btn', title: '重新连接这个 SSH 会话' }, '重连') as HTMLButtonElement
      retry.hidden = true
      retry.addEventListener('click', () => { retry.hidden = true; this.restart(true).catch(() => {}) })
      this.retryBtn = retry
      head.append(retry)
    }
    // 终端内搜索
    this.searchInput = el('input', { class: 'term-search-input', placeholder: '在终端里搜索…', spellcheck: 'false' }) as HTMLInputElement
    const prev = el('button', { class: 'term-search-btn' }, '↑')
    const next = el('button', { class: 'term-search-btn' }, '↓')
    const close = el('button', { class: 'term-search-btn' }, '×')
    this.searchBar = el('div', { class: 'term-search' }, this.searchInput, prev, next, close)
    this.searchBar.style.display = 'none'
    this.searchInput.addEventListener('input', () => this.search.findNext(this.searchInput.value, { incremental: true, decorations: searchDecorations() }))
    this.searchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.shiftKey ? this.search.findPrevious(this.searchInput.value, { decorations: searchDecorations() }) : this.search.findNext(this.searchInput.value, { decorations: searchDecorations() }) }
      if (ev.key === 'Escape') this.hideSearch()
    })
    prev.addEventListener('click', () => this.search.findPrevious(this.searchInput.value, { decorations: searchDecorations() }))
    next.addEventListener('click', () => this.search.findNext(this.searchInput.value, { decorations: searchDecorations() }))
    close.addEventListener('click', () => this.hideSearch())
    head.append(this.searchBar)

    this.body = el('div', { class: 'term-host' })
    this.el = el('div', { class: 'term-wrap' }, head, this.body)

    this.term.onData((d) => {
      if (!this.ptyId) return
      invoke('pty.write', { id: this.ptyId, data: b64(new TextEncoder().encode(d)) }).catch(() => {})
    })
    this.term.onResize(({ cols, rows }) => {
      if (!this.ptyId) return
      invoke('pty.resize', { id: this.ptyId, cols, rows }).catch(() => {})
    })
  }

  mount(): void {
    if (this.disposed) return
    if (!this.opened) {
      this.opened = true
      this.term.open(this.body)
    }
    requestAnimationFrame(() => {
      this.refit()
      if (!this.started) { this.started = true; void this.start() }
    })
  }

  usedSecret = false
  retried = false

  restarted = false

  /** 会话结束后回落到本地 shell */
  async fallbackToLocal(): Promise<void> {
    this.restarted = true
    this.connected = false
    this.probe = ''
    this.setLive(false)
    this.statusEl.textContent = '本地终端'
    this.statusEl.classList.remove('pending', 'ok', 'bad')
    this.term.write('\r\n\x1b[2m[会话已结束，已切换为本地终端]\x1b[0m\r\n')
    await this.start(false, true)
  }

  async restart(useSecret: boolean): Promise<void> {
    this.retried = true
    this.connected = false
    this.probe = ''
    this.setLive(false)
    if (this.retryBtn) this.retryBtn.hidden = true
    this.statusEl.textContent = '等待密码输入'
    this.statusEl.classList.remove('pending', 'ok', 'bad')
    await this.start(useSecret)
  }

  private async start(useSecret = true, forceLocal = false): Promise<void> {
    this.term.write('\x1b[2m正在启动…\x1b[0m\r\n')
    const p = this.profile
    const win = isWindows()
    const args: string[] = []
    let program = win ? defaultShell() : '/bin/zsh'
    let kind: 'local' | 'ssh' = 'local'
    let sshParams: Record<string, any> = {}
    if (p.kind === 'ssh' && !forceLocal) {
      if (win && useSecret && p.hasPassword) {
        // Windows 的系统 ssh 不支持 askpass：保存过密码的会话交给原生 SSH 客户端
        program = 'ssh-pty'
        kind = 'ssh'
        sshParams = {
          host: p.host,
          port: p.port ?? 22,
          user: p.user || 'root',
          secretId: p.id,
          remotePath: p.remotePath
        }
      } else {
        program = win ? 'ssh' : '/usr/bin/ssh'
        args.push('-o', 'ServerAliveInterval=30', '-o', 'StrictHostKeyChecking=accept-new')
        if (p.port && p.port !== 22) args.push('-p', String(p.port))
        const dest = `${p.user || 'root'}@${p.host}`
        if (p.remotePath) {
          // 远端 shell 里先 cd 再起登录 shell，失败就留在 home
          const q = "'" + p.remotePath.replace(/'/g, "'\\''") + "'"
          args.push('-t', dest, `cd ${q} 2>/dev/null; exec "\${SHELL:-/bin/bash}" -l`)
        } else {
          args.push(dest)
        }
      }
    } else if (!win) {
      args.push('-l')
    }
    const env: Record<string, string> = {}
    this.usedSecret = false
    if (p.kind === 'ssh' && useSecret && p.hasPassword) {
      this.usedSecret = true
      if (!win) env['__secretId'] = p.id
    }
    try {
      const res = await invoke<{ id: string }>('pty.open', {
        program,
        args,
        kind,
        ...sshParams,
        env,
        cwd: p.cwd || undefined,
        cols: this.term.cols,
        rows: this.term.rows
      })
      this.ptyId = res.id
      this.term.reset()
      // 建会话时可能还没量到真实尺寸，这里再对齐一次，否则 vim 只画一小块
      this.refit()
      invoke('pty.resize', { id: this.ptyId, cols: this.term.cols, rows: this.term.rows }).catch(() => {})
    } catch (err: any) {
      this.term.write(`\r\n\x1b[31m无法启动终端：${err?.message ?? err}\x1b[0m\r\n`)
    }
  }

  private setLive(v: boolean): void {
    this.live = v
    if (!this.quickBtn) return
    this.quickBtn.disabled = !v
    this.quickBtn.hidden = !v
    if (!v) closeQuickCommandPicker()
  }

  /** 快速命令：直接写进 pty，行尾补一个回车 */
  sendCommand(text: string): void {
    if (!this.ptyId) { this.deps.toast('会话还没准备好'); return }
    const body = text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
    invoke('pty.write', { id: this.ptyId, data: b64(new TextEncoder().encode(body + '\n')) }).catch(() => {})
    this.focus()
  }

  private showQuickCommands(): void {
    if (!this.quickBtn) return
    openQuickCommandPicker({
      anchor: this.quickBtn,
      onPick: (cmd) => this.sendCommand(cmd.content),
      onManage: () => openQuickCommandManager(),
      onClose: () => this.focus()
    })
  }

  write(bytes: Uint8Array): void {
    if (this.profile.kind === 'ssh' && !this.live && bytes.length) this.setLive(true)
    if (!this.connected && this.profile.kind === 'ssh') {
      this.probe += new TextDecoder().decode(bytes)
      if (this.probe.length > 4000) this.probe = this.probe.slice(-2000)
      if (/permission denied|connection refused|could not resolve|timed out|no route to host|host key verification failed/i.test(this.probe)) {
        this.connected = true
        this.statusEl.textContent = '连接失败'
        this.statusEl.classList.remove('pending')
        this.statusEl.classList.add('bad')
      } else if (/password:\s*$|last login|[$#]\s$/i.test(this.probe)) {
        this.connected = true
        this.statusEl.textContent = '已连接'
        this.statusEl.classList.remove('pending')
        this.statusEl.classList.add('ok')
      }
    }
    this.term.write(bytes)
  }

  showSearch(): void {
    this.searchBar.style.display = 'flex'
    this.searchInput.focus()
    this.searchInput.select()
  }

  hideSearch(): void {
    this.searchBar.style.display = 'none'
    this.search.clearDecorations()
    this.term.clearSelection()
    this.term.focus()
  }

  markExited(code: number): void {
    this.setLive(false)
    this.statusEl.textContent = code === 0 ? '已结束' : `已断开 (${code})`
    this.statusEl.classList.remove('pending', 'ok')
    this.statusEl.classList.add('bad')
  }

  /** SSH 连接失败：保留会话并显示重连，不再悄悄变成本地终端。 */
  markConnectionFailed(code: number): void {
    this.connected = false
    this.setLive(false)
    this.statusEl.textContent = '连接失败'
    this.statusEl.classList.remove('pending', 'ok')
    this.statusEl.classList.add('bad')
    if (this.retryBtn) this.retryBtn.hidden = false
    this.term.write(`\r\n\x1b[31m[SSH 连接失败，退出码 ${code}。检查网络/VPN 后点「重连」]\x1b[0m\r\n`)
  }

  refit(): void {
    try { this.fit.fit() } catch {}
  }

  focus(): void { this.term.focus() }

  dispose(): void {
    this.disposed = true
    if (this.ptyId) invoke('pty.close', { id: this.ptyId }).catch(() => {})
    this.term.dispose()
    this.el.remove()
  }
}
