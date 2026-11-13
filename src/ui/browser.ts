import { invoke } from '../lib/bridge'
import { el, clear } from '../lib/dom'
import { dirname, humanSize, relativeTime } from '../lib/files'
import { fileIcon, icon, iconColor } from '../lib/icons'

export interface BEntry {
  name: string
  displayName: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  ext: string
  hidden: boolean
  encrypted: boolean
  vault: boolean
}

export interface BrowserDeps {
  openFile: (path: string, name?: string) => void
  openFolderDialog: () => Promise<string | null>
  moveTo: (src: string, destDir: string) => Promise<void>
  copyTo: (src: string, destDir: string) => Promise<void>
  trash: (path: string) => Promise<void>
  rename: (path: string) => Promise<void>
  newFolder: (dir: string) => Promise<void>
  reveal: (path: string) => void
  quickLook: (path: string) => void
  toast: (msg: string, ms?: number) => void
  menu: (x: number, y: number, items: any[]) => void
  prompt: (opts: any) => Promise<string | null>
  confirm: (title: string, msg: string, danger?: boolean) => Promise<boolean>
  onClose: () => void
}

const CLIP = { key: '__bnbBrowserClip' }

class BrowserPane {
  readonly el: HTMLElement
  private deps: BrowserDeps
  private pathBar: HTMLInputElement
  private filterInput: HTMLInputElement
  private list: HTMLElement
  private status: HTMLElement
  private sortBtn: HTMLElement
  private active = false

  path = ''
  entries: BEntry[] = []
  sel = new Set<string>()
  private anchor = -1
  private history: string[] = []
  private histIndex = -1
  private sort: 'name' | 'size' | 'mtime' = 'name'
  private asc = true
  private showHidden = false
  private filter = ''
  onActivate: () => void = () => {}
  onClose: () => void = () => {}

  constructor(deps: BrowserDeps) {
    this.deps = deps
    this.pathBar = el('input', { class: 'browser-path', spellcheck: 'false' }) as HTMLInputElement
    this.filterInput = el('input', { class: 'browser-filter', placeholder: '过滤…', spellcheck: 'false' }) as HTMLInputElement
    this.list = el('div', { class: 'browser-list', tabIndex: 0 }) as HTMLElement
    this.status = el('div', { class: 'browser-status' })

    const mk = (ic: string, title: string, fn: () => void) => {
      const b = el('button', { class: 'browser-btn', title })
      b.append(icon(ic))
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn() })
      return b
    }
    const btnBack = mk('chevron', '后退', () => this.go(-1))
    btnBack.style.transform = 'rotate(180deg)'
    const btnFwd = mk('chevron', '前进', () => this.go(1))
    btnFwd.style.transform = 'rotate(180deg)'
    btnFwd.style.transform = 'rotate(180deg)'
    const btnUp = mk('arrow-left', '上一级', () => this.navigate(dirname(this.path || '/'), true))
    btnUp.style.transform = 'rotate(90deg)'
    this.sortBtn = mk('refresh', '切换排序', () => this.cycleSort())

    const bar = el('div', { class: 'browser-bar' },
      btnBack, btnFwd, btnUp, this.pathBar,
      mk('folder-open', '选择文件夹…', async () => {
        const p = await this.deps.openFolderDialog()
        if (p) this.navigate(p, true)
      }),
      mk('close', '关闭这一栏', () => this.onClose())
    )

    const hiddenBtn = el('button', { class: 'browser-btn', title: '显示隐藏文件' })
    hiddenBtn.append(icon('eye'))
    hiddenBtn.addEventListener('click', () => {
      this.showHidden = !this.showHidden
      hiddenBtn.classList.toggle('active', this.showHidden)
      this.render()
    })
    const tools = el('div', { class: 'browser-tools' }, this.filterInput, this.sortBtn, hiddenBtn)

    this.el = el('div', { class: 'browser-pane' }, bar, tools, this.list, this.status)

    this.el.addEventListener('mousedown', () => this.onActivate())
    this.pathBar.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { this.navigate(this.pathBar.value.trim(), true); (ev.target as HTMLElement).blur() }
      if (ev.key === 'Escape') this.pathBar.value = this.path
    })
    this.filterInput.addEventListener('input', () => { this.filter = this.filterInput.value; this.render() })
    this.list.addEventListener('keydown', (ev) => this.onKey(ev))
    this.list.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer?.types.includes('application/x-bnb-path')) return
      ev.preventDefault()
      this.list.classList.add('drop-hover')
    })
    this.list.addEventListener('dragleave', () => this.list.classList.remove('drop-hover'))
    this.list.addEventListener('drop', async (ev) => {
      this.list.classList.remove('drop-hover')
      const src = ev.dataTransfer?.getData('application/x-bnb-path')
      if (!src) return
      ev.preventDefault()
      ev.stopPropagation()
      if (this.path === dirname(src)) return
      if (ev.altKey) await this.deps.copyTo(src, this.path)
      else await this.deps.moveTo(src, this.path)
      await this.reload()
    })
  }

  setActive(v: boolean): void {
    this.active = v
    this.el.classList.toggle('active', v)
  }

  async navigate(path: string, push = true): Promise<void> {
    if (!path) return
    path = path.replace(/\/+$/, '') || '/'
    if (push) {
      this.history = this.history.slice(0, this.histIndex + 1)
      this.history.push(path)
      this.histIndex = this.history.length - 1
    }
    await this.load(path)
  }

  private async go(delta: number): Promise<void> {
    const next = this.histIndex + delta
    if (next < 0 || next >= this.history.length) return
    this.histIndex = next
    await this.load(this.history[next])
  }

  private async load(path: string): Promise<void> {
    // 用户主动浏览过的目录视为授权，白名单才不会挡住建/删/改名
    invoke('app.allowRoot', { path }).catch(() => {})
    this.pathBar.value = path
    this.list.innerHTML = '<div class="browser-empty">读取中…</div>'
    try {
      this.entries = await invoke<BEntry[]>('fs.list', { path })
      this.path = path
      this.sel.clear()
      this.anchor = -1
      try { localStorage.setItem('bnb.browser.path', path) } catch {}
      this.render()
    } catch (err: any) {
      this.entries = []
      this.path = path
      this.render(String(err?.message ?? '无法读取目录'))
    }
  }

  async reload(): Promise<void> { await this.load(this.path) }

  private visibleEntries(): BEntry[] {
    const f = this.filter.toLowerCase()
    const list = this.entries.filter((e) => (this.showHidden || !e.hidden) && (!f || e.name.toLowerCase().includes(f)))
    const dir = this.asc ? 1 : -1
    return list.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      if (this.sort === 'size') return (a.size - b.size) * dir
      if (this.sort === 'mtime') return (a.mtime - b.mtime) * dir
      return a.name.localeCompare(b.name, 'zh') * dir
    })
  }

  private cycleSort(): void {
    if (this.asc) { this.asc = false }
    else { this.asc = true; this.sort = this.sort === 'name' ? 'mtime' : this.sort === 'mtime' ? 'size' : 'name' }
    const label = this.sort === 'name' ? '名称' : this.sort === 'mtime' ? '时间' : '大小'
    this.sortBtn.title = `${label} ${this.asc ? '升序' : '降序'}`
    this.render()
  }

  private render(error?: string): void {
    clear(this.list)
    if (error) {
      this.list.append(el('div', { class: 'browser-empty' }, error))
      this.status.textContent = ''
      return
    }
    const list = this.visibleEntries()
    if (!list.length) this.list.append(el('div', { class: 'browser-empty' }, this.filter ? '没有匹配项' : '空目录'))
    list.forEach((e, i) => {
      const row = el('div', {
        class: 'browser-row' + (this.sel.has(e.path) ? ' selected' : ''),
        draggable: 'true',
        title: e.path,
        dataset: { path: e.path }
      })
      const nameCell = el('div', { class: 'b-name' })
      const ic = el('span', { class: 'b-ic' })
      if (e.isDir) ic.append(icon('folder'))
      else {
        ic.append(fileIcon(e.ext))
        const c = iconColor(e.ext)
        if (c) ic.style.color = c
      }
      nameCell.append(ic, el('span', { class: 'b-text' }, e.displayName))
      if (e.vault) nameCell.append(icon('lock'))
      row.append(nameCell,
        el('div', { class: 'b-size' }, e.isDir ? '—' : humanSize(e.size)),
        el('div', { class: 'b-time' }, relativeTime(e.mtime)))

      row.addEventListener('click', (ev) => { this.onActivate(); this.onRowClick(e, i, ev) })
      row.addEventListener('dblclick', () => this.openEntry(e))
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        this.onActivate()
        if (!this.sel.has(e.path)) { this.sel = new Set([e.path]); this.anchor = i; this.render() }
        this.menu(ev)
      })
      row.addEventListener('dragstart', (ev) => {
        if (!this.sel.has(e.path)) { this.sel = new Set([e.path]); this.anchor = i; this.render() }
        ev.dataTransfer?.setData('application/x-bnb-path', e.path)
        ev.dataTransfer?.setData('text/plain', e.path)
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'copyMove'
      })
      this.list.append(row)
    })
    const selSize = this.entries.filter((e) => this.sel.has(e.path) && !e.isDir).reduce((n, e) => n + e.size, 0)
    this.status.textContent = this.sel.size
      ? `${list.length} 项 · 已选 ${this.sel.size} 个${selSize ? ' · ' + humanSize(selSize) : ''}`
      : `${list.length} 项`
  }

  private onRowClick(e: BEntry, i: number, ev: MouseEvent): void {
    if (ev.shiftKey && this.anchor >= 0) {
      const list = this.visibleEntries()
      const [a, b] = [Math.min(this.anchor, i), Math.max(this.anchor, i)]
      for (let k = a; k <= b; k++) this.sel.add(list[k].path)
    } else if (ev.metaKey) {
      if (this.sel.has(e.path)) this.sel.delete(e.path)
      else this.sel.add(e.path)
      this.anchor = i
    } else {
      this.sel = new Set([e.path])
      this.anchor = i
    }
    this.render()
    this.list.focus()
  }

  private openEntry(e: BEntry): void {
    if (e.isDir) { this.navigate(e.path, true); return }
    this.deps.openFile(e.path, e.displayName)
  }

  selectedEntries(): BEntry[] {
    return this.visibleEntries().filter((e) => this.sel.has(e.path))
  }

  private onKey(ev: KeyboardEvent): void {
    const list = this.visibleEntries()
    const cur = list.findIndex((e) => this.sel.has(e.path))
    if (ev.metaKey || ev.ctrlKey) {
      const k = ev.key.toLowerCase()
      const take = (fn: () => void) => { ev.preventDefault(); ev.stopPropagation(); fn() }
      if (k === '[') return take(() => this.go(-1))
      if (k === ']') return take(() => this.go(1))
      if (k === 'arrowup') return take(() => this.navigate(dirname(this.path || '/'), true))
      if (k === 'l') return take(() => { this.pathBar.focus(); this.pathBar.select() })
      if (k === 'r') return take(() => { void this.reload() })
      if (k === 'c' && this.selectedEntries().length) return take(() => this.toClipboard('copy'))
      if (k === 'x' && this.selectedEntries().length) return take(() => this.toClipboard('move'))
      if (k === 'v') return take(() => { void this.pasteHere({ isDir: true, path: this.path } as BEntry) })
      if (k === 'backspace') return take(() => { void this.trashSelection() })
      if (k === 'n' && ev.shiftKey) return take(() => { void this.deps.newFolder(this.path).then(() => this.reload()) })
      if (k === 'a') {
        ev.preventDefault()
        this.sel = new Set(list.map((e) => e.path))
        this.render()
        return
      }
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      const i = ev.key === 'ArrowDown' ? Math.min(list.length - 1, cur + 1) : Math.max(0, cur - 1)
      if (list[i]) {
        this.sel = new Set([list[i].path])
        this.anchor = i
        this.render()
        ;(this.list.children[i] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
      }
    } else if (ev.key === 'Enter') {
      ev.preventDefault()
      const e = this.selectedEntries()[0]
      if (e) this.openEntry(e)
    } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
      ev.preventDefault()
      void this.trashSelection()
    } else if (ev.key === ' ') {
      ev.preventDefault()
      const e = this.selectedEntries()[0]
      if (e) this.deps.quickLook(e.path)
    } else if (ev.key === 'F2') {
      ev.preventDefault()
      const e = this.selectedEntries()[0]
      if (e) this.deps.rename(e.path).then(() => this.reload())
    } else if ((ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault()
      this.sel = new Set(list.map((e) => e.path))
      this.render()
    }
  }

  private async trashSelection(): Promise<void> {
    const items = this.selectedEntries()
    if (!items.length) return
    for (const e of items) await this.deps.trash(e.path)
    await this.reload()
  }

  private menu(ev: MouseEvent): void {
    const items = this.selectedEntries()
    const one = items[0]
    const multi = items.length > 1
    const out: any[] = []

    if (multi) {
      out.push({ label: `批量重命名 ${items.length} 项…`, icon: 'pencil', onClick: () => this.batchRename(items) })
      out.push({ sep: true })
      out.push({ label: `移到废纸篓（${items.length}）`, icon: 'trash', danger: true, onClick: () => this.trashSelection() })
      this.deps.menu(ev.clientX, ev.clientY, out)
      return
    }
    if (!one) return

    if (one.isDir) {
      out.push({ label: '进入', icon: 'folder-open', onClick: () => this.navigate(one.path, true) })
      out.push({ label: '新建文件夹', icon: 'folder-plus', onClick: () => this.deps.newFolder(this.path).then(() => this.reload()) })
      out.push({ label: '计算大小…', icon: 'table', onClick: () => this.measure(one.path) })
      out.push({ sep: true })
    } else {
      out.push({ label: '用 SuperWorkStation 打开', icon: 'file', onClick: () => this.deps.openFile(one.path, one.displayName) })
      out.push({ label: '快速查看', icon: 'eye', onClick: () => this.deps.quickLook(one.path) })
      out.push({ sep: true })
    }
    out.push({ label: '拷贝', icon: 'copy', onClick: () => this.toClipboard('copy') })
    out.push({ label: '剪切', icon: 'cut', onClick: () => this.toClipboard('move') })
    out.push({ label: '粘贴到此处', icon: 'paste', onClick: () => this.pasteHere(one) })
    out.push({ sep: true })
    out.push({ label: '重命名…', icon: 'pencil', onClick: () => this.deps.rename(one.path).then(() => this.reload()) })
    out.push({ label: '移到废纸篓', icon: 'trash', danger: true, onClick: () => this.trashSelection() })
    out.push({ sep: true })
    out.push({ label: '在 Finder 中显示', icon: 'external', onClick: () => this.deps.reveal(one.path) })
    out.push({ label: '拷贝路径', icon: 'file', onClick: () => invoke('ui.copy', { text: one.path }).then(() => this.deps.toast('已拷贝路径')) })
    this.deps.menu(ev.clientX, ev.clientY, out)
  }

  private async measure(path: string): Promise<void> {
    this.deps.toast('正在统计…', 1500)
    const r = await invoke<{ size: number }>('fs.size', { path }).catch(() => null)
    this.deps.toast(r ? `占用 ${humanSize(r.size)}` : '统计失败', 3000)
  }

  private toClipboard(mode: 'copy' | 'move'): void {
    const items = this.selectedEntries()
    ;(window as any)[CLIP.key] = { mode, paths: items.map((e) => e.path) }
    this.deps.toast(mode === 'copy' ? `已拷贝 ${items.length} 项` : `已剪切 ${items.length} 项`)
  }

  private async pasteHere(target: BEntry): Promise<void> {
    const clip = (window as any)[CLIP.key]
    if (!clip) { this.deps.toast('剪贴板为空'); return }
    const dir = target.isDir ? target.path : this.path
    for (const p of clip.paths) {
      if (clip.mode === 'copy') await this.deps.copyTo(p, dir)
      else await this.deps.moveTo(p, dir)
    }
    ;(window as any)[CLIP.key] = null
    await this.reload()
  }

  private async batchRename(items: BEntry[]): Promise<void> {
    const tpl = await this.deps.prompt({
      title: `批量重命名 ${items.length} 项`,
      label: '模板（{n} 为序号，{name} 为原名）',
      value: '{name}',
      note: '保留原扩展名，例如「旅行-{n}」会得到 旅行-1.jpg、旅行-2.jpg'
    })
    if (!tpl) return
    let i = 1
    for (const e of items) {
      const dot = e.name.lastIndexOf('.')
      const ext = e.isDir || dot <= 0 ? '' : e.name.slice(dot)
      const base = e.isDir || dot <= 0 ? e.name : e.name.slice(0, dot)
      const next = tpl.replace(/\{n\}/g, String(i)).replace(/\{name\}/g, base)
      const target = `${dirname(e.path)}/${next}${ext}`
      if (target !== e.path) await invoke('fs.rename', { from: e.path, to: target }).catch(() => {})
      i++
    }
    this.deps.toast(`已重命名 ${items.length} 项`)
    await this.reload()
  }
}

export class FileBrowser {
  readonly el: HTMLElement
  private deps: BrowserDeps
  private host: HTMLElement
  private panes: BrowserPane[] = []
  private active: BrowserPane | null = null
  private side: HTMLElement
  private quickBuilt = false
  private lastFocusRefresh = 0

  constructor(deps: BrowserDeps) {
    this.deps = deps
    this.host = el('div', { class: 'browser-split' })
    const segSingle = el('button', { class: 'seg-btn active', title: '单栏  ⌘\\' })
    segSingle.append(icon('sidebar'), el('span', {}, '单栏'))
    const segDual = el('button', { class: 'seg-btn', title: '双栏  ⌘\\' })
    segDual.append(icon('split'), el('span', {}, '双栏'))
    segSingle.addEventListener('click', () => { this.setLayout(1); this.syncSeg(segSingle, segDual) })
    segDual.addEventListener('click', () => { this.setLayout(2); this.syncSeg(segSingle, segDual) })
    this.seg = { single: segSingle, dual: segDual }

    const closeBtn = el('button', { class: 'browser-btn', title: '关闭文件浏览  Esc' })
    closeBtn.append(icon('close'))
    closeBtn.addEventListener('click', () => deps.onClose())
    const bar = el('div', { class: 'browser-head' },
      el('div', { class: 'browser-seg' }, segSingle, segDual),
      el('div', { class: 'spacer' }), closeBtn)
    this.side = el('div', { class: 'finder-side' })
    this.el = el('div', { class: 'browser' }, bar, el('div', { class: 'finder-body' }, this.side, this.host))
    this.buildQuick()
    this.addPane()
    window.addEventListener('focus', () => {
      if (!this.visible()) return
      const now = Date.now()
      if (now - this.lastFocusRefresh < 1500) return
      this.lastFocusRefresh = now
      void this.refreshAll()
    })
  }

  /** FinderIsShit 风格的位置侧栏：常用目录 / 磁盘 */
  private async buildQuick(): Promise<void> {
    if (this.quickBuilt) return
    this.quickBuilt = true
    let home = ''
    try { home = (await invoke<{ home: string }>('app.info')).home || '' } catch {}
    if (!home) return
    const groups: Array<[string, Array<[string, string]>]> = [
      ['个人', [
        ['个人目录', home],
        ['桌面', `${home}/Desktop`],
        ['文稿', `${home}/Documents`],
        ['下载', `${home}/Downloads`],
        ['图片', `${home}/Pictures`],
        ['工作目录', `${home}/up`]
      ]],
      ['位置', [
        ['整个磁盘', '/'],
        ['应用程序', '/Applications'],
        ['用户', '/Users']
      ]]
    ]
    for (const [title, items] of groups) {
      const rows: HTMLElement[] = []
      for (const [name, path] of items) {
        const ok = await invoke('fs.exists', { path }).catch(() => false)
        if (!ok) continue
        const row = el('div', { class: 'finder-quick', title: path },
          icon('folder'), el('span', { class: 'finder-quick-name' }, name))
        row.addEventListener('click', () => {
          const p = this.active ?? this.panes[0]
          if (p) p.navigate(path, true)
        })
        rows.push(row)
      }
      if (!rows.length) continue
      this.side.append(el('div', { class: 'finder-side-title' }, title), ...rows)
    }
  }

  private addPane(path?: string): BrowserPane {
    const p = new BrowserPane(this.deps)
    p.onActivate = () => { this.active = p; for (const q of this.panes) q.setActive(q === p) }
    p.onClose = () => this.removePane(p)
    this.panes.push(p)
    this.host.append(p.el)
    this.active = p
    p.setActive(true)
    if (path) p.navigate(path, true)
    return p
  }

  private removePane(p: BrowserPane): void {
    if (this.panes.length <= 1) { this.deps.toast('至少保留一栏'); return }
    p.el.remove()
    this.panes = this.panes.filter((x) => x !== p)
    this.active = this.panes[0]
    this.active.setActive(true)
  }

  private seg: { single: HTMLElement; dual: HTMLElement } | null = null

  private syncSeg(single: HTMLElement, dual: HTMLElement): void {
    single.classList.toggle('active', this.panes.length === 1)
    dual.classList.toggle('active', this.panes.length > 1)
  }

  /** 切换单栏 / 双栏 */
  setLayout(count: 1 | 2): void {
    if (count === 2 && this.panes.length === 1) {
      this.addPane(this.active?.path || '/')
    } else if (count === 1 && this.panes.length > 1) {
      for (const p of this.panes.slice(1)) { p.el.remove() }
      this.panes = this.panes.slice(0, 1)
      this.active = this.panes[0]
      this.active.setActive(true)
    }
    if (this.seg) this.syncSeg(this.seg.single, this.seg.dual)
  }

  toggleLayout(): void {
    this.setLayout(this.panes.length > 1 ? 1 : 2)
  }

  visible(): boolean { return this.el.style.display !== 'none' }

  currentDir(): string {
    return this.active?.path || ''
  }

  show(path?: string): void {
    this.el.style.display = 'flex'
    if (!this.panes.length) this.addPane()
    const p = this.active ?? this.panes[0]
    if (path) p.navigate(path, true)
    else if (!p.path) p.navigate(localStorage.getItem('bnb.browser.path') || '/Users', true)
    setTimeout(() => p.el.querySelector('.browser-list')?.setAttribute('tabindex', '0'), 30)
  }

  hide(): void { this.el.style.display = 'none' }

  async refreshAll(): Promise<void> {
    for (const p of this.panes) await p.reload()
  }
}
