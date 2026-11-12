import { invoke } from './bridge'
import { basename, detectKind, extname, isEditable, type DocKind } from './files'
import { askSave } from '../ui/overlays'

export type ViewMode = 'edit' | 'split' | 'preview'

export interface Issue {
  line: number
  message: string
  severity: string
}

export interface Doc {
  id: string
  path: string
  name: string
  ext: string
  kind: DocKind
  editable: boolean
  text: string
  saved: string
  dirty: boolean
  view: ViewMode
  encrypted: boolean
  mtime: number
  size: number
  issues: Issue[]
  checked: boolean
  locked: boolean
  /** 终端会话的副标题（如 root@host），用于同名标签区分 */
  detail?: string
  /** 终端会话的颜色点 */
  color?: string
}

export interface Settings {
  theme: string
  iconSet: string
  aiBaseUrl: string
  aiModel: string
  fontSize: number
  lineWrap: boolean
  autoSave: boolean
  sidebarWidth: number
  sidebarVisible: boolean
  showHidden: boolean
  roots: string[]
  remoteRoots: RemoteRoot[]
  expanded: string[]
  recent: string[]
  sessions?: SessionProfile[]
  /** 全局快速命令（SSH 终端里一键发送） */
  quickCommands?: QuickCommand[]
  /** 左侧当前显示的分区：本地或远程 */
  treeTab?: 'local' | 'remote'
  /** 上次打开的标签，用于会话恢复 */
  openDocs?: string[]
  activePath?: string
}

/** 全局快速命令：名字给列表看，内容直接发到终端 */
export interface QuickCommand {
  id: string
  name: string
  content: string
}

export interface RemoteRoot {
  id: string
  name: string
  host: string
  port: number
  user: string
  path: string
  /** 保存的密码对应的会话 id */
  secretId?: string
}

export interface SessionProfile {
  id: string
  name: string
  kind: 'local' | 'ssh'
  host?: string
  port?: number
  user?: string
  cwd?: string
  group?: string
  color?: string
  hasPassword?: boolean
  /** 连接后直接进入的远端目录（ssh 与远端文件面板都用它） */
  remotePath?: string
}

const SETTINGS_KEY = 'betternotebook.settings.v1'

export const DEFAULT_SETTINGS: Settings = {
  theme: 'daylight',
  iconSet: 'auto',
  aiBaseUrl: 'https://api.deepseek.com',
  aiModel: 'deepseek-flash',
  fontSize: 14,
  lineWrap: false,
  autoSave: false,
  sidebarWidth: 248,
  sidebarVisible: true,
  showHidden: false,
  roots: [],
  expanded: [],
  recent: [],
  sessions: [],
  quickCommands: [],
  remoteRoots: []
}

export const state = {
  remoteRoots: [] as RemoteRoot[],
  roots: [] as string[],
  docs: [] as Doc[],
  activeId: null as string | null,
  expanded: new Set<string>(),
  selected: null as string | null,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  vaults: new Map<string, boolean>()
}

type Kind = 'docs' | 'active' | 'content' | 'settings' | 'root'

const subs = new Set<(k: Kind) => void>()

export function subscribe(fn: (k: Kind) => void): () => void {
  subs.add(fn)
  return () => subs.delete(fn)
}

export function emit(k: Kind): void {
  for (const fn of Array.from(subs)) fn(k)
}

export function loadSettings(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY) ?? localStorage.getItem('lumen.settings.v1')
    if (raw) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {}
  // 官方已改用 deepseek-flash / deepseek-v4-pro，旧名字做一次迁移
  if (['deepseek-chat', 'deepseek-reasoner'].includes(state.settings.aiModel)) {
    state.settings.aiModel = 'deepseek-flash'
  }
  // 数组字段拷一份，避免改设置时污染 DEFAULT_SETTINGS
  state.settings.quickCommands = (state.settings.quickCommands ?? []).slice()
  state.expanded = new Set(state.settings.expanded ?? [])
  state.roots = (state.settings.roots ?? []).slice()
  state.remoteRoots = (state.settings.remoteRoots ?? []).slice()
}

let saveTimer: any
export function saveSettings(): void {
  state.settings.roots = state.roots.slice()
  state.settings.expanded = Array.from(state.expanded)
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings)) } catch {}
  }, 250)
}

let saveAsHandler: ((doc: Doc) => Promise<boolean>) | null = null
export function setSaveAsHandler(fn: (doc: Doc) => Promise<boolean>): void {
  saveAsHandler = fn
}

export function createTerminalDoc(name: string, detail = '', color = ''): Doc {
  const doc: Doc = {
    id: `term:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    path: '',
    name,
    ext: '',
    kind: 'terminal',
    editable: false,
    text: '',
    saved: '',
    dirty: false,
    view: 'preview',
    encrypted: false,
    mtime: 0,
    size: 0,
    issues: [],
    checked: false,
    locked: false,
    detail,
    color
  }
  state.docs.push(doc)
  setActive(doc.id)
  return doc
}

export function createRemoteDoc(name: string): Doc {
  const doc: Doc = {
    id: `remote:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
    path: '',
    name,
    ext: '',
    kind: 'sftp',
    editable: false,
    text: '',
    saved: '',
    dirty: false,
    view: 'preview',
    encrypted: false,
    mtime: 0,
    size: 0,
    issues: [],
    checked: false,
    locked: false
  }
  state.docs.push(doc)
  setActive(doc.id)
  return doc
}

export function createUntitled(index = 1): Doc {
  const doc: Doc = {
    id: `untitled:${Date.now()}:${index}`,
    path: '',
    name: index > 1 ? `未命名 ${index}` : '未命名',
    ext: '',
    kind: 'text',
    editable: true,
    text: '',
    saved: '',
    dirty: false,
    view: 'edit',
    encrypted: false,
    mtime: 0,
    size: 0,
    issues: [],
    checked: false,
    locked: false
  }
  state.docs.push(doc)
  setActive(doc.id)
  return doc
}

export const BROWSER_TAB_ID = 'browser:main'

/** 文件管理是一个特殊标签页，切走再切回来状态还在 */
export function openBrowserTab(): Doc {
  const existing = state.docs.find((d) => d.id === BROWSER_TAB_ID)
  if (existing) {
    setActive(existing.id)
    return existing
  }
  const doc: Doc = {
    id: BROWSER_TAB_ID,
    path: '',
    name: '文件',
    ext: '',
    kind: 'browser',
    editable: false,
    text: '',
    saved: '',
    dirty: false,
    view: 'preview',
    encrypted: false,
    mtime: 0,
    size: 0,
    issues: [],
    checked: false,
    locked: false
  }
  state.docs.push(doc)
  setActive(doc.id)
  return doc
}

export function closeBrowserTab(): void {
  const idx = state.docs.findIndex((d) => d.id === BROWSER_TAB_ID)
  if (idx < 0) return
  const doc = state.docs[idx]
  if (doc.locked) return
  state.docs.splice(idx, 1)
  if (state.activeId === BROWSER_TAB_ID) {
    const next = state.docs[Math.min(idx, state.docs.length - 1)]
    state.activeId = next ? next.id : null
  }
  emit('docs')
  emit('active')
}

/** 拖动标签页排序 */
export function moveDoc(id: string, beforeId: string | null): void {
  const from = state.docs.findIndex((d) => d.id === id)
  if (from < 0) return
  const [doc] = state.docs.splice(from, 1)
  let to = beforeId ? state.docs.findIndex((d) => d.id === beforeId) : state.docs.length
  if (to < 0) to = state.docs.length
  state.docs.splice(to, 0, doc)
  emit('docs')
}

export function activeDoc(): Doc | null {
  return state.docs.find((d) => d.id === state.activeId) ?? null
}

export function findDoc(path: string): Doc | undefined {
  return state.docs.find((d) => d.path === path)
}

/** Workspace root that contains `path` (longest match). */
export function rootOf(path: string): string | null {
  let best: string | null = null
  for (const r of state.roots) {
    if (path === r || path.startsWith(r + '/')) {
      if (!best || r.length > best.length) best = r
    }
  }
  return best
}

function defaultView(kind: DocKind): ViewMode {
  if (kind === 'md') return 'split'
  if (kind === 'html' || kind === 'csv' || kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio' || kind === 'epub' || kind === 'office') return 'preview'
  return 'edit'
}

export async function openPath(path: string, opts: { name?: string; encrypted?: boolean; activate?: boolean } = {}): Promise<Doc> {
  const existing = findDoc(path)
  if (existing) {
    if (opts.activate !== false) setActive(existing.id)
    return existing
  }
  const name = opts.name ?? basename(path)
  const ext = extname(name)
  const kind = detectKind(ext)
  const doc: Doc = {
    id: path,
    path,
    name,
    ext,
    kind,
    editable: isEditable(kind),
    text: '',
    saved: '',
    dirty: false,
    view: defaultView(kind),
    encrypted: path.endsWith('.bnenc') || !!opts.encrypted,
    mtime: 0,
    size: 0,
    issues: [],
    checked: false,
    locked: false
  }
  try {
    const st = await invoke<{ size: number; mtime: number }>('fs.stat', { path })
    doc.size = st.size
    doc.mtime = st.mtime
  } catch {}
  if (isEditable(kind)) {
    const res = await invoke<{ kind: string; text?: string; mtime: number }>('fs.read', { path })
    doc.text = res.text ?? ''
    doc.saved = doc.text
    doc.mtime = res.mtime ?? doc.mtime
    doc.size = res.text ? res.text.length : doc.size
  }
  state.docs.push(doc)
  if (opts.activate !== false) setActive(doc.id)
  else emit('docs')
  return doc
}

export function setActive(id: string | null): void {
  state.activeId = id
  emit('active')
  emit('docs')
}

export function setText(doc: Doc, text: string): void {
  if (doc.text === text) return
  doc.text = text
  const dirty = text !== doc.saved
  if (dirty !== doc.dirty) {
    doc.dirty = dirty
    emit('docs')
  }
  emit('content')
}

let afterSaveHandler: ((doc: Doc) => void) | null = null
export function setAfterSaveHandler(fn: (doc: Doc) => void): void {
  afterSaveHandler = fn
}

export async function saveDoc(doc: Doc): Promise<void> {
  if (!doc.editable) return
  const res = await invoke<{ mtime: number }>('fs.write', { path: doc.path, text: doc.text })
  invoke('drafts.drop', { path: doc.path }).catch(() => {})
  doc.saved = doc.text
  doc.dirty = false
  doc.mtime = res?.mtime ?? doc.mtime
  emit('docs')
  afterSaveHandler?.(doc)
}

export async function saveActive(): Promise<void> {
  const d = activeDoc()
  if (d) await saveDoc(d)
}

export async function closeDoc(id: string): Promise<boolean> {
  const idx = state.docs.findIndex((d) => d.id === id)
  if (idx < 0) return true
  const doc = state.docs[idx]
  if (doc.locked) return false
  if (doc.path.endsWith('.bnenc')) {
    const root = await invoke<string | null>('vault.findRoot', { path: doc.path }).catch(() => null)
    if (!root) await invoke('vault.lockFile', { path: doc.path }).catch(() => {})
  }
  if (doc.dirty) {
    if (!doc.path) {
      const choice = await askSave(doc.name)
      if (choice === 'cancel') return false
      if (choice === 'save') {
        const ok = (await saveAsHandler?.(doc)) ?? false
        if (!ok) return false
      }
    } else {
      await saveDoc(doc).catch(() => {})
    }
  }
  state.docs.splice(idx, 1)
  if (state.activeId === id) {
    const next = state.docs[Math.min(idx, state.docs.length - 1)]
    state.activeId = next ? next.id : null
  }
  emit('docs')
  emit('active')
  return true
}

export function setView(doc: Doc, view: ViewMode): void {
  if (doc.view === view) return
  doc.view = view
  emit('active')
  emit('docs')
}

export function cycleView(doc: Doc): void {
  const order: ViewMode[] = doc.editable ? ['edit', 'split', 'preview'] : ['preview']
  if (order.length === 1) return
  const i = order.indexOf(doc.view)
  setView(doc, order[(i + 1) % order.length])
}
