// 文档区域里的「文本选择 + 复制」体验。
//
// 这里处理的是「双击 / 三击」这类在普通网页里由浏览器默认实现的选区操作，
// 但在编辑器（CodeMirror）里有偏差、在 iframe（HTML 预览）里又完全没接管，
// 所以统一在应用层按操作系统习惯自己算选区：
//   - 双击：取光标所在「行」（逻辑行，不是排版上的折行）整行文本
//   - 三击：选项连续段落
//   - 选中后 ⌘C / ⌘X：把整行原样写进剪贴板（不带行号、不补换行）

import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'

function textNodes(node: Node): globalThis.Text[] {
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
  const out: globalThis.Text[] = []
  let t = walker.nextNode() as globalThis.Text | null
  while (t) { out.push(t); t = walker.nextNode() as Text | null }
  return out
}

/** 把「按文本偏移」的选区落到真实 DOM（用 createRange + 二分） */
function rangeFromCharOffsets(root: Node, start: number, end: number): Range | null {
  const nodes = textNodes(root)
  if (!nodes.length) return null
  const starts: number[] = []
  let acc = 0
  for (const n of nodes) { starts.push(acc); acc += n.data.length }
  const locate = (i: number) => {
    // 找最后一个 start <= i 的文本节点
    let lo = 0, hi = nodes.length - 1, idx = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (starts[mid] <= i) { idx = mid; lo = mid + 1 } else hi = mid - 1
    }
    return { node: nodes[idx], offset: Math.max(0, Math.min(nodes[idx].data.length, i - starts[idx])) }
  }
  const a = locate(start)
  const b = locate(end)
  const r = document.createRange()
  try {
    r.setStart(a.node, a.offset)
    r.setEnd(b.node, b.offset)
  } catch { return null }
  return r
}

/** 把视口坐标转成 root 内的文本偏移；找不到返回 -1 */
function charOffsetAt(root: HTMLElement, x: number, y: number): number {
  let caret: { node: Node; offset: number } | null = null
  const doc = document as any
  if (doc.caretRangeFromPoint) {
    const r = doc.caretRangeFromPoint(x, y)
    if (r && root.contains(r.startContainer)) caret = { node: r.startContainer, offset: r.startOffset }
  } else if (doc.caretPositionFromPoint) {
    const p = doc.caretPositionFromPoint(x, y)
    if (p && root.contains(p.offsetNode)) caret = { node: p.offsetNode, offset: p.offset }
  }
  if (!caret) return -1
  const nodes = textNodes(root)
  let acc = 0
  for (const n of nodes) {
    if (n === caret.node) return acc + caret.offset
    acc += n.data.length
  }
  return -1
}

/** 起始处的「行」：以它前面最近的换行（或容器开头）作为行首 */
function lineStartOf(chars: string, pos: number): number {
  let i = pos
  while (i > 0 && chars[i - 1] !== '\n') i--
  return i
}

/** 行尾：下一个换行符（不含换行本身） */
function lineEndOf(chars: string, pos: number): number {
  let i = pos
  while (i < chars.length && chars[i] !== '\n') i++
  return i
}

function paragraphRange(chars: string, pos: number): [number, number] {
  let start = lineStartOf(chars, pos)
  let end = lineEndOf(chars, pos)
  // 段落 = 被空行隔开的一段（和浏览器的段落双击/三击习惯接近）
  const isBlank = (a: number, b: number) => chars.slice(a, b).trim() === ''
  while (start > 0) {
    const prevEnd = start - 1
    const prevStart = lineStartOf(chars, prevEnd)
    if (isBlank(prevStart, prevEnd)) break
    start = prevStart
  }
  while (end < chars.length) {
    const nextStart = end + 1
    if (nextStart > chars.length) break
    const nextEnd = lineEndOf(chars, nextStart)
    if (isBlank(nextStart, nextEnd)) break
    end = nextEnd
  }
  return [start, end]
}

function applyRange(root: HTMLElement, start: number, end: number): boolean {
  const r = rangeFromCharOffsets(root, start, end)
  if (!r) return false
  const sel = window.getSelection()
  if (!sel) return false
  sel.removeAllRanges()
  sel.addRange(r)
  ;(root as any).__lineRange = { start, end }
  root.classList.add('text-selected')
  return true
}

/* ---------------- 剪贴板 ---------------- */

let bridgeCopy: ((text: string) => void) | null = null

/** main.ts 启动时注入原生剪贴板实现（比 navigator.clipboard 稳，不依赖权限） */
export function setClipboardWriter(fn: (text: string) => void): void {
  bridgeCopy = fn
}

export function writeClipboard(text: string): Promise<void> {
  if (bridgeCopy) {
    bridgeCopy(text)
    return Promise.resolve()
  }
  return navigator.clipboard?.writeText(text).catch(() => {}) ?? Promise.resolve()
}

/* ---------------- 复制 / 剪切拦截 ---------------- */

function selectionText(): string {
  return window.getSelection()?.toString() ?? ''
}

/* ---------------- 静态文本区域（预览） ---------------- */

/**
 * 给一块「只读文本」装上行级选择：
 * 双击选整行、三击选段落，并阻止默认的「双击选词」。
 */
export function installLineSelection(root: HTMLElement, opts: { skip?: string } = {}): void {
  const skipSel = opts.skip ?? 'a, pre, code, table, .line-hl, img, svg, input, textarea'

  root.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    const target = ev.target as HTMLElement
    if (!target || target.closest(skipSel)) return
    if (!(ev.detail >= 2)) return
    const chars = root.textContent ?? ''
    const pos = charOffsetAt(root, ev.clientX, ev.clientY)
    if (pos < 0) return
    const [start, end] = ev.detail >= 3
      ? paragraphRange(chars, pos)
      : [lineStartOf(chars, pos), lineEndOf(chars, pos)]
    ev.preventDefault()
    applyRange(root, start, end)
  }, true)

  // 选区离开这块区域时取消行级标记
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.anchorNode || !root.contains(sel.anchorNode)) {
      root.classList.remove('text-selected')
      ;(root as any).__lineRange = undefined
    }
  })

  installCopyToNative(root)
}

/** 清掉行级选区（切文档、重新渲染前调用） */
export function clearLineSelection(root: HTMLElement): void {
  root.classList.remove('text-selected')
  ;(root as any).__lineRange = undefined
}

/**
 * 让一块区域里的 ⌘C / ⌘X 直接写入系统剪贴板。
 * WKWebView 里 `getSelection()` 有内容时，浏览器原生的复制偶尔不可靠
 * （应用内没有 Select All 菜单处理链），这里统一兜底。
 */
export function installCopyToNative(root: HTMLElement, onCut?: (text: string) => void): void {
  root.addEventListener('copy', (ev) => {
    const text = window.getSelection()?.toString() ?? ''
    if (!text) return
    ev.preventDefault()
    ev.stopPropagation()
    writeClipboard(text)
  }, true)
  root.addEventListener('cut', (ev) => {
    const text = window.getSelection()?.toString() ?? ''
    if (!text || !onCut) return
    ev.preventDefault()
    ev.stopPropagation()
    writeClipboard(text)
    onCut(text)
  }, true)
}
