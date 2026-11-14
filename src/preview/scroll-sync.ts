// 编辑区 ↔ 预览区 滚动同步（对比模式）。
//
// 预览的顶层块渲染时带 data-line（源文件行号，见 preview.ts 的 bnb_block_lines），
// 这里把「编辑器顶部所在行」和「预览滚动位置」互相换算后双向跟随。
// 只在分栏且两边都可见时生效；程序性写入的那一侧用静音窗口挡住回弹。

import { EditorView } from '@codemirror/view'
import { lineForTop, topForLine, type Anchor } from './sync-math'

export interface ScrollSyncDeps {
  getEditor: () => EditorView | null
  getScroller: () => HTMLElement | null
  isActive: () => boolean
}

/** 程序性滚动后静音多久，防止两侧互相推着抖 */
const MUTE_MS = 90

let deps: ScrollSyncDeps | null = null
let scroller: HTMLElement | null = null
let article: HTMLElement | null = null
let marks: Anchor[] | null = null
let observer: ResizeObserver | null = null
let frame = 0
let mutePreviewUntil = 0
let muteEditorUntil = 0
const boundScroll = new WeakSet<HTMLElement>()

export function initScrollSync(d: ScrollSyncDeps): void {
  deps = d
  bindEditor(d.getEditor())
  window.addEventListener('resize', () => { marks = null })
}

/** 每次预览重建后调用：重新绑定滚动容器、丢掉旧锚点 */
export function refreshScrollSync(): void {
  marks = null
  if (!deps) return

  bindEditor(deps.getEditor())

  const nextScroller = deps.getScroller()
  const nextArticle = nextScroller?.querySelector('.md') as HTMLElement | null
  if (nextScroller !== scroller) {
    scroller?.removeEventListener('scroll', onPreviewScroll)
    scroller = nextScroller
    scroller?.addEventListener('scroll', onPreviewScroll, { passive: true })
  }
  if (nextArticle !== article) {
    observer?.disconnect()
    article = nextArticle
    if (article) {
      observer = new ResizeObserver(() => { marks = null })
      observer.observe(article)
    }
  }
  marks = null
  // 预览刚建出来（还停在第 0 屏）时先对上编辑器位置，避免开文档就错位
  if (scroller && scroller.scrollTop === 0) alignPreviewToEditor()
}

/** 把预览滚到编辑器当前顶部所在的位置 */
export function alignPreviewToEditor(): void {
  if (!deps?.isActive()) return
  const view = deps.getEditor()
  const el = deps.getScroller()
  if (!view || !el) return
  const anchors = anchorsOf(el)
  if (!anchors.length) return
  const max = Math.max(0, el.scrollHeight - el.clientHeight)
  const target = topForLine(anchors, topLineOf(view), max)
  if (Math.abs(target - el.scrollTop) < 2) return
  mutePreviewUntil = performance.now() + MUTE_MS
  el.scrollTop = target
}

/* ---------------- 内部 ---------------- */

function bindEditor(view: EditorView | null): void {
  if (!view) return
  const el = view.scrollDOM
  if (boundScroll.has(el)) return
  boundScroll.add(el)
  el.addEventListener('scroll', onEditorScroll, { passive: true })
}

function onEditorScroll(): void {
  if (!deps?.isActive()) return
  if (performance.now() < muteEditorUntil) return
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const view = deps?.getEditor()
    const el = deps?.getScroller()
    if (!view || !el || !deps?.isActive()) return
    const anchors = anchorsOf(el)
    if (!anchors.length) return
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const target = topForLine(anchors, topLineOf(view), max)
    if (Math.abs(target - el.scrollTop) < 2) return
    mutePreviewUntil = performance.now() + MUTE_MS
    el.scrollTop = target
  })
}

function onPreviewScroll(): void {
  if (!deps?.isActive()) return
  if (performance.now() < mutePreviewUntil) return
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const view = deps?.getEditor()
    const el = deps?.getScroller()
    if (!view || !el || !deps?.isActive()) return
    const anchors = anchorsOf(el)
    if (!anchors.length) return
    scrollEditorToLine(view, lineForTop(anchors, el.scrollTop))
  })
}

/** 编辑器视口顶部对应的文档行（0 起） */
function topLineOf(view: EditorView): number {
  const block = view.lineBlockAtHeight(Math.max(0, view.scrollDOM.scrollTop))
  return view.state.doc.lineAt(block.from).number - 1
}

function scrollEditorToLine(view: EditorView, line: number): void {
  const total = view.state.doc.lines
  const n = Math.min(total, Math.max(1, Math.round(line) + 1))
  const pos = view.state.doc.line(n).from
  const block = view.lineBlockAt(pos)
  if (Math.abs(block.top - view.scrollDOM.scrollTop) < 2) return
  muteEditorUntil = performance.now() + MUTE_MS
  view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start' }) })
}

/** 预览里各顶层块的行号 + 在滚动内容中的纵坐标 */
function anchorsOf(el: HTMLElement): Anchor[] {
  if (marks) return marks
  const root = el.querySelector('.md')
  if (!root) return (marks = [])
  const base = el.getBoundingClientRect().top - el.scrollTop
  marks = Array.from(root.querySelectorAll<HTMLElement>('[data-line]')).map((node) => ({
    line: Number(node.dataset.line) || 0,
    top: node.getBoundingClientRect().top - base,
  }))
  return marks
}
