// 平台差异：快捷键、路径习惯、文案。macOS 用 ⌘，Windows 用 Ctrl。

// 先用 UA 兜底：即使 app.info 失败，Windows 的 Ctrl 映射也不会丢
let windows = /Windows/i.test(navigator.userAgent)
let homeDir = ''
let defaultShellPath = '/bin/zsh'

export function initPlatform(info: { platform?: string; home?: string; defaultShell?: string }): void {
  windows = info.platform === 'windows'
  homeDir = info.home || ''
  defaultShellPath = info.defaultShell || (windows ? 'powershell.exe' : '/bin/zsh')
  if (!windows) return
  document.documentElement.classList.add('platform-windows')
  localizeShortcutLabels()
}

export const isWindows = (): boolean => windows
export const homePath = (): string => homeDir
export const defaultShell = (): string => defaultShellPath
export const revealLabel = (): string => (windows ? '在资源管理器中显示' : '在 Finder 中显示')

/** 主快捷键：mac 是 ⌘，Windows 是 Ctrl。 */
export function primary(ev: KeyboardEvent): boolean {
  return windows ? ev.ctrlKey && !ev.altKey && !ev.metaKey : ev.metaKey && !ev.ctrlKey
}

/** 多选：mac 是 ⌘+点击，Windows 是 Ctrl+点击。 */
export function multiSelect(ev: MouseEvent): boolean {
  return windows ? ev.ctrlKey : ev.metaKey
}

// ---------- 把界面里的 ⌘ 文案换成 Ctrl ----------

const ATTRS = ['title', 'placeholder', 'aria-label']
const TEXT_HOST = 'kbd, .sheet-row, .menu, .menu-item, .tab-hint, button, .hint, .sub, .statusbar, .palette-row, .empty, .sheet-hint'

function convert(text: string): string {
  if (!/[⌘⌃⌥⇧]/.test(text)) return text
  return text
    .replace(/⌘\/Ctrl/g, 'Ctrl')
    .replace(/[⌘⌃⌥⇧]+/g, (run) => {
      const parts: string[] = []
      if (run.includes('⌘') && run.includes('⌃')) parts.push('Ctrl', 'Alt')
      else if (run.includes('⌘') || run.includes('⌃')) parts.push('Ctrl')
      if (run.includes('⇧')) parts.push('Shift')
      if (run.includes('⌥')) parts.push('Alt')
      return parts.join('+') + '+'
    })
}

function applyTo(root: ParentNode): void {
  if (root instanceof Element || root instanceof Document) {
    const scope = root instanceof Document ? root.documentElement : root
    scope.querySelectorAll?.('[title], [placeholder], [aria-label]').forEach((el) => {
      for (const attr of ATTRS) {
        const value = el.getAttribute(attr)
        if (!value) continue
        const next = convert(value)
        if (next !== value) el.setAttribute(attr, next)
      }
    })
  }

  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = (node as Text).parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      if (parent.closest('pre, code, textarea, input, .cm-editor, .cm-content')) return NodeFilter.FILTER_REJECT
      if (!parent.closest(TEXT_HOST)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    const next = convert(node.nodeValue || '')
    if (next !== node.nodeValue) node.nodeValue = next
  }
}

function localizeShortcutLabels(): void {
  const start = () => {
    applyTo(document)
    let queued = false
    const observer = new MutationObserver((mutations) => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        for (const m of mutations) {
          if (m.type === 'childList') {
            for (const node of Array.from(m.addedNodes)) {
              if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) applyTo(node as Node as ParentNode)
            }
          } else if (m.type === 'characterData' && m.target.parentElement) {
            const parent = m.target.parentElement
            if (parent.closest(TEXT_HOST) && !parent.closest('pre, code, textarea, input, .cm-editor, .cm-content')) {
              const next = convert((m.target as Text).nodeValue || '')
              if (next !== (m.target as Text).nodeValue) (m.target as Text).nodeValue = next
            }
          }
        }
      })
    })
    observer.observe(document.body, { childList: true, subtree: true, characterData: true })
  }

  if (document.body) start()
  else window.addEventListener('DOMContentLoaded', start, { once: true })
}
