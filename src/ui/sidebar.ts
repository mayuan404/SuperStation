import { invoke } from '../lib/bridge'
import { multiSelect } from '../lib/platform'
import { el, clear } from '../lib/dom'
import type { RemoteRoot } from '../lib/store'
import { fileIcon, icon, iconColor } from '../lib/icons'
import { basename } from '../lib/files'
import { state, saveSettings } from '../lib/store'

export interface Entry {
  name: string
  displayName: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  encrypted: boolean
  ext: string
  hidden: boolean
  vault: boolean
  inVault?: boolean
  vaultRoot?: string
  isRoot?: boolean
}

export interface SidebarActions {
  open(entry: Entry): void
  newFile(dir: string): void
  newFolder(dir: string): void
  rename(entry: Entry): void
  remove(entry: Entry): void
  reveal(entry: Entry): void
  encrypt(dir: string): void
  lockVault(dir: string): void
  openVault(entry: Entry): void
  contextMenu(entry: Entry, ev: MouseEvent): void
  moveTo(src: string, destDir: string): void
  moveInto(src: string, destDir: string): void
  removeRemoteRoot(path: string): void
  multiMenu(paths: string[], ev: MouseEvent): void
  copyInto(src: string, destDir: string): void
  openFolder(): void
  openBrowser(): void
  openTerminal(ev: MouseEvent): void
  openQuickCommands(): void
  addRemoteRoot(): void
  remoteRootMenu(path: string, ev: MouseEvent): void
  openSettings(): void
  removeRoot(root: string): void
  rootMenu(root: string, ev: MouseEvent): void
}

export type SidebarTab = 'local' | 'remote'

export class Sidebar {
  readonly root: HTMLElement
  private list: HTMLElement
  private localPane!: HTMLElement
  private remotePane!: HTMLElement
  private foot!: HTMLElement
  private tabButtons = new Map<SidebarTab, HTMLButtonElement>()
  private tabCounts = new Map<SidebarTab, HTMLElement>()
  /** 本地 / 远程是两个独立分区，同一时间只显示一个 */
  private tab: SidebarTab
  private actions: SidebarActions | null = null
  private cache = new Map<string, Entry[]>()
  /** 读取失败的目录，用来画一行错误提示而不是静默当空目录 */
  private failedDirs = new Set<string>()
  /** 路径 → 条目，键盘回车时要用完整 Entry 去打开 */
  private byPath = new Map<string, Entry>()
  private remoteStatus = new Map<string, string>()
  private remoteBranch = new Map<string, string>()
  private entrySig = new Map<string, string>()
  private renderedTabs = new Set<SidebarTab>()
  private dirty = false
  private multi = new Set<string>()
  private selAnchor = ''
  private selPane: HTMLElement | null = null
  private forceNext = false
  private remoteBusy = false

  /** 某一分区里当前可见（已展开）的目录 */
  private visibleDirs(tab: SidebarTab): string[] {
    const roots = tab === 'local'
      ? state.roots
      : (state.remoteRoots ?? []).map((r) => remoteRootPath(r))
    const out: string[] = []
    for (const root of roots) {
      out.push(root)
      for (const p of state.expanded) {
        if (p !== root && p.startsWith(root + '/')) out.push(p)
      }
    }
    return out
  }
  private token = 0
  private drag: {
    path: string
    name: string
    startX: number
    startY: number
    ghost?: HTMLElement
    target?: HTMLElement
    active: boolean
  } | null = null
  private suppressClickUntil = 0

  constructor() {
    this.tab = state.settings.treeTab === 'remote' ? 'remote' : 'local'
    this.localPane = el('div', { class: 'tree-pane local' })
    this.remotePane = el('div', { class: 'tree-pane remote' })
    this.list = el('div', { class: 'tree' }, this.localPane, this.remotePane)
    this.list.tabIndex = 0
    this.list.setAttribute('role', 'tree')
    this.list.addEventListener('keydown', (ev) => this.onTreeKey(ev))
    this.foot = el('div', { class: 'sidebar-foot' })
    this.root = el('aside', { class: 'sidebar' }, this.buildHead(), this.list, this.foot)
    this.applyTab()
    this.syncHead()
    this.renderFoot()
    this.wireDrag()
  }

  private buildHead(): HTMLElement {
    const head = el('div', { class: 'sidebar-head' })
    const tabs = el('div', { class: 'side-tabs', role: 'tablist' })
    const spec: Array<[SidebarTab, string, string, string]> = [
      ['local', '本地', 'folder', '本地工作区'],
      ['remote', '远程', 'external', '远程工作区（SSH）']
    ]
    for (const [id, label, ic, title] of spec) {
      const count = el('span', { class: 'cnt' })
      const btn = el('button', { class: 'side-tab', role: 'tab', title })
      btn.append(icon(ic), el('span', { class: 'lbl' }, label), count)
      btn.addEventListener('click', () => this.showTab(id))
      this.tabButtons.set(id, btn)
      this.tabCounts.set(id, count)
      tabs.append(btn)
    }
    head.append(tabs, el('div', { class: 'spacer' }))
    const term = el('button', { title: '终端 / SSH 会话' })
    term.append(icon('terminal'))
    term.addEventListener('click', (ev) => this.actions?.openTerminal(ev))
    // 快速命令紧挨着终端，点开就能新增 / 编辑 / 删除
    const quick = el('button', { title: '快速命令（全局，SSH 会话里一键发送）' })
    quick.append(icon('command'))
    quick.addEventListener('click', () => this.actions?.openQuickCommands())
    // FinderIsShit 风格的文件管理入口：复用内建双栏文件浏览器
    const finder = el('button', { title: '磁盘 / 文件管理（双栏、剪切、批量重命名）' })
    finder.append(icon('disk'))
    finder.addEventListener('click', () => this.actions?.openBrowser())
    head.append(term, quick, finder)
    return head
  }

  /** 切换本地 / 远程分区；两个分区各自独立，不混在一个树里 */
  showTab(tab: SidebarTab): void {
    if (this.tab === tab) return
    this.tab = tab
    state.settings.treeTab = tab
    saveSettings()
    this.applyTab()
    this.syncHead()
    this.renderFoot()
    this.forceNext = true
    this.refresh().catch(() => {})
  }

  private applyTab(): void {
    const local = this.tab === 'local'
    this.localPane.hidden = !local
    this.remotePane.hidden = local
  }

  private wireDrag(): void {
    document.addEventListener('mousemove', (ev) => {
      const d = this.drag
      if (!d) return
      if (!d.active) {
        if (Math.abs(ev.clientX - d.startX) < 4 && Math.abs(ev.clientY - d.startY) < 4) return
        d.active = true
        this.suppressClickUntil = Date.now() + 400
        const ghost = el('div', { class: 'drag-ghost' })
        ghost.append(icon('file'), el('span', {}, d.name))
        document.body.append(ghost)
        d.ghost = ghost
        document.body.classList.add('dragging-file')
      }
      if (d.ghost) {
        d.ghost.style.left = `${ev.clientX + 12}px`
        d.ghost.style.top = `${ev.clientY + 10}px`
      }
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const row = under?.closest('.tree-row') as HTMLElement | null
      const ok = !!row && (row.dataset.dir === '1' || row.dataset.root === '1') && row.dataset.path !== d.path
      if (d.target && d.target !== row) d.target.classList.remove('drop-target')
      d.target = ok ? row! : undefined
      if (ok) row!.classList.add('drop-target')
    })

    document.addEventListener('mouseup', (ev) => {
      const d = this.drag
      if (!d) return
      this.drag = null
      document.body.classList.remove('dragging-file')
      d.ghost?.remove()
      d.target?.classList.remove('drop-target')
      if (!d.active) return
      this.suppressClickUntil = Date.now() + 300
      const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
      const row = under?.closest('.tree-row') as HTMLElement | null
      if (row && (row.dataset.dir === '1' || row.dataset.root === '1') && row.dataset.path !== d.path) {
        this.actions?.moveTo(d.path, row.dataset.path!)
      }
    })

    document.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !this.drag) return
      const d = this.drag
      this.drag = null
      d.ghost?.remove()
      d.target?.classList.remove('drop-target')
      document.body.classList.remove('dragging-file')
    })
  }

  setActions(a: SidebarActions): void {
    this.actions = a
    this.syncHead()
    this.renderFoot()
  }

  /** 同步 tab 的选中态与数量角标 */
  private syncHead(): void {
    const counts: Array<[SidebarTab, number]> = [
      ['local', state.roots.length],
      ['remote', (state.remoteRoots ?? []).length]
    ]
    for (const [id, n] of counts) {
      const btn = this.tabButtons.get(id)
      const badge = this.tabCounts.get(id)
      if (btn) {
        const on = this.tab === id
        btn.classList.toggle('active', on)
        btn.setAttribute('aria-selected', on ? 'true' : 'false')
      }
      if (badge) {
        badge.textContent = n ? String(n) : ''
        badge.hidden = !n
      }
    }
  }

  /** 底部按钮跟着 tab 走：本地加文件夹，远程加工作区 */
  private renderFoot(): void {
    clear(this.foot)
    const local = this.tab === 'local'
    const add = el('button', { title: local ? '添加文件夹到工作区  ⌘O' : '添加远程工作区' })
    add.append(icon(local ? 'folder-plus' : 'plus'), el('span', {}, local ? '添加文件夹' : '添加远程'))
    add.addEventListener('click', () => {
      if (local) this.actions?.openFolder()
      else this.actions?.addRemoteRoot()
    })
    const browse = el('button', { class: 'browse-btn', title: '浏览文件系统（标签页）  ⌘⇧B' })
    browse.append(icon('folder-open'))
    browse.addEventListener('click', () => this.actions?.openBrowser())
    const refresh = el('button', { class: 'refresh-btn', title: '刷新' })
    refresh.append(icon('refresh'))
    refresh.addEventListener('click', () => this.refresh())
    const set = el('button', { class: 'settings-btn', title: '设置  ⌘,' })
    set.append(icon('settings'))
    set.addEventListener('click', () => this.actions?.openSettings())
    this.foot.append(add, browse, refresh, set)
  }

  /** 清缓存但保留 DOM，交给 refresh 里的内容比对决定是否重绘 */
  invalidateQuiet(path?: string): void {
    if (!path) { this.cache.clear(); return }
    for (const key of Array.from(this.cache.keys())) {
      if (key === path || key.startsWith(path + '/')) this.cache.delete(key)
    }
  }

  invalidate(path?: string): void {
    this.forceNext = true
    if (!path) { this.cache.clear(); return }
    for (const key of Array.from(this.cache.keys())) {
      if (key === path || key.startsWith(path + '/')) this.cache.delete(key)
    }
  }

  private applyMulti(pane: HTMLElement | null): void {
    if (!pane) return
    for (const r of Array.from(pane.querySelectorAll('.tree-row')) as HTMLElement[]) {
      r.classList.toggle('multi', this.multi.size > 1 && this.multi.has(r.dataset.path || ''))
    }
  }

  /** 当前多选的路径 */
  multiSelection(): string[] { return Array.from(this.multi) }

  /** 键盘操作：↑↓ 走行、→ 展开或进子级、← 收起或回父级、Enter/空格 打开 */
  private onTreeKey(ev: KeyboardEvent): void {
    const pane = this.tab === 'local' ? this.localPane : this.remotePane
    const rows = Array.from(pane.querySelectorAll<HTMLElement>('.tree-row'))
    if (!rows.length) return
    const cur = document.activeElement as HTMLElement | null
    const idx = cur && cur.classList.contains('tree-row') ? rows.indexOf(cur) : -1
    const depthOf = (r: HTMLElement) => Number(r.style.getPropertyValue('--depth') || 0)
    const focusAt = (i: number) => {
      const row = rows[Math.max(0, Math.min(rows.length - 1, i))]
      if (!row) return
      row.focus()
      this.markKeyboardSelection(row)
    }
    const isDir = (r: HTMLElement) => r.dataset.dir === '1' || r.dataset.root === '1'
    const toggle = (path: string, expand?: boolean) => {
      const open = state.expanded.has(path)
      const want = expand ?? !open
      if (want === open) return
      if (want) state.expanded.add(path)
      else state.expanded.delete(path)
      this.forceNext = true
      this.refresh().catch(() => {})
    }
    const activate = (row: HTMLElement) => {
      const path = row.dataset.path || ''
      if (isDir(row)) { toggle(path); return }
      const entry = this.byPath.get(path)
      if (entry) this.actions?.open(entry)
    }
    switch (ev.key) {
      case 'ArrowDown': ev.preventDefault(); focusAt(idx + 1); break
      case 'ArrowUp': ev.preventDefault(); focusAt(idx <= 0 ? 0 : idx - 1); break
      case 'Home': ev.preventDefault(); focusAt(0); break
      case 'End': ev.preventDefault(); focusAt(rows.length - 1); break
      case 'ArrowRight': {
        ev.preventDefault()
        const row = rows[idx]
        if (!row) { focusAt(0); break }
        const path = row.dataset.path || ''
        if (isDir(row)) {
          if (!state.expanded.has(path)) { toggle(path, true); break }
          const next = rows[idx + 1]
          if (next && depthOf(next) > depthOf(row)) focusAt(idx + 1)
        }
        break
      }
      case 'ArrowLeft': {
        ev.preventDefault()
        const row = rows[idx]
        if (!row) { focusAt(0); break }
        const path = row.dataset.path || ''
        if (isDir(row) && state.expanded.has(path)) { toggle(path, false); break }
        for (let i = idx - 1; i >= 0; i--) {
          if (depthOf(rows[i]) < depthOf(row)) { focusAt(i); break }
        }
        break
      }
      case 'Enter':
      case ' ': {
        const row = rows[idx] ?? (cur && cur.classList.contains('tree-row') ? cur : null)
        if (!row) break
        ev.preventDefault()
        activate(row)
        break
      }
    }
  }

  private markKeyboardSelection(row: HTMLElement): void {
    const pane = row.closest('.tree-pane') as HTMLElement | null
    if (!pane) return
    for (const r of Array.from(pane.querySelectorAll('.tree-row.selected')) as HTMLElement[]) r.classList.remove('selected')
    row.classList.add('selected')
    const path = row.dataset.path
    if (!path) return
    state.selected = path
    this.multi.clear()
    this.multi.add(path)
    this.selAnchor = path
    this.selPane = pane
  }

  private statusFor(entry: Entry): string {
    if (!this.remoteStatus.size) return ''
    const direct = this.remoteStatus.get(entry.path)
    if (direct) return direct
    if (!entry.isDir) return ''
    const prefix = entry.path.replace(/\/$/, '') + '/'
    for (const key of this.remoteStatus.keys()) {
      if (key.startsWith(prefix)) return '·'
    }
    return ''
  }

  private async load(dir: string): Promise<Entry[]> {
    const cached = this.cache.get(dir)
    if (cached) {
      const sig = cached.map((e) => e.path + ':' + e.mtime + ':' + e.size).join('|')
      if (this.entrySig.get(dir) !== sig) this.dirty = true
      return cached
    }
    try {
      const entries = await invoke<Entry[]>('fs.list', { path: dir })
      const sig = entries.map((e) => e.path + ':' + e.mtime + ':' + e.size).join('|')
      if (this.entrySig.get(dir) !== sig) { this.entrySig.set(dir, sig); this.dirty = true }
      this.cache.set(dir, entries)
      this.failedDirs.delete(dir)
      return entries
    } catch {
      this.failedDirs.add(dir)
      return []
    }
  }

  async refresh(): Promise<void> {
    this.dirty = false
    const focused = document.activeElement as HTMLElement | null
    const focusPath = focused?.classList.contains('tree-row') ? focused.dataset.path : undefined
    try { await this.refreshInner() } catch (e: any) {
      invoke('app.log', { line: 'SIDEBAR ERR ' + (e?.stack ?? String(e)).slice(0, 300) }).catch(() => {})
      throw e
    } finally {
      if (focusPath) this.restoreFocus(focusPath)
    }
  }

  /** 重绘后把键盘焦点还给同一路径的行，避免展开/刷新时焦点掉到 body */
  private restoreFocus(path: string): void {
    const pane = this.tab === 'local' ? this.localPane : this.remotePane
    const row = Array.from(pane.querySelectorAll<HTMLElement>('.tree-row')).find((r) => r.dataset.path === path)
    row?.focus({ preventScroll: true })
  }

  private async refreshInner(): Promise<void> {
    const token = ++this.token
    this.syncHead()
    this.renderFoot()
    const tab = this.tab
    const canSkip = this.renderedTabs.has(tab) && !this.forceNext
    this.forceNext = false
    if (canSkip) {
      // 先探测一次当前分区目录内容；没变化就完全跳过 DOM 重建
      this.dirty = false
      for (const d of this.visibleDirs(tab)) {
        this.cache.delete(d)
        await this.load(d)
        if (this.dirty) break
      }
      if (!this.dirty) {
        if (tab === 'remote') this.refreshRemoteStatus(token).catch(() => {})
        return
      }
    }
    if (tab === 'local') {
      const frag = document.createDocumentFragment()
      await this.renderLocal(frag, token)
      if (token !== this.token) return
    } else {
      // 先用缓存里的分支 / 改动标记把树画出来，git 状态在后台补，不阻塞切换
      await this.paintRemote(token)
      if (token !== this.token) return
      this.refreshRemoteStatus(token).catch(() => {})
    }
    this.renderedTabs.add(tab)
  }

  /** 本地分区：只渲染这一块，切换 tab 时另一块不会被无谓地重建 */
  private async renderLocal(frag: DocumentFragment, token: number): Promise<void> {
    if (!state.roots.length) {
      frag.appendChild(el('div', { class: 'tree-empty small' }, '还没有本地文件夹，⌘O 添加'))
    }
    for (const root of state.roots) {
      frag.appendChild(this.rootRow(root))
      if (state.expanded.has(root)) {
        await this.renderDir(frag, root, 1, token)
      }
    }
    const scrollTop = this.list.scrollTop
    clear(this.localPane)
    this.localPane.append(frag)
    this.list.scrollTop = scrollTop
  }

  /** 先铺根节点，再逐个补展开的子目录，切过去不会先看到一块空白 */
  private async paintRemote(token: number): Promise<void> {
    const remoteRoots = state.remoteRoots ?? []
    const scrollTop = this.list.scrollTop
    clear(this.remotePane)
    if (!remoteRoots.length) {
      const hint = el('div', { class: 'tree-empty small clickable' }, '还没有远程工作区\n点下面的「添加远程」挂一个 SSH 仓库')
      hint.addEventListener('click', () => this.actions?.addRemoteRoot())
      this.remotePane.append(hint)
      return
    }
    for (const rr of remoteRoots) {
      this.remotePane.append(this.rootRow(remoteRootPath(rr), rr.name, 'remote'))
    }
    for (const rr of remoteRoots) {
      if (token !== this.token) return
      const rootPath = remoteRootPath(rr)
      if (!state.expanded.has(rootPath)) continue
      const box = el('div')
      await this.renderDir(box, rootPath, 1, token)
      if (token !== this.token) return
      const anchor = this.remotePane.querySelector(`.tree-row[data-path="${CSS.escape(rootPath)}"]`)
      if (!anchor) continue
      let ref = anchor.nextSibling
      for (const node of Array.from(box.childNodes)) {
        this.remotePane.insertBefore(node, ref)
        ref = node.nextSibling
      }
    }
    this.list.scrollTop = scrollTop
  }

  /** 后台拉取每个远程仓库的 git 状态，有变化才重画一次树 */
  private async refreshRemoteStatus(token: number): Promise<void> {
    if (this.remoteBusy) return
    const roots = state.remoteRoots ?? []
    if (!roots.length) return
    this.remoteBusy = true
    try {
      const results = await Promise.all(roots.map(async (rr) => {
        const rootPath = remoteRootPath(rr)
        const res = await invoke<any>('remote.gitStatus', { id: rr.id, path: rootPath }).catch(() => null)
        return { rootPath, res }
      }))
      let changed = false
      for (const { rootPath, res } of results) {
        const branch = String(res?.branch ?? '')
        if (this.remoteBranch.get(rootPath) !== branch) {
          this.remoteBranch.set(rootPath, branch)
          changed = true
        }
        const prefix = rootPath.replace(/\/$/, '') + '/'
        const next = new Map<string, string>()
        for (const item of res?.entries ?? []) next.set(prefix + item.path, String(item.code))
        const cur = new Map<string, string>()
        for (const [k, v] of this.remoteStatus) if (k.startsWith(prefix)) cur.set(k, v)
        const same = cur.size === next.size && Array.from(next).every(([k, v]) => cur.get(k) === v)
        if (!same) {
          for (const k of Array.from(cur.keys())) this.remoteStatus.delete(k)
          for (const [k, v] of next) this.remoteStatus.set(k, v)
          changed = true
        }
      }
      if (!changed || token !== this.token || this.tab !== 'remote') return
      await this.paintRemote(token)
    } finally {
      this.remoteBusy = false
    }
  }

  private rootRow(root: string, label?: string, kind?: 'remote'): HTMLElement {
    const open = state.expanded.has(root)
    const row = el('div', {
      class: 'tree-row root-row' + (open ? ' open' : ''),
      title: root,
      dataset: { path: root, root: '1' }
    })
    row.style.setProperty('--depth', '0')
    row.tabIndex = -1
    // 内联兜底：样式表若被缓存或层叠覆盖，这里保证悬停仍是手形
    row.style.cursor = 'pointer'
    const twist = el('div', { class: 'twist' })
    twist.append(icon('chevron'))
    row.append(twist)
    const ic = el('div', { class: 'ic' })
    ic.append(icon(kind === 'remote' ? 'external' : 'folder-open'))
    if (kind === 'remote') row.classList.add('remote-root')
    row.append(ic)
    row.append(el('div', { class: 'nm' }, label || basename(root)))
    if (kind === 'remote') {
      const br = this.remoteBranch.get(root)
      if (br) row.append(el('span', { class: 'git-branch' }, '⎇ ' + br))
    }
    const close = el('div', { class: 'root-close', title: kind === 'remote' ? '断开并移除' : '从工作区移除' })
    close.append(icon('close'))
    close.addEventListener('click', (ev) => {
      ev.stopPropagation()
      if (kind === 'remote') this.actions?.removeRemoteRoot(root)
      else this.actions?.removeRoot(root)
    })
    row.append(close)

    row.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return
      if ((ev.target as HTMLElement).closest('.root-close')) return
      this.drag = { path: root, name: basename(root), startX: ev.clientX, startY: ev.clientY, active: false }
    })

    row.addEventListener('click', () => {
      if (Date.now() < this.suppressClickUntil) return
      row.focus({ preventScroll: true })
      if (kind !== 'remote' && state.vaults.has(root) && !state.vaults.get(root)) {
        this.actions?.openVault({ path: root, isDir: true } as Entry)
        return
      }
      if (state.expanded.has(root)) state.expanded.delete(root)
      else state.expanded.add(root)
      this.forceNext = true
      this.refresh()
    })
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault(); ev.stopPropagation()
      if (kind === 'remote') { this.actions?.remoteRootMenu(root, ev); return }
      if (this.multi.size > 1) { this.actions?.multiMenu(this.multiSelection(), ev); return }
      this.actions?.rootMenu(root, ev)
    })
    return row
  }

  /** 目录优先 + 自然序、不区分大小写；和 DSH 文件树的排序一致 */
  private static sortEntries(entries: Entry[]): Entry[] {
    return entries.slice().sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: 'base' })
    })
  }

  private async renderDir(parent: Node, dir: string, depth: number, token: number): Promise<void> {
    const entries = await this.load(dir)
    if (token !== this.token) return
    if (this.failedDirs.has(dir)) {
      const row = el('div', { class: 'tree-empty small' }, `无法读取 ${basename(dir)}`)
      row.style.setProperty('--depth', String(depth))
      parent.appendChild(row)
      return
    }
    const visible = Sidebar.sortEntries(entries).filter((entry) => !entry.hidden || state.settings.showHidden)
    if (!visible.length) {
      parent.appendChild(el('div', { class: 'tree-empty small' }, '空目录'))
      return
    }
    for (const entry of visible) {
      parent.appendChild(this.row(entry, depth))
      const lockedVault = entry.isDir && entry.vault && !state.vaults.get(entry.path)
      if (entry.isDir && state.expanded.has(entry.path) && !lockedVault) {
        await this.renderDir(parent, entry.path, depth + 1, token)
      }
    }
  }

  private row(entry: Entry, depth: number): HTMLElement {
    const expanded = entry.isDir && state.expanded.has(entry.path)
    const isActive = state.activeId === entry.path
    const row = el('div', {
      class: 'tree-row' + (expanded ? ' open' : '') + (isActive ? ' active' : '') + (entry.hidden ? ' hidden-entry' : ''),
      title: entry.path,
      dataset: entry.isDir ? { path: entry.path, dir: '1' } : { path: entry.path }
    })
    row.style.setProperty('--depth', String(depth))
    row.tabIndex = -1
    row.style.cursor = 'pointer'
    this.byPath.set(entry.path, entry)
    const twist = el('div', { class: 'twist' })
    if (entry.isDir) twist.append(icon('chevron'))
    row.append(twist)

    const ic = el('div', { class: 'ic' })
    if (entry.isDir) {
      ic.append(icon(expanded ? 'folder-open' : 'folder'))
    } else {
      ic.append(fileIcon(entry.ext))
      const c = iconColor(entry.ext)
      if (c) ic.style.color = c
    }
    row.append(ic)
    row.append(el('div', { class: 'nm' }, entry.displayName))
    const st = this.statusFor(entry)
    if (st) {
      const b = el('span', { class: 'git-badge' }, st)
      b.dataset.code = st
      row.append(b)
    }

    if (entry.isDir && entry.vault) {
      const badge = el('div', { class: 'badge' })
      badge.append(icon(state.vaults.get(entry.path) ? 'unlock' : 'lock'))
      row.append(badge)
    } else if (entry.encrypted) {
      const badge = el('div', { class: 'badge' })
      badge.append(icon('lock'))
      row.append(badge)
    }

    row.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return
      if ((ev.target as HTMLElement).closest('.root-close')) return
      this.drag = { path: entry.path, name: entry.displayName, startX: ev.clientX, startY: ev.clientY, active: false }
    })

    row.addEventListener('click', (ev) => {
      if (Date.now() < this.suppressClickUntil) return
      row.focus({ preventScroll: true })
      if (multiSelect(ev)) {
        const pane = row.closest('.tree-pane') as HTMLElement | null
        if (pane !== this.selPane) { this.multi.clear(); this.selPane = pane }
        if (this.multi.has(entry.path)) this.multi.delete(entry.path)
        else this.multi.add(entry.path)
        this.selAnchor = entry.path
        this.applyMulti(row.closest('.tree-pane') as HTMLElement)
        return
      }
      if (ev.shiftKey && this.selAnchor) {
        const pane = row.closest('.tree-pane') as HTMLElement
        const rows = Array.from(pane.querySelectorAll('.tree-row')) as HTMLElement[]
        const a = rows.findIndex((r) => r.dataset.path === this.selAnchor)
        const b = rows.indexOf(row)
        if (a >= 0 && b >= 0) {
          this.multi.clear()
          for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
            const p = rows[i].dataset.path
            if (p) this.multi.add(p)
          }
          this.applyMulti(pane)
          return
        }
      }
      this.multi.clear()
      this.multi.add(entry.path)
      this.selAnchor = entry.path
      this.selPane = row.closest('.tree-pane') as HTMLElement | null
      this.applyMulti(row.closest('.tree-pane') as HTMLElement)
      state.selected = entry.path
      if (entry.isDir) {
        if (entry.vault && !state.vaults.get(entry.path)) {
          this.actions?.openVault(entry)
          return
        }
        if (state.expanded.has(entry.path)) state.expanded.delete(entry.path)
        else state.expanded.add(entry.path)
        this.forceNext = true
        this.refresh()
      } else {
        this.actions?.open(entry)
      }
    })
    row.addEventListener('contextmenu', (ev) => {
      ev.preventDefault()
      ev.stopPropagation()
      if (this.multi.size > 1 && this.multi.has(entry.path)) {
        this.actions?.multiMenu(this.multiSelection(), ev)
        return
      }
      state.selected = entry.path
      this.actions?.contextMenu(entry, ev)
    })
    if (entry.isDir) {
      row.addEventListener('dragover', (ev) => {
        if (!ev.dataTransfer?.types.includes('application/x-bnb-path')) return
        ev.preventDefault()
        row.classList.add('drop-target')
      })
      row.addEventListener('dragleave', () => row.classList.remove('drop-target'))
      row.addEventListener('drop', (ev) => {
        row.classList.remove('drop-target')
        const src = ev.dataTransfer?.getData('application/x-bnb-path')
        if (!src) return
        ev.preventDefault()
        if (ev.altKey) this.actions?.copyInto(src, entry.path)
        else this.actions?.moveInto(src, entry.path)
      })
    }
    return row
  }
}

/** 远程根在树里用的路径：ssh://<rootId>/<abs> */
export function remoteRootPath(r: { id: string; path: string }): string {
  return `ssh://${r.id}${r.path.startsWith('/') ? '' : '/'}${r.path}`
}
