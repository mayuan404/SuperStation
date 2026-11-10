import { invoke, onEvent } from '../lib/bridge'
import { el, clear } from '../lib/dom'
import { icon } from '../lib/icons'
import type { Doc, Settings } from '../lib/store'

export interface AIMessage {
  role: 'user' | 'assistant'
  content: string
  done?: boolean
  error?: string
}

export interface AIDeps {
  getDoc: () => Doc | null
  getContextText: (doc: Doc) => Promise<string>
  getOtherDocs: () => Doc[]
  copy: (text: string, msg?: string) => void
  getSelection: () => string
  onReplace: (text: string) => void
  onInsert: (text: string) => void
  getSettings: () => Settings
  openSettings: () => void
}

const SYSTEM = [
  '你是 SuperWorkStation 的笔记助手。回答简洁、直接，用中文。',
  '当用户要求修改文本时，只输出修改后的文本本身：不要解释、不要加引号、不要用代码块包裹。',
  '当用户只是提问或分析时，正常回答，可以分点。'
].join('')

export class AIPanel {
  readonly el: HTMLElement
  private list: HTMLElement
  private input: HTMLTextAreaElement
  private sendBtn: HTMLElement
  private stopBtn: HTMLElement
  private meta: HTMLElement
  private history = new Map<string, AIMessage[]>()
  private streaming = false
  private streamId = ''
  private deps: AIDeps

  constructor(deps: AIDeps) {
    this.deps = deps
    this.list = el('div', { class: 'ai-messages' })
    this.input = el('textarea', { class: 'ai-input', placeholder: '问点什么…  ⏎ 发送，⇧⏎ 换行', rows: '1' }) as HTMLTextAreaElement
    this.meta = el('span', { class: 'ai-model' }, '')
    this.sendBtn = el('button', { class: 'ai-send', title: '发送 ⏎' })
    this.sendBtn.append(icon('chevron'))
    this.stopBtn = el('button', { class: 'ai-stop', title: '停止' })
    this.stopBtn.append(icon('close'))
    this.stopBtn.style.display = 'none'

    const close = el('button', { class: 'ai-close', title: '关闭 ⌘⇧A' })
    close.append(icon('close'))
    close.addEventListener('click', () => this.hide())

    const head = el('div', { class: 'ai-head' },
      el('span', { class: 'ai-title' }, 'AI 助手'),
      this.meta,
      el('div', { class: 'spacer' }),
      close
    )

    const chips = el('div', { class: 'ai-chips' })
    for (const [label, prompt] of [
      ['总结', '总结这篇笔记的要点，用简短的分点列出。'],
      ['改进表达', '把选中的内容改写得更清晰、更简洁，只输出改写后的文本。'],
      ['翻译', '把选中的内容翻译成英文，只输出译文。'],
      ['大纲', '为这篇笔记生成一个层级大纲。'],
      ['解释', '解释选中的内容或代码，用简单的语言。']
    ] as const) {
      const b = el('button', { class: 'ai-chip' }, label)
      b.addEventListener('click', () => this.ask(prompt))
      chips.append(b)
    }

    const inputRow = el('div', { class: 'ai-inputbar' }, this.input, this.sendBtn, this.stopBtn)
    this.el = el('aside', { class: 'ai-panel', style: { display: 'none' } }, head, this.list, chips, inputRow)

    this.sendBtn.addEventListener('click', () => this.submit())
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); this.submit() }
    })
    this.input.addEventListener('input', () => this.autosize())

    onEvent('ai.delta', (p: { id: string; text: string }) => {
      if (p.id !== this.streamId) return
      const last = this.current()[this.current().length - 1]
      if (!last || last.role !== 'assistant') return
      last.content += p.text
      this.paintStreaming()
    })
    onEvent('ai.done', (p: { id: string; text: string; cancelled?: boolean }) => {
      if (p.id !== this.streamId) return
      const last = this.current()[this.current().length - 1]
      if (last) { last.content = p.text || last.content; last.done = true }
      this.finish()
    })
    onEvent('ai.error', (p: { id: string; message: string }) => {
      if (p.id !== this.streamId) return
      const last = this.current()[this.current().length - 1]
      if (last) { last.error = p.message; last.done = true }
      this.finish()
    })
  }

  private current(): AIMessage[] {
    const doc = this.deps.getDoc()
    const key = doc?.id ?? '__none__'
    if (!this.history.has(key)) this.history.set(key, [])
    return this.history.get(key)!
  }

  visible(): boolean { return this.el.style.display !== 'none' }

  show(): void {
    this.el.style.display = 'flex'
    this.refreshMeta()
    this.render()
    setTimeout(() => this.input.focus(), 30)
  }

  hide(): void { this.el.style.display = 'none' }

  toggle(): void { this.visible() ? this.hide() : this.show() }

  refreshMeta(): void {
    const s = this.deps.getSettings()
    this.meta.textContent = s.aiModel || 'deepseek-chat'
  }

  /** 文档切换/内容变化时调用 */
  sync(): void {
    if (!this.visible()) return
    this.refreshMeta()
    this.render()
  }

  private autosize(): void {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(140, this.input.scrollHeight)}px`
  }

  private submit(): void {
    const text = this.input.value.trim()
    if (!text || this.streaming) return
    this.input.value = ''
    this.autosize()
    this.ask(text)
  }

  private async ask(userText: string): Promise<void> {
    const s = this.deps.getSettings()
    const hasKey = await invoke<boolean>('ai.hasKey').catch(() => false)
    if (!hasKey) {
      this.current().push({ role: 'assistant', content: '还没有配置 API Key。点下面的「设置」填一个即可（密钥存在系统钥匙串里）。', done: true, error: 'nokey' })
      this.render()
      return
    }

    const doc = this.deps.getDoc()
    const selection = this.deps.getSelection()
    const msgs = this.current()
    msgs.push({ role: 'user', content: userText })
    msgs.push({ role: 'assistant', content: '', done: false })
    this.render()

    const sys: string[] = [SYSTEM]
    if (doc) {
      const raw = await this.deps.getContextText(doc)
      if (raw) {
        const text = raw.length > 24000 ? raw.slice(0, 24000) + '\n…（已截断）' : raw
        sys.push(`当前文档《${doc.name}》的内容：\n"""\n${text}\n"""`)
      } else {
        sys.push(`当前文档《${doc.name}》没有可提取的文本（可能是图片型 PDF 或二进制文件）。`)
      }
      // 如果提问里点名了另一个打开的标签，就把那份也带上
      const named = this.deps.getOtherDocs().filter((d) => d.name && userText.includes(d.name)).slice(0, 2)
      for (const other of named) {
        const t = await this.deps.getContextText(other)
        if (t) sys.push(`用户另外提到并打开的文档《${other.name}》内容：\n"""\n${t.slice(0, 12000)}\n"""`)
      }
    }
    if (selection) sys.push(`用户当前选中的片段：\n"""\n${selection}\n"""`)

    const historyMsgs = msgs.slice(-11, -2).map((m) => ({ role: m.role, content: m.content }))
    const payload = [
      { role: 'system', content: sys.join('\n\n') },
      ...historyMsgs,
      { role: 'user', content: userText }
    ]

    try {
      const res = await invoke<{ id?: string; error?: string }>('ai.chat', {
        baseURL: s.aiBaseUrl || 'https://api.deepseek.com',
        model: s.aiModel || 'deepseek-chat',
        messages: payload,
        temperature: 0.7
      })
      if (res?.error) {
        const last = msgs[msgs.length - 1]
        last.error = res.error
        last.done = true
        this.render()
        return
      }
      this.streamId = res.id ?? ''
      this.streaming = true
      this.stopBtn.style.display = 'grid'
      this.sendBtn.style.display = 'none'
    } catch (err: any) {
      const last = msgs[msgs.length - 1]
      last.error = String(err?.message ?? err)
      last.done = true
      this.render()
    }
  }

  private finish(): void {
    this.streaming = false
    this.streamId = ''
    this.stopBtn.style.display = 'none'
    this.sendBtn.style.display = 'grid'
    this.render()
  }

  private paintStreaming(): void {
    const node = this.list.lastElementChild as HTMLElement | null
    if (!node) { this.render(); return }
    const body = node.querySelector('.ai-text') as HTMLElement | null
    const msgs = this.current()
    if (body) body.textContent = msgs[msgs.length - 1]?.content ?? ''
    this.list.scrollTop = this.list.scrollHeight
  }

  private render(): void {
    const msgs = this.current()
    clear(this.list)
    if (!msgs.length) {
      const hint = el('div', { class: 'ai-empty' })
      hint.append(el('div', { class: 'ai-empty-title' }, '可以这样问'))
      hint.append(el('div', { class: 'ai-empty-item' }, '· 总结这篇笔记的三个要点'))
      hint.append(el('div', { class: 'ai-empty-item' }, '· 把选中的段落改得更简洁'))
      hint.append(el('div', { class: 'ai-empty-item' }, '· 根据内容生成一份提纲'))
      hint.append(el('div', { class: 'ai-empty-tip' }, '提问时会自动带上当前笔记内容'))
      this.list.append(hint)
      return
    }
    for (const m of msgs) {
      const row = el('div', { class: `ai-msg ${m.role}` })
      const who = el('div', { class: 'ai-who' }, m.role === 'user' ? '你' : 'AI')
      const body = el('div', { class: 'ai-text' })
      body.textContent = m.content || (m.done ? '' : '…')
      row.append(who, body)
      if (m.error && m.error === 'nokey') {
        const b = el('button', { class: 'ai-apply' }, '打开设置')
        b.addEventListener('click', () => this.deps.openSettings())
        row.append(b)
      } else if (m.error) {
        row.append(el('div', { class: 'ai-error' }, m.error))
      } else if (m.role === 'assistant' && m.done && m.content) {
        const bar = el('div', { class: 'ai-apply-bar' })
        const mk = (label: string, fn: () => void) => {
          const b = el('button', { class: 'ai-apply' }, label)
          b.addEventListener('click', fn)
          return b
        }
        bar.append(
          mk('替换选中', () => this.deps.onReplace(m.content)),
          mk('插入到光标', () => this.deps.onInsert(m.content)),
          mk('复制', () => this.deps.copy(m.content, '已复制'))
        )
        row.append(bar)
      }
      this.list.append(row)
    }
    this.list.scrollTop = this.list.scrollHeight
  }
}
