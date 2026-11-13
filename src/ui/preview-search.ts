import { el, debounce } from '../lib/dom'
import { icon } from '../lib/icons'

/**
 * 预览态搜索：直接在渲染后的预览 DOM 里找文本，不把用户切回 split。
 * 只改 DOM 的 mark，不动文档内容；关闭时恢复原节点。
 */
export class PreviewSearch {
  private pane: HTMLElement
  private bar: HTMLElement
  private input: HTMLInputElement
  private count: HTMLElement
  private prevBtn: HTMLButtonElement
  private nextBtn: HTMLButtonElement
  private content: HTMLElement | null = null
  private marks: HTMLElement[] = []
  private active = -1
  private opened = false

  constructor(pane: HTMLElement) {
    this.pane = pane
    this.input = el('input', {
      class: 'ps-input',
      type: 'text',
      placeholder: '在预览中搜索…',
      spellcheck: 'false'
    }) as HTMLInputElement
    this.count = el('span', { class: 'ps-count' }, '')
    const mk = (ic: string, title: string, fn: () => void) => {
      const b = el('button', { class: 'ps-btn', title, type: 'button' })
      b.append(icon(ic))
      b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); fn() })
      return b as HTMLButtonElement
    }
    this.prevBtn = mk('chevron', '上一个（⇧Enter）', () => this.step(-1))
    this.prevBtn.style.transform = 'rotate(180deg)'
    this.nextBtn = mk('chevron', '下一个（Enter）', () => this.step(1))
    const close = mk('close', '关闭（Esc）', () => this.close())
    this.bar = el('div', { class: 'preview-search' },
      icon('search'), this.input, this.count, this.prevBtn, this.nextBtn, close)
    this.bar.addEventListener('mousedown', (ev) => ev.stopPropagation())
    this.input.addEventListener('input', debounce(() => this.run(), 90))
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); this.step(ev.shiftKey ? -1 : 1) }
      else if (ev.key === 'Escape') { ev.preventDefault(); this.close() }
      ev.stopPropagation()
    })
    pane.append(this.bar)
  }

  get isOpen(): boolean { return this.opened }

  open(content: HTMLElement): void {
    this.content = content
    this.opened = true
    this.bar.classList.add('open')
    this.input.focus()
    this.input.select()
    if (this.input.value.trim()) this.run()
    else this.updateCount()
  }

  close(): void {
    this.opened = false
    this.bar.classList.remove('open')
    this.clearMarks()
    this.content = null
  }

  /** 预览重绘后重新套用当前关键词 */
  refresh(): void {
    if (!this.opened) return
    this.run()
  }

  private root(): HTMLElement | null {
    if (!this.content) return null
    return (this.content.querySelector('.preview-scroll') as HTMLElement | null) ?? this.content
  }

  private clearMarks(): void {
    for (const m of this.marks) {
      const parent = m.parentNode
      if (!parent) continue
      parent.replaceChild(document.createTextNode(m.textContent ?? ''), m)
      parent.normalize()
    }
    this.marks = []
    this.active = -1
    this.updateCount()
  }

  private run(): void {
    if (!this.opened) return
    this.clearMarks()
    const root = this.root()
    const query = this.input.value.trim()
    if (!root || !query) { this.updateCount(); return }

    const needle = query.toLocaleLowerCase()
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        const text = node.nodeValue ?? ''
        if (!text || !text.trim()) return NodeFilter.FILTER_REJECT
        const p = (node as Text).parentElement
        if (!p || p.closest('script, style, .preview-search, mark.preview-hit')) return NodeFilter.FILTER_REJECT
        return NodeFilter.FILTER_ACCEPT
      }
    })
    const ranges: Range[] = []
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text
      const hay = (textNode.nodeValue ?? '').toLocaleLowerCase()
      let from = 0
      while (from < hay.length) {
        const idx = hay.indexOf(needle, from)
        if (idx < 0) break
        const range = document.createRange()
        range.setStart(textNode, idx)
        range.setEnd(textNode, idx + needle.length)
        ranges.push(range)
        from = idx + needle.length
        if (ranges.length >= 500) break
      }
      if (ranges.length >= 500) break
    }

    const fresh: HTMLElement[] = []
    // 从后往前包，前面的 range 不会因为 DOM 结构变化而失效
    for (let i = ranges.length - 1; i >= 0; i--) {
      const mark = document.createElement('mark')
      mark.className = 'preview-hit'
      try {
        ranges[i].surroundContents(mark)
        fresh.push(mark)
      } catch {}
    }
    this.marks = fresh.reverse()
    if (this.marks.length) this.select(0)
    else this.updateCount()
  }

  private step(delta: number): void {
    if (!this.marks.length) return
    const next = (this.active + delta + this.marks.length) % this.marks.length
    this.select(next)
  }

  private select(idx: number): void {
    if (!this.marks.length) return
    this.marks[this.active]?.classList.remove('active')
    this.active = Math.max(0, Math.min(this.marks.length - 1, idx))
    const m = this.marks[this.active]
    m.classList.add('active')
    m.scrollIntoView({ block: 'center', inline: 'nearest' })
    this.updateCount()
  }

  private updateCount(): void {
    const total = this.marks.length
    this.count.textContent = total ? `${this.active + 1}/${total}` : '0/0'
    this.prevBtn.disabled = !total
    this.nextBtn.disabled = !total
  }
}
