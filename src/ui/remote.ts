import { invoke } from '../lib/bridge'
import { el, clear } from '../lib/dom'
import { dirname, humanSize } from '../lib/files'
import { icon } from '../lib/icons'
import type { TermProfile } from './terminal'

interface REntry { name: string; isDir: boolean; size: number; mode: string }

export interface RemoteDeps {
  openLocal: (path: string, name: string) => void
  toast: (msg: string, ms?: number) => void
  menu: (x: number, y: number, items: any[]) => void
  prompt: (opts: any) => Promise<string | null>
}

export class RemotePanel {
  readonly el: HTMLElement
  readonly profile: TermProfile
  private deps: RemoteDeps
  private pathBar: HTMLInputElement
  private list: HTMLElement
  private status: HTMLElement
  private entries: REntry[] = []
  path = '.'
  private req = 0
  private cache = new Map<string, { entries: REntry[]; at: number }>()
  private selected: string | null = null
  private selectedEntry: REntry | null = null

  constructor(profile: TermProfile, deps: RemoteDeps) {
    this.profile = profile
    this.deps = deps
    this.pathBar = el('input', { class: 'browser-path', spellcheck: 'false' }) as HTMLInputElement
    this.list = el('div', { class: 'browser-list' })
    this.status = el('div', { class: 'browser-status' })

    const mk = (ic: string, title: string, fn: () => void) => {
      const b = el('button', { class: 'browser-btn', title })
      b.append(icon(ic))
      b.addEventListener('click', fn)
      return b
    }
    const up = mk('arrow-left', '上一级', () => this.load(dirname(this.path === '.' ? '.' : this.path)))
    up.style.transform = 'rotate(90deg)'
    const bar = el('div', { class: 'browser-bar' },
      up,
      this.pathBar,
      mk('refresh', '刷新', () => this.load(this.path, true)),
      mk('close', '关闭', () => (this.deps as any).onClose?.())
    )
    const dlBtn = el('button', { class: 'term-file-btn', title: '把选中的文件下载到本机（会先选保存位置）' }, '下载')
    dlBtn.addEventListener('click', () => {
      if (!this.selectedEntry) { this.deps.toast('先选中一个文件'); return }
      if (this.selectedEntry.isDir) { this.deps.toast('目录不能直接下载'); return }
      this.downloadTo(this.selectedEntry.name)
    })
    const upBtn = el('button', { class: 'term-file-btn', title: '从本机选择文件上传到当前目录' }, '上传')
    upBtn.addEventListener('click', () => this.upload())
    bar.insertBefore(dlBtn, bar.lastElementChild)
    bar.insertBefore(upBtn, bar.lastElementChild)
    this.pathBar.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { this.load(this.pathBar.value.trim()); (ev.target as HTMLElement).blur() }
    })
    this.el = el('div', { class: 'browser remote' }, bar, this.list, this.status)
    this.el.style.display = 'flex'
  }

  private target(): any {
    return { host: this.profile.host, port: this.profile.port ?? 22, user: this.profile.user ?? 'root',
             secretId: this.profile.hasPassword ? this.profile.id : undefined,
             mockLocal: this.profile.host === 'mock' }
  }

  async load(path: string, force = false): Promise<void> {
    const cached = this.cache.get(path)
    if (cached && !force) {
      // 回退/前进先用缓存立即渲染，再在后台刷新
      this.path = path
      this.pathBar.value = path
      this.entries = cached.entries
      this.selected = null
      this.selectedEntry = null
      this.render()
      if (Date.now() - cached.at > 15_000) this.fetch(path, true)
      return
    }
    this.pathBar.value = path
    this.list.innerHTML = '<div class="browser-empty">读取中…</div>'
    this.status.textContent = '读取中…'
    await this.fetch(path, false)
  }

  private async fetch(path: string, background: boolean): Promise<void> {
    const token = ++this.req
    if (background) this.status.textContent = '刷新中…'
    try {
      const res = await invoke<any>('remote.list', { ...this.target(), path })
      if (token !== this.req) return
      if (res?.error) {
        if (!background) {
          this.list.innerHTML = ''
          this.list.append(el('div', { class: 'browser-empty' }, String(res.error).slice(0, 300)))
          this.status.textContent = '读取失败'
        } else {
          this.status.textContent = `${this.entries.length} 项 · ${this.profile.user}@${this.profile.host}`
        }
        return
      }
      const entries = (res?.entries ?? []) as REntry[]
      this.entries = entries
      this.path = path
      this.cache.set(path, { entries, at: Date.now() })
      this.render()
    } catch (err: any) {
      if (token !== this.req) return
      if (!background) {
        this.list.innerHTML = ''
        this.list.append(el('div', { class: 'browser-empty' }, String(err?.message ?? err)))
        this.status.textContent = '读取失败'
      } else {
        this.status.textContent = `${this.entries.length} 项 · ${this.profile.user}@${this.profile.host}`
      }
    }
  }

  private join(name: string): string {
    return this.path === '.' || this.path === '/' ? `${this.path === '/' ? '' : ''}/${name}` : `${this.path.replace(/\/$/, '')}/${name}`
  }

  private render(): void {
    clear(this.list)
    if (!this.entries.length) this.list.append(el('div', { class: 'browser-empty' }, '空目录'))
    for (const e of this.entries) {
      const row = el('div', { class: 'browser-row', dataset: { path: this.join(e.name) } })
      const nameCell = el('div', { class: 'b-name' })
      const ic = el('span', { class: 'b-ic' })
      ic.append(icon(e.isDir ? 'folder' : 'file'))
      nameCell.append(ic, el('span', { class: 'b-text' }, e.name))
      row.append(nameCell, el('div', { class: 'b-size' }, e.isDir ? '—' : humanSize(e.size)), el('div', { class: 'b-time' }))
      row.addEventListener('click', () => {
        this.selected = e.name
        this.selectedEntry = e
        for (const r of Array.from(this.list.querySelectorAll('.browser-row'))) {
          r.classList.toggle('selected', r === row)
        }
      })
      row.addEventListener('dblclick', () => { if (e.isDir) this.load(this.join(e.name)) })
      row.addEventListener('contextmenu', (ev) => {
        ev.preventDefault()
        this.deps.menu(ev.clientX, ev.clientY, [
          e.isDir
            ? { label: '进入', icon: 'folder-open', onClick: () => this.load(this.join(e.name)) }
            : { label: '下载到…', icon: 'external', onClick: () => this.downloadTo(e.name) },
          { label: '上传文件到此处…', icon: 'plus', onClick: () => this.upload(e.isDir ? this.join(e.name) : this.path) },
          { sep: true },
          { label: '新建文件夹…', icon: 'folder-plus', onClick: () => this.mkdir() },
          { label: '重命名…', icon: 'pencil', onClick: () => this.rename(e.name) },
          { label: '删除', icon: 'trash', danger: true, onClick: () => this.remove(e.name) }
        ])
      })
      this.list.append(row)
    }
    this.status.textContent = `${this.entries.length} 项 · ${this.profile.user}@${this.profile.host}`
  }

  private async upload(dir = this.path): Promise<void> {
    const files = await invoke<string[]>('ui.pickFiles').catch(() => [])
    if (!files?.length) return
    const base = dir.replace(/\/$/, '')
    for (const f of files) {
      const name = f.split('/').pop()!
      const to = base === '/' || base === '.' ? `/${name}` : `${base}/${name}`
      const res = await invoke<any>('remote.upload', { ...this.target(), local: f, to }).catch((e) => ({ error: e.message }))
      if (res?.error) this.deps.toast(`${name}: ${String(res.error).slice(0, 60)}`, 4000)
    }
    this.deps.toast(`已上传 ${files.length} 个文件`)
    this.cache.delete(dir.replace(/\/$/, '') || '.')
    this.cache.delete(this.path)
    await this.load(this.path, true)
  }

  private async downloadTo(name: string): Promise<void> {
    const target = await invoke<string | null>('ui.savePanel', { name }).catch(() => null)
    if (!target) return
    this.deps.toast('正在下载…', 1500)
    const res = await invoke<any>('remote.download', { ...this.target(), path: this.join(name), to: target })
      .catch((e) => ({ error: e.message }))
    if (res?.error) this.deps.toast(String(res.error).slice(0, 80), 4000)
    else this.deps.toast(`已下载到 ${target.split('/').pop()}`, 2500)
  }

  private async mkdir(): Promise<void> {
    const name = await this.deps.prompt({ title: '新建文件夹', label: '名称' })
    if (!name) return
    await invoke('remote.mkdir', { ...this.target(), path: this.join(name) }).catch(() => {})
    this.cache.delete(this.path)
    await this.load(this.path, true)
  }

  private async rename(name: string): Promise<void> {
    const next = await this.deps.prompt({ title: '重命名', label: '新名称', value: name })
    if (!next || next === name) return
    await invoke('remote.rename', { ...this.target(), from: this.join(name), to: this.join(next) }).catch(() => {})
    this.cache.delete(this.path)
    await this.load(this.path, true)
  }

  private async remove(name: string): Promise<void> {
    await invoke('remote.remove', { ...this.target(), path: this.join(name) }).catch(() => {})
    this.cache.delete(this.path)
    await this.load(this.path, true)
  }
}
