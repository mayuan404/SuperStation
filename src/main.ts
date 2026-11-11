import { invoke, onEvent, fileURL } from './lib/bridge'
import { el, clear, debounce } from './lib/dom'
import { icon } from './lib/icons'
import { basename, detectKind, dirname, extname, humanSize, isEditable, joinPath } from './lib/files'
import * as S from './lib/store'
import { checkJSON } from './lib/jsoncheck'
import type { Doc } from './lib/store'
import { Editor } from './editor/editor'
import { renderPreview, renderEmpty } from './preview/preview'
import { AIPanel } from './ui/ai'
import { FileBrowser } from './ui/browser'
import { openSettings, openShortcuts, themePalette } from './ui/settings'
import { openQuickCommandManager } from './ui/quickcmd'
import { remoteRootPath } from './ui/sidebar'
import { ctx } from './lib/ctx'

// WKWebView 在部分系统版本上不会按 CSS 刷新光标（手形只在极少数帧出现）。
// 这里把每一帧下鼠标所在元素的计算光标值经桥接推给原生，由 AppKit 直接 set，
// 只在该值变化时发一次，开销可忽略。
function installCursorBridge(): void {
  let last = ''
  let lastAt = 0
  let queued = false
  let defaultTimer = 0
  const send = (shape: string) => {
    last = shape
    lastAt = performance.now()
    invoke('ui.cursor', { shape }).catch(() => {})
  }
  // 切到手形立即生效；切回箭头延迟 80ms 确认，避免鼠标掠过行间缝隙时手/箭头抖动
  const push = (shape: string) => {
    const now = performance.now()
    if (shape === 'default') {
      if (last === 'default' && now - lastAt < 80) return
      if (defaultTimer) return
      defaultTimer = window.setTimeout(() => {
        defaultTimer = 0
        if (last !== 'default') send('default')
      }, 80)
      return
    }
    if (defaultTimer) { window.clearTimeout(defaultTimer); defaultTimer = 0 }
    if (shape === last && now - lastAt < 80) return
    send(shape)
  }
  const normalize = (v: string) => (!v || v === 'auto' ? 'default' : v)
  document.addEventListener('mousemove', (ev) => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      const t = ev.target as HTMLElement | null
      if (!t || t.nodeType !== 1) { push('default'); return }
      push(normalize(getComputedStyle(t).cursor))
    })
  }, { passive: true })
  window.addEventListener('blur', () => {
    if (defaultTimer) { window.clearTimeout(defaultTimer); defaultTimer = 0 }
    send('default')
  })
}
import { terminalMenu, openTerminalMenuAtCenter, registerRemoteRoots, addRemoteRoot, removeRemoteRoot, remoteRootMenu, gitAction, sshForm, openTerminal, openRemote, remoteSaveQueue } from './ui/sessions'
import { TermSession, type TermProfile } from './ui/terminal'
import { Sidebar, type Entry } from './ui/sidebar'
import { renderTabs } from './ui/tabs'
import { THEMES, ICON_SETS, applyTheme } from './ui/theme'
import { toast, prompt, confirmDialog, contextMenu, openPalette, openSheet, type PaletteItem } from './ui/overlays'
import { setClipboardWriter } from './lib/textselect'

const ui: Record<string, any> = {}
let editor: Editor
let sidebar: Sidebar
let fileIndex: { path: string; name: string; ext: string }[] = []
let editorDocId: string | null = null
let previewDocId = ''
let previewText = ''

/** 只有文档身份/视图/正文真的变了才重建预览，避免自动保存时整块闪一下 */
function updatePreview(force = false): void {
  const doc = S.activeDoc()
  if (!doc) {
    if (previewDocId) { clear(ui.previewHost); previewDocId = ''; previewText = '' }
    return
  }
  const show = doc.view !== 'edit' || !doc.editable
  if (!show) {
    if (previewDocId) { clear(ui.previewHost); previewDocId = ''; previewText = '' }
    return
  }
  if (!force && previewDocId === doc.id && previewText === doc.text) return
  previewDocId = doc.id
  previewText = doc.text
  // 超大文档实时渲染预览会拖慢输入，改为手动触发
  if ((doc.kind === 'md' || doc.kind === 'csv') && doc.text.length > 300_000) {
    clear(ui.previewHost)
    const box = el('div', { class: 'preview-hold' },
      el('p', {}, `文档较大（${Math.round(doc.text.length / 1024)} KB），已暂停实时预览`),
      el('p', { class: 'dim' }, '继续输入不受影响，需要时点下面的按钮渲染一次'))
    const btn = el('button', { class: 'primary' }, '渲染预览')
    btn.addEventListener('click', () => {
      previewText = ''
      renderPreview(ui.previewHost, doc)
      previewText = doc.text
    })
    box.append(btn)
    ui.previewHost.append(box)
    return
  }
  renderPreview(ui.previewHost, doc)
}
let cursor = { line: 1, col: 1, selChars: 0, selLines: 0, lines: 1 }
let lockedRoot: string | null = null
let samplesPath = ''
let aiPanel: AIPanel
let browser: FileBrowser
const terminals = new Map<string, TermSession>()
const ptyCaptures = new Map<string, string>()
let termHost: HTMLElement
let remoteHost: HTMLElement
const remoteBacking = new Map<string, { profile: TermProfile; remote: string }>()
let downloadDir = ''
let downloadsRoot = ''
;(window as any).__bnbRemoteBacking = remoteBacking
let clip: { mode: 'copy' | 'cut'; path: string } | null = null

/* ============================================================
   shell
   ============================================================ */

function buildShell(): void {
  const root = document.getElementById('app')!

  const sideBtn = tbBtn('sidebar', '切换侧边栏  ⌘B', () => toggleSidebar())
  const title = el('div', { class: 'tb-title' })
  const viewSwitch = el('div', { class: 'view-switch' })
  ui.viewSwitch = viewSwitch
  const searchBtn = tbBtn('search', '全局搜索  ⌘⇧F', () => globalSearch())
  const aiBtn = tbBtn('sparkles', 'AI 助手  ⌘⇧A', () => aiPanel.toggle())
  ui.aiBtn = aiBtn
  ui.title = title
  ui.sideBtn = sideBtn

  const titlebar = el('header', { class: 'titlebar' },
    sideBtn,
    title,
    el('div', { class: 'spacer' }),
    viewSwitch,
    aiBtn,
    searchBtn
  )
  ui.titlebar = titlebar

  // 标题栏：单击拖动（移动超过 3px 才真正开始拖，避免吃掉双击），双击缩放
  let press: { x: number; y: number } | null = null
  const draggable = (target: EventTarget | null) => {
    const t = target as HTMLElement | null
    return !!t && !t.closest('button') && !t.closest('.view-switch') && !t.closest('.tb-title')
  }
  titlebar.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || !draggable(ev.target)) return
    press = { x: ev.clientX, y: ev.clientY }
  })
  window.addEventListener('mousemove', (ev) => {
    if (!press) return
    if (Math.abs(ev.clientX - press.x) < 3 && Math.abs(ev.clientY - press.y) < 3) return
    press = null
    invoke('ui.beginDrag').catch(() => {})
  })
  window.addEventListener('mouseup', () => { press = null })
  titlebar.addEventListener('dblclick', (ev) => {
    if (!draggable(ev.target)) return
    invoke('ui.zoomWindow').catch(() => {})
  })

  installCursorBridge()

  sidebar = new Sidebar()

  const resizer = el('div', { class: 'resizer' })
  ui.tabbar = el('div', { class: 'tabbar' })
  ui.editorHost = el('div', { class: 'editor-host' })
  ui.previewHost = el('div', { class: 'preview-host' })
  ui.editorPane = el('div', { class: 'pane editor-pane' }, ui.editorHost)
  ui.previewPane = el('div', { class: 'pane preview-pane' }, ui.previewHost)
  ui.emptyHost = el('div', { class: 'pane', style: { flex: '1', minHeight: '0' } })
  ui.lockHost = el('div', { class: 'lock', style: { flex: '1', display: 'none' } })

  const panes = el('div', { class: 'panes' }, ui.emptyHost, ui.editorPane, ui.previewPane, ui.lockHost)
  ui.panes = panes
  ui.statusbar = el('footer', { class: 'statusbar' })
  const workspace = el('section', { class: 'workspace' }, ui.tabbar, panes, ui.statusbar)
  const main = el('div', { class: 'main' }, sidebar.root, resizer, workspace)

  root.append(titlebar, main)

  document.documentElement.style.setProperty('--sidebar-w', `${S.state.settings.sidebarWidth}px`)
  if (!S.state.settings.sidebarVisible) sidebar.root.classList.add('collapsed')

  wireResizer(resizer)
  editor = new Editor(ui.editorHost)
  editor.onChange = (text) => {
    const doc = S.activeDoc()
    if (!doc || !doc.editable) return
    S.setText(doc, text)
    doc.checked = false
    scheduleContentUpdate()
    scheduleCheck()
    persistDraft()
  }
  editor.onCursor = (info) => {
    cursor = info
    renderStatus()
  }
  editor.setWrap(S.state.settings.lineWrap)
  aiPanel = new AIPanel({
    getDoc: () => S.activeDoc(),
    getContextText: docContextText,
    getOtherDocs: () => S.state.docs,
    copy: copyText,
    getSelection: () => editor.selectionText(),
    onReplace: (t) => { editor.replaceSelection(t); toast('已替换选中内容') },
    onInsert: (t) => { editor.insertAtCursor(t); toast('已插入到光标处') },
    getSettings: () => S.state.settings,
    openSettings
  })
  panes.append(aiPanel.el)
  browser = new FileBrowser({
    openFile: (p, n) => openFile(p, n),
    openFolderDialog: () => invoke<string | null>('ui.openFolder'),
    moveTo: (src, dir) => moveEntry(src, dir),
    copyTo: async (src, dir) => {
      const dest = await uniquePath(dir, basename(src))
      await invoke('fs.copy', { from: src, to: dest })
      sidebar.invalidate(dir)
      await sidebar.refresh()
      toast('已复制')
    },
    trash: async (p) => { await invoke('fs.trash', { path: p }); sidebar.invalidate(dirname(p)); await sidebar.refresh() },
    rename: async (p) => {
      const name = await prompt({ title: '重命名', label: '新名称', value: basename(p) })
      if (!name) return
      await invoke('fs.rename', { from: p, to: joinPath(dirname(p), name) })
      await browser.refreshAll()
      sidebar.invalidate(dirname(p))
      await sidebar.refresh()
    },
    newFolder: async (dir) => {
      const name = await prompt({ title: '新建文件夹', label: '名称' })
      if (!name) return
      await invoke('fs.mkdir', { path: joinPath(dir, name) })
      await browser.refreshAll()
    },
    reveal: (p) => invoke('ui.reveal', { path: p }),
    quickLook: (p) => invoke('office.quickLook', { path: p }),
    toast,
    menu: (x, y, items) => contextMenu(x, y, items),
    prompt,
    confirm: confirmDialog,
    onClose: () => closeBrowser()
  })
  panes.append(browser.el)
  termHost = el('div', { class: 'term-panes' })
  panes.append(termHost)
  remoteHost = el('div', { class: 'term-panes' })
  panes.append(remoteHost)

  ui.editorHost.style.setProperty('--editor-font-size', `${S.state.settings.fontSize}px`)

  for (const [mode, ic, label] of [
    ['edit', 'pencil', '编辑'],
    ['split', 'split', '对比'],
    ['preview', 'eye', '预览']
  ] as const) {
    const b = el('button', { class: 'vs-btn', title: label + '  ⌘E' })
    b.append(icon(ic))
    b.dataset.mode = mode
    b.addEventListener('click', () => {
      const d = S.activeDoc()
      if (d) S.setView(d, mode)
    })
    viewSwitch.append(b)
  }
}

function copyText(text: string, msg = '已拷贝'): void {
  invoke('ui.copy', { text }).then(() => toast(msg)).catch(() => toast('复制失败'))
}

// 文档区域（编辑器 / 预览）的复制统一走原生剪贴板，不弹 toast
setClipboardWriter((text) => { invoke('ui.copy', { text }).catch(() => {}) })

function multiMenu(paths: string[], ev: MouseEvent): void {
  contextMenu(ev.clientX, ev.clientY, [
    { label: `移到废纸篓（${paths.length} 项）`, icon: 'trash', danger: true, onClick: async () => {
      let n = 0
      for (const p of paths) {
        try { await invoke('fs.trash', { path: p }); n++ } catch {}
      }
      toast(`已删除 ${n} 项`)
      for (const p of paths) sidebar.invalidate(dirname(p))
      await sidebar.refresh()
    } },
    { label: '拷贝路径', icon: 'file', onClick: () => copyText(paths.join('\\n'), `已拷贝 ${paths.length} 条路径`) }
  ])
}

function openBrowser(path?: string): void {
  S.openBrowserTab()
  if (path) browser.show(path)
}

function closeBrowser(): void {
  S.closeBrowserTab()
}

function tbBtn(ic: string, title: string, onClick: () => void): HTMLElement {
  const b = el('button', { class: 'tb-btn', title })
  b.append(icon(ic))
  b.addEventListener('click', onClick)
  return b
}

function wireResizer(resizer: HTMLElement): void {
  resizer.addEventListener('mousedown', (ev) => {
    ev.preventDefault()
    resizer.classList.add('dragging')
    const startX = ev.clientX
    const startW = sidebar.root.getBoundingClientRect().width
    const move = (e: MouseEvent) => {
      const w = Math.min(460, Math.max(170, startW + e.clientX - startX))
      document.documentElement.style.setProperty('--sidebar-w', `${w}px`)
      S.state.settings.sidebarWidth = w
    }
    const up = () => {
      resizer.classList.remove('dragging')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      S.saveSettings()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  })
}

/* ============================================================
   rendering
   ============================================================ */

let tabSig = ''

function tabSignature(): string {
  return S.state.docs
    .map((d) => `${d.id}|${d.name}|${d.dirty ? 1 : 0}|${d.locked ? 1 : 0}|${d.issues.length}`)
    .join('~') + '#' + (S.state.activeId ?? '')
}

function renderTabsBar(): void {
  const sig = tabSignature()
  if (sig === tabSig) return
  tabSig = sig
  renderTabs(ui.tabbar, S.state.docs, S.state.activeId, {
    select: (id) => S.setActive(id),
    close: (id) => closeTab(id),
    newTab: () => newUntitled(),
    closeMenu: (id, ev) => tabMenu(id, ev),
    move: (id, beforeId) => S.moveDoc(id, beforeId)
  })
}

async function closeTab(id: string): Promise<void> {
  const ok = await S.closeDoc(id)
  if (!ok) toast('标签页已锁定，右键解锁后再关闭')
}

function syncActive(): void {
  const doc = S.activeDoc()
  renderTabsBar()
  ui.tabbar.style.display = 'flex'
  const isBrowser = doc?.kind === 'browser'
  const isTerm = doc?.kind === 'terminal'
  const isRemote = doc?.kind === 'sftp'
  if (remoteHost) {
    remoteHost.style.display = isRemote ? 'flex' : 'none'
    // 必须用 ctx.remotePanels：openRemote() 把新面板写进 ctx.remotePanels，
    // 若这里用另一个 Map，旧面板永远不会被隐藏，多个面板会在 vertical term-panes 里上下分栏。
    for (const [id, p] of ctx.remotePanels) p.el.style.display = id === doc?.id ? 'flex' : 'none'
  }
  if (isRemote) {
    if (browser?.visible()) browser.hide()
    if (termHost) termHost.style.display = 'none'
    ui.editorPane.classList.add('hidden')
    ui.previewPane.classList.add('hidden')
    ui.emptyHost.classList.add('hidden')
    ui.lockHost.style.display = 'none'
    ui.viewSwitch.style.display = 'none'
    updateTreeActive()
    renderStatus()
    renderTitle()
    return
  }
  if (termHost) {
    termHost.style.display = isTerm ? 'flex' : 'none'
    for (const [id, t] of terminals) t.el.style.display = id === doc?.id ? 'flex' : 'none'
  }
  if (isTerm) {
    if (browser?.visible()) browser.hide()
    ui.editorPane.classList.add('hidden')
    ui.previewPane.classList.add('hidden')
    ui.emptyHost.classList.add('hidden')
    ui.lockHost.style.display = 'none'
    ui.viewSwitch.style.display = 'none'
    const s = doc ? terminals.get(doc.id) : null
    s?.mount()
    setTimeout(() => s?.focus(), 30)
    updateTreeActive()
    renderStatus()
    renderTitle()
    return
  }
  if (isBrowser) {
    browser.show()
    ui.editorPane.classList.add('hidden')
    ui.previewPane.classList.add('hidden')
    ui.emptyHost.classList.add('hidden')
    ui.lockHost.style.display = 'none'
    aiPanel.el.style.display = 'none'
    ui.viewSwitch.style.display = 'none'
    updateTreeActive()
    renderStatus()
    renderTitle()
    return
  }
  if (aiPanel?.visible()) aiPanel.el.style.display = 'flex'
  if (browser?.visible()) browser.hide()

  if (!S.state.docs.length && !ui.tabbar.querySelector('.tab-hint')) {
    ui.tabbar.append(el('div', { class: 'tab-hint' }, '点击空白处新建临时文件  ⌘N'))
  }
  if (!ui.tabbar.dataset.wired) {
    ui.tabbar.dataset.wired = '1'
    ui.tabbar.addEventListener('click', (ev: MouseEvent) => {
      if (ev.target !== ui.tabbar) return
      newUntitled()
    })
  }

  if ((doc?.id ?? null) !== editorDocId) {
    editor.setDoc(doc)
    editorDocId = doc?.id ?? null
  }

  const showEditor = !!doc && doc.editable && doc.view !== 'preview'
  const showPreview = !!doc && (doc.view !== 'edit' || !doc.editable)
  const locked = !!lockedRoot

  ui.emptyHost.classList.toggle('hidden', !!doc || locked)
  ui.lockHost.style.display = locked ? 'flex' : 'none'
  ui.editorPane.classList.toggle('hidden', !showEditor || locked)
  ui.previewPane.classList.toggle('hidden', !showPreview || locked)
  ui.previewPane.classList.toggle('solo', showPreview && !showEditor)

  if (!doc && !locked) {
    const recents = S.state.settings.recent.map((p) => ({ path: p, name: basename(p) }))
    renderEmpty(ui.emptyHost, openFolder, recents, openWorkspace, samplesPath ? () => openWorkspace(samplesPath) : undefined)
    clear(ui.previewHost)
  }

  if (doc && !locked) updatePreview()

  const canSwitch = !!doc && doc.editable
  ui.viewSwitch.style.display = canSwitch ? 'flex' : 'none'
  for (const b of Array.from(ui.viewSwitch.children) as HTMLElement[]) {
    b.classList.toggle('active', !!doc && b.dataset.mode === doc.view)
  }

  if (doc) editor.setIssues(doc.path, doc.issues)
  updateTreeActive()
  renderStatus()
  renderTitle()
  aiPanel?.sync()
}

function tabMenu(id: string, ev: MouseEvent): void {
  const idx = S.state.docs.findIndex((d) => d.id === id)
  const doc = S.state.docs[idx]
  if (!doc) return
  const termSession = ctx.terminals.get(doc.id)
  const remotePanel = ctx.remotePanels.get(doc.id)
  const dup: any[] = []
  if (termSession) {
    dup.push({ label: '复制标签页（新会话）', icon: 'copy', onClick: () => openTerminal(termSession.profile) })
  } else if (remotePanel) {
    dup.push({ label: '复制标签页', icon: 'copy', onClick: () => openRemote(remotePanel.profile) })
  }

  contextMenu(ev.clientX, ev.clientY, [
    doc.locked
      ? { label: '解锁标签页', icon: 'unlock', onClick: () => { doc.locked = false; S.setActive(doc.id) } }
      : { label: '锁定标签页', icon: 'lock', onClick: () => { doc.locked = true; S.setActive(doc.id) } },
    ...dup,
    ...(dup.length ? [{ sep: true }] : []),
    { label: '关闭', icon: 'close', sub: '⌘W', onClick: () => closeTab(id) },
    { label: '关闭其他', onClick: () => closeOthers(id) },
    { label: '关闭右侧所有标签', onClick: () => closeRight(id) },
    { sep: true },
    ...(doc.path ? [] : [{ label: '保存…', icon: 'check', sub: '⌘S', onClick: () => saveAsDoc(doc) }]),
    {
      label: '拷贝路径',
      icon: 'copy',
      onClick: () => copyText(doc.path, '已拷贝路径')
    },
    {
      label: '拷贝文件名',
      onClick: () => copyText(doc.name, '已拷贝文件名')
    },
    {
      label: '在 Finder 中显示',
      icon: 'external',
      onClick: () => invoke('ui.reveal', { path: doc.path })
    }
  ])
}

function closeOthers(id: string): void {
  for (const d of S.state.docs.slice()) if (d.id !== id) S.closeDoc(d.id)
}

function closeRight(id: string): void {
  const idx = S.state.docs.findIndex((d) => d.id === id)
  if (idx < 0) return
  const victims = S.state.docs.slice(idx + 1).map((d) => d.id)
  for (const v of victims) S.closeDoc(v)
}

const persistDraft = debounce(() => {
  const d0 = S.activeDoc()
  if (d0 && d0.text.length > 300_000) return   // 大文件不写草稿，避免重复整份落盘
  const d = S.activeDoc()
  if (!d || !d.editable || !d.dirty || !d.path) return
  invoke('drafts.put', { path: d.path, name: d.name, text: d.text }).catch(() => {})
}, 1500)

let bigSaveTimer: any = null

const scheduleContentUpdate = debounce(() => {
  const doc = S.activeDoc()
  if (!doc) return
  if (S.state.settings.autoSave) {
    if (doc.path.startsWith('ssh://')) remoteSaveQueue(doc)
    else if (doc.text.length > 300_000) {
      // 大文件延迟写盘，避免每次停顿都序列化整份内容
      clearTimeout(bigSaveTimer)
      bigSaveTimer = setTimeout(() => S.saveDoc(doc).catch(() => {}), 1500)
    } else S.saveDoc(doc).catch(() => {})
  }
  updatePreview()
  renderStatus()
}, 280)

const scheduleCheck = debounce(() => {
  const doc = S.activeDoc()
  if (doc) runCheck(doc)
}, 1200)

async function runCheck(doc: Doc): Promise<void> {
  if (!doc.editable) return
  if (doc.ext === 'json') {
    const err = checkJSON(doc.text)
    applyIssues(doc, err ? [{ line: err.line, message: `${err.message}（第 ${err.line} 行第 ${err.col} 列）`, severity: 'error' }] : [])
    return
  }
  if (!['sh', 'bash', 'zsh', 'py', 'js', 'mjs', 'cjs'].includes(doc.ext)) return
  try {
    const res = await invoke<{ line: number; message: string; severity: string }[]>('fs.check', {
      path: doc.path,
      text: doc.text
    })
    applyIssues(doc, (res ?? []).map((r) => ({ line: r.line, message: r.message, severity: r.severity ?? 'error' })))
  } catch {}
}

function applyIssues(doc: Doc, issues: S.Issue[]): void {
  doc.issues = issues
  doc.checked = true
  if (S.state.activeId === doc.id) editor.setIssues(doc.path, issues)
  S.emit('docs')
}

function renderStatus(): void {
  const bar = ui.statusbar
  if (!bar) return
  clear(bar)
  const doc = S.activeDoc()
  const left = el('div', { class: 'chip' })
  if (doc) {
    const root = S.rootOf(doc.path)
    const rel = !doc.path ? '未命名（未保存）' : root ? doc.path.slice(root.length + 1) : doc.path
    left.append(el('span', {}, rel))
    left.append(el('span', { class: 'dim' }, `·  ${humanSize(doc.size)}`))
    if (doc.path.startsWith('ssh://')) {
      const tag = el('span', { class: 'err-chip' }, '·  远端')
      tag.style.color = 'var(--accent)'
      left.append(tag)
    }
    if (doc.issues.length) {
      left.append(el('span', { class: 'err-chip' }, `·  ${doc.issues.length} 个语法问题`))
    }
  } else if (S.state.roots.length) {
    left.append(el('span', {}, `${S.state.roots.length} 个工作区`))
  } else {
    left.append(el('span', {}, '未打开工作区'))
  }
  bar.append(left, el('div', { class: 'spacer' }))
  if (doc) {
    if (doc.editable) {
      bar.append(
        chip(`行 ${cursor.line} : 列 ${cursor.col}`),
        chip(`共 ${cursor.lines} 行`),
        cursor.selChars > 0 ? chip(`已选 ${cursor.selChars} 字符 / ${cursor.selLines} 行`) : el('span'),
        chip(`${doc.text.length.toLocaleString()} 字符`)
      )
    }
    bar.append(
      chip(doc.ext ? doc.ext.toUpperCase() : 'TXT'),
      chip(doc.encrypted ? '🔒 已加密' : 'UTF-8')
    )
  }
}

function chip(text: string): HTMLElement {
  return el('div', { class: 'chip' }, text)
}

function renderTitle(): void {
  const doc = S.activeDoc()
  const rootName = S.state.roots.length ? basename(S.state.roots[0]) : ''
  clear(ui.title)
  if (!rootName && !doc) ui.title.append(el('span', {}, 'SuperWorkStation'))
  if (rootName) {
    ui.title.append(el('span', {}, rootName))
    if (S.state.roots.length > 1) ui.title.append(el('span', { class: 'dim' }, ` +${S.state.roots.length - 1}`))
  }
  if (doc) {
    if (rootName) ui.title.append(el('span', { class: 'dim' }, '  ›  '))
    ui.title.append(el('span', { class: 'dim' }, doc.name))
  }
  document.title = doc ? `${doc.name} — SuperWorkStation` : 'SuperWorkStation'
  invoke('ui.setTitle', { title: doc ? `${doc.name} — SuperWorkStation` : 'SuperWorkStation' }).catch(() => {})
}

function updateTreeActive(): void {
  for (const r of Array.from(sidebar.root.querySelectorAll('.tree-row.active'))) r.classList.remove('active')
  if (S.state.activeId) {
    const row = sidebar.root.querySelector(`.tree-row[data-path="${CSS.escape(S.state.activeId)}"]`)
    row?.classList.add('active')
  }
}

/* ============================================================
   workspace
   ============================================================ */

async function openFolder(): Promise<void> {
  try {
    const path = await invoke<string | null>('ui.openFolder')
    if (path) await openWorkspace(path)
  } catch (err: any) {
    toast(err.message)
  }
}

async function openWorkspace(path: string): Promise<void> {
  await allowRoot(path)
  if (!S.state.roots.includes(path)) {
    const exists = await invoke('fs.exists', { path }).catch(() => false)
    if (!exists) { toast('目录不存在'); return }
    S.state.roots.push(path)
    S.state.expanded.add(path)
    S.state.settings.roots = S.state.roots.slice()
    S.state.settings.recent = [path, ...S.state.settings.recent.filter((p) => p !== path)].slice(0, 8)
    S.saveSettings()
    // 新加的本地目录要在「本地」tab 里才看得见
    sidebar.showTab('local')
  }
  const vault = await invoke<{ isVault: boolean; unlocked: boolean }>('vault.status', { path }).catch(() => ({ isVault: false, unlocked: true }))
  if (vault.isVault) {
    S.state.vaults.set(path, vault.unlocked)
    if (!vault.unlocked) {
      lockedRoot = path
      showLockScreen(path)
    }
  }
  await invoke('fs.watch', { root: path }).catch(() => {})
  fileIndex = []
  S.emit('root')
  S.emit('active')
  renderTitle()
}

async function removeRoot(root: string): Promise<void> {
  for (const d of S.state.docs.slice()) {
    if (d.path === root || d.path.startsWith(root + '/')) await S.closeDoc(d.id)
  }
  S.state.roots = S.state.roots.filter((r) => r !== root)
  S.state.settings.roots = S.state.roots.slice()
  S.saveSettings()
  if (lockedRoot === root) lockedRoot = null
  S.emit('root')
  S.emit('active')
  toast(`已移除 ${basename(root)}`)
}

function showLockScreen(path: string): void {
  const host = ui.lockHost
  clear(host)
  const ic = el('div', { class: 'lock-ic' })
  ic.append(icon('lock'))
  host.append(ic)
  host.append(el('h2', {}, `${basename(path)} 已加密`))
  host.append(el('p', {}, '输入密码以解锁此文件夹'))
  const btn = el('button', { class: 'primary' }, '解锁')
  btn.addEventListener('click', async () => {
    const ok = await unlockVault(path)
    if (ok) {
      lockedRoot = null
      S.emit('active')
      S.emit('root')
    }
  })
  host.append(btn)
  host.style.display = 'flex'
}

async function unlockVault(path: string): Promise<boolean> {
  const pw = await prompt({ title: '解锁文件夹', label: basename(path), password: true, placeholder: '输入密码', confirmText: '解锁' })
  if (pw === null) return false
  try {
    await invoke('vault.unlock', { path, password: pw })
    S.state.vaults.set(path, true)
    S.state.expanded.add(path)
    toast('已解锁')
    await sidebar.refresh()
    return true
  } catch (err: any) {
    toast(err.message || '解锁失败')
    return false
  }
}

/* ============================================================
   keyboard
   ============================================================ */

function cycleTab(dir: number): void {
  const docs = S.state.docs
  if (docs.length < 2) return
  const idx = docs.findIndex((d) => d.id === S.state.activeId)
  const next = idx < 0
    ? (dir > 0 ? 0 : docs.length - 1)
    : (idx + dir + docs.length) % docs.length
  S.setActive(docs[next].id)
}

function installKeys(): void {
  window.addEventListener('keydown', (ev) => {
    // Ctrl+Tab / Ctrl+Shift+Tab：在当前标签里循环
    if (ev.ctrlKey && !ev.metaKey && (ev.key === 'Tab' || ev.code === 'Tab')) {
      ev.preventDefault()
      ev.stopPropagation()
      cycleTab(ev.shiftKey ? -1 : 1)
      return
    }
    if (!ev.metaKey || ev.ctrlKey) return
    const k = ev.key.toLowerCase()
    const stop = () => { ev.preventDefault(); ev.stopPropagation() }

    if (k === 's') {
      stop()
      editor.flush()
      const d = S.activeDoc()
      if (!d) return
      if (ev.shiftKey || !d.path) saveAsDoc(d).then((ok) => { if (ok) runCheck(d) })
      else S.saveDoc(d).then(() => { toast('已保存'); runCheck(d) }).catch((e) => toast(e.message))
    }
    else if (k === 'o') { stop(); openFolder() }
    else if (k === 'p') { stop(); quickOpen() }
    else if (k === 'k') { stop(); commandPalette() }
    else if (k === 'f' && ev.shiftKey) { stop(); globalSearch() }
    else if (k === 'f') {
      stop()
      const d = S.activeDoc()
      if (d?.kind === 'terminal') {
        terminals.get(d.id)?.showSearch()
        return
      }
      if (d?.editable) {
        if (d.view === 'preview') S.setView(d, 'split')
        setTimeout(() => editor.openSearch(), 30)
      } else {
        globalSearch()
      }
    }
    else if (k === 'a' && ev.shiftKey) { stop(); aiPanel.toggle() }
    else if (k === ',') { stop(); openSettings() }
    else if (k === 'e') { stop(); cycleView() }
    else if (k === 't' && ev.shiftKey) {
      stop()
      openTerminal({ id: 'local', name: '终端', kind: 'local' })
    }
    else if (k === 'b' && ev.shiftKey) {
      stop()
      if (S.activeDoc()?.kind === 'browser') closeBrowser()
      else openBrowser()
    }
    else if (k === '\\') {
      stop()
      if (S.activeDoc()?.kind !== 'browser') openBrowser()
      else browser.toggleLayout()
    }
    else if (k === 'b') { stop(); toggleSidebar() }
    else if (k === 'w') { stop(); if (S.state.activeId) void closeTab(S.state.activeId) }
    else if (k === 'n') { stop(); newUntitled() }
    else if (k === '=' || k === '+') { stop(); zoom(1) }
    else if (k === '-') { stop(); zoom(-1) }
    else if (k === '0') { stop(); zoom(0) }
    else if (k === 'r') { stop(); if (S.state.roots.length) { sidebar.invalidate(); sidebar.refresh() } }
  }, true)
}

function zoom(dir: number): void {
  const s = S.state.settings
  s.fontSize = dir === 0 ? 13 : Math.min(24, Math.max(9, s.fontSize + dir))
  document.documentElement.style.setProperty('--editor-font-size', `${s.fontSize}px`)
  ui.editorHost.style.setProperty('--editor-font-size', `${s.fontSize}px`)
  S.saveSettings()
  toast(`字号 ${s.fontSize}px`, 900)
}

function toggleSidebar(): void {
  const s = S.state.settings
  s.sidebarVisible = !s.sidebarVisible
  sidebar.root.classList.toggle('collapsed', !s.sidebarVisible)
  ui.sideBtn.classList.toggle('active', s.sidebarVisible)
  S.saveSettings()
}

function cycleView(): void {
  const doc = S.activeDoc()
  if (!doc || !doc.editable) return
  S.cycleView(doc)
  if (doc.view !== 'preview') setTimeout(() => editor.focus(), 30)
}

/* ============================================================
   commands & settings
   ============================================================ */

function commandPalette(): void {
  const items: PaletteItem[] = [
    { id: 'open-folder', label: '添加文件夹…', icon: 'folder-plus', sub: '⌘O', run: openFolder },
    { id: 'quick-open', label: '快速打开文件…', icon: 'search', sub: '⌘P', run: quickOpen },
    { id: 'search', label: '在文件夹中搜索…', icon: 'search', sub: '⇧⌘F', run: globalSearch },
    { id: 'new-file', label: '新建文件', icon: 'file-plus', sub: '⌘N', run: () => newFile(S.state.roots[0] ?? '') },
    { id: 'new-folder', label: '新建文件夹', icon: 'folder-plus', run: () => newFolder(S.state.roots[0] ?? '') },
    { id: 'save', label: '保存文件', icon: 'check', sub: '⌘S', run: () => { const d = S.activeDoc(); if (d) (d.path ? S.saveDoc(d) : saveAsDoc(d)) } },
    { id: 'history', label: '历史版本…', icon: 'refresh', run: showHistory },
    { id: 'save-as', label: '另存为…', icon: 'check', sub: '⇧⌘S', run: () => { const d = S.activeDoc(); if (d) saveAsDoc(d) } },
    { id: 'new-untitled', label: '新建临时文件', icon: 'file-plus', run: newUntitled },
    { id: 'theme', label: '切换主题…', icon: 'contrast', run: themePalette },
    { id: 'settings', label: '设置…', icon: 'settings', sub: '⌘,', run: openSettings },
    { id: 'shortcuts', label: '快捷键一览…', icon: 'command', run: openShortcuts },
    { id: 'newterm', label: '新建本地终端', icon: 'terminal', sub: '⌘⇧T',
      run: () => openTerminal({ id: 'local', name: '终端', kind: 'local' }) },
    { id: 'school', label: '连接 SSH 会话…', icon: 'external', run: () => openTerminalMenuAtCenter() },
    { id: 'quick-commands', label: '快速命令…', icon: 'command', run: openQuickCommandManager },
    { id: 'browse', label: '文件管理：打开 / 关闭', icon: 'folder-open', sub: '⌘⇧B',
      run: () => { if (S.activeDoc()?.kind === 'browser') closeBrowser(); else openBrowser() } },
    { id: 'cycle-view', label: '切换 编辑 / 对比 / 预览', icon: 'split', sub: '⌘E', run: cycleView },
    { id: 'toggle-sidebar', label: '显示 / 隐藏侧边栏', icon: 'sidebar', sub: '⌘B', run: toggleSidebar },
    { id: 'check', label: '检查当前文件语法', icon: 'check', run: () => { const d = S.activeDoc(); if (d) runCheck(d).then(() => toast(d.issues.length ? `发现 ${d.issues.length} 个问题` : '未发现语法问题')) } },
    { id: 'reveal', label: '在 Finder 中显示当前文件', icon: 'external', run: () => { const d = S.activeDoc(); if (d) invoke('ui.reveal', { path: d.path }) } },
    { id: 'encrypt', label: '加密当前文件夹…', icon: 'lock', run: () => S.state.roots[0] && encryptFolder(S.state.roots[0]) },
    { id: 'close-tab', label: '关闭当前标签页', icon: 'close', sub: '⌘W', run: () => S.state.activeId && S.closeDoc(S.state.activeId) },
    { id: 'zoom-in', label: '放大字号', icon: 'plus', sub: '⌘+', run: () => zoom(1) },
    { id: 'zoom-out', label: '缩小字号', icon: 'minus', sub: '⌘-', run: () => zoom(-1) }
  ]
  openPalette({ placeholder: '输入命令…', items, emptyText: '没有匹配的命令' })
}


async function quickOpen(): Promise<void> {
  if (!S.state.roots.length) { openFolder(); return }
  if (!fileIndex.length) {
    const all: { path: string; name: string; ext: string }[] = []
    for (const root of S.state.roots) {
      const list = await invoke<{ path: string; name: string; ext: string }[]>('fs.index', { path: root }).catch(() => [])
      all.push(...list)
    }
    fileIndex = all
  }
  const items: PaletteItem[] = fileIndex.map((f) => {
    const root = S.rootOf(f.path) ?? ''
    return {
      id: f.path,
      label: f.name,
      sub: f.path.slice(root.length + 1),
      icon: 'file',
      run: () => openFile(f.path, f.name)
    }
  })
  openPalette({ placeholder: '跳转到文件…', items, emptyText: '没有找到文件' })
}

function globalSearch(): void {
  if (!S.state.roots.length) { openFolder(); return }
  const input = el('input', { type: 'text', placeholder: '搜索文件名与内容…', spellcheck: 'false' })
  const list = el('div', { class: 'list' })
  const stat = el('div', { class: 'empty-row' }, '输入关键词开始搜索')

  const flags = { caseSensitive: false, wholeWord: false }
  const btnCase = el('button', { class: 'opt-btn', title: '区分大小写' }, 'Aa')
  const btnWord = el('button', { class: 'opt-btn', title: '全词匹配' }, '全词')
  const optBar = el('div', { class: 'search-opts' }, el('span', { class: 'opt-label' }, '匹配：'), btnCase, btnWord)

  const panel = el('div', { class: 'palette' }, input, optBar, list)
  const scrim = el('div', { class: 'scrim', style: { alignItems: 'flex-start' } }, panel)
  document.body.append(scrim)

  let hits: any[] = []
  let sel = 0
  let searchToken = 0

  const openHit = (hit: any) => {
    close()
    openFile(hit.path, hit.name).then(() => {
      if (hit.kind === 'content' && hit.line > 1) editor.scrollToLine(hit.line)
    })
  }

  const render = () => {
    clear(list)
    if (!hits.length) { list.append(stat); return }
    hits.forEach((hit, i) => {
      const row = el('div', { class: 'search-hit' + (i === sel ? ' sel' : '') })
      const top = el('div', { class: 'top' })
      const ic = el('div', { class: 'ic' })
      ic.append(icon(hit.kind === 'name' ? 'file' : 'search'))
      const root = S.rootOf(hit.path) ?? ''
      top.append(ic, el('span', {}, hit.name))
      if (hit.kind === 'name') top.append(el('span', { class: 'ln' }, '文件名'))
      else top.append(el('span', { class: 'ln' }, `:${hit.line}`))
      top.append(el('span', { class: 'pth', style: { marginLeft: 'auto', color: 'var(--fg-3)', fontSize: '10.5px' } },
        hit.path.slice(root.length + 1).replace(/\/[^/]+$/, '')))
      const pv = el('div', { class: 'pv' })
      if (hit.kind === 'name') {
        pv.textContent = hit.path.split('/').slice(-2, -1)[0] || ''
      } else {
        const q = input.value
        const hay = flags.caseSensitive ? hit.preview : hit.preview.toLowerCase()
        const needle = flags.caseSensitive ? q : q.toLowerCase()
        const idx = hay.indexOf(needle)
        if (idx >= 0 && q) {
          pv.append(el('span', {}, hit.preview.slice(0, idx)),
            el('mark', {}, hit.preview.slice(idx, idx + q.length)),
            el('span', {}, hit.preview.slice(idx + q.length)))
        } else {
          pv.textContent = hit.preview
        }
      }
      row.append(top, pv)
      row.addEventListener('mousemove', () => { sel = i; render() })
      row.addEventListener('click', () => openHit(hit))
      list.append(row)
    })
    list.children[sel]?.scrollIntoView({ block: 'nearest' })
  }

  const collect = async (namesOnly: boolean, budget: number) => {
    const q = input.value.trim()
    const all: any[] = []
    for (const root of S.state.roots) {
      const res = await invoke<any[]>('fs.search', {
        root, query: q, limit: namesOnly ? 60 : 200,
        caseSensitive: flags.caseSensitive, wholeWord: flags.wholeWord,
        namesOnly, budget
      }).catch(() => [])
      all.push(...res)
    }
    return all
  }

  const run = debounce(async () => {
    const q = input.value.trim()
    if (q.length < 1) { hits = []; stat.textContent = '输入关键词开始搜索'; render(); return }
    const token = ++searchToken
    stat.textContent = '搜索中…'

    // 第一轮：只匹配文件名，秒回
    const nameHits = (await collect(true, 3)).filter((h) => h.kind === 'name')
    if (token !== searchToken) return
    hits = nameHits
    if (hits.length) { stat.textContent = `文件名匹配 ${hits.length} 条，正在搜索内容…`; render() }

    // 第二轮：全文匹配
    const all = await collect(false, 8)
    if (token !== searchToken) return
    const merged: any[] = []
    const seen = new Set<string>()
    for (const h of all) {
      const key = h.path + '|' + h.line
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(h)
    }
    merged.sort((a, b) => (a.kind === 'name' ? -1 : b.kind === 'name' ? 1 : 0))
    hits = merged.slice(0, 400)
    if (!hits.length) stat.textContent = `没有找到「${q}」`
    else {
      const names = hits.filter((h) => h.kind === 'name').length
      stat.textContent = `共 ${hits.length} 条（文件名 ${names}，内容 ${hits.length - names}）`
    }
    sel = 0
    render()
  }, 240)

  const close = () => {
    scrim.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close() }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(sel + 1, hits.length - 1); render() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(sel - 1, 0); render() }
    else if (ev.key === 'Enter') { ev.preventDefault(); if (hits[sel]) openHit(hits[sel]) }
  }
  input.addEventListener('input', run)
  document.addEventListener('keydown', onKey, true)
  scrim.addEventListener('mousedown', (ev) => { if (ev.target === scrim) close() })
  render()
  setTimeout(() => input.focus(), 20)
}

/* ============================================================
   file operations
   ============================================================ */

const ARCHIVE_RE = /\.(zip|tar|tar\.gz|tgz|tbz2|bz2|xz|zst)$/i

async function showHistory(): Promise<void> {
  const d = S.activeDoc()
  if (!d || !d.path) { toast('先打开一个已保存的文件'); return }
  let list: { id: string; ts: number; size: number }[] = []
  try { list = await invoke('history.list', { path: d.path }) } catch {}
  if (!list.length) { toast('这个文件还没有历史版本'); return }
  openPalette({
    placeholder: '选择历史版本…',
    items: list.map((v) => ({
      id: v.id,
      label: new Date(v.ts * 1000).toLocaleString(),
      sub: `${Math.max(1, Math.round(v.size / 1024))} KB`,
      icon: 'refresh',
      run: async () => {
        const text = await invoke<string | null>('history.read', { path: d.path, id: v.id })
        if (typeof text !== 'string') { toast('无法读取该版本'); return }
        const tmp = S.createUntitled(1)
        tmp.name = `${d.name} @ ${new Date(v.ts * 1000).toLocaleString()}`
        tmp.text = text
        tmp.saved = ''
        tmp.dirty = true
        editor.setDoc(tmp)
        S.emit('docs')
        toast('历史版本已打开为临时文件，可另存为新文件')
      }
    }))
  })
}

async function offerDraftRecovery(): Promise<void> {
  let list: { path: string; name: string; at: number; preview: string }[] = []
  try { list = await invoke('drafts.list') } catch { return }
  if (!list?.length) return
  const names = list.slice(0, 8).map((d) => `· ${d.name || d.path}`).join('\n')
  const ok = await confirmDialog('发现未保存的草稿', `上次可能没有正常退出，以下内容尚未保存：\n\n${names}\n\n是否恢复？`)
  if (!ok) {
    for (const d of list) await invoke('drafts.drop', { path: d.path }).catch(() => {})
    return
  }
  let restored = 0
  for (const d of list) {
    try {
      const doc = await S.openPath(d.path, { activate: false })
      const text = await invoke<string | null>('drafts.read', { path: d.path })
      if (typeof text === 'string') {
        doc.text = text
        doc.dirty = text !== doc.saved
        editor.forget(doc.id)
        restored++
      }
    } catch {}
  }
  S.emit('docs')
  S.emit('active')
  if (restored) toast(`已恢复 ${restored} 个草稿`)
}

const contextCache = new Map<string, string>()

async function docContextText(doc: Doc): Promise<string> {
  if (doc.text) return doc.text
  const cached = contextCache.get(doc.path)
  if (cached !== undefined) return cached
  if (!doc.path) return ''
  try {
    const res = await invoke<{ text: string }>('fs.textOf', { path: doc.path })
    const text = res?.text ?? ''
    contextCache.set(doc.path, text)
    return text
  } catch {
    return ''
  }
}

/** 让 webview 能读取这个目录（html 预览需要引用同目录资源）。
 *  必须等它真的生效再渲染，否则 iframe 可能先发请求被 403，页面就白屏且不会重试。 */
function allowRoot(path: string): Promise<void> {
  if (!path) return Promise.resolve()
  return invoke('app.allowRoot', { path }).then(() => {}).catch(() => {})
}

async function saveAsDoc(doc: Doc): Promise<boolean> {
  const suggested = doc.path ? doc.name : '未命名.md'
  const path = await invoke<string | null>('ui.savePanel', { name: suggested })
  if (!path) return false
  await allowRoot(dirname(path))
  try {
    await invoke('fs.write', { path, text: doc.text })
  } catch (err: any) {
    toast(err.message || '保存失败')
    return false
  }
  const oldId = doc.id
  editor.forget(oldId)
  doc.path = path
  doc.id = path
  doc.name = basename(path)
  doc.ext = extname(path)
  doc.kind = detectKind(doc.ext)
  doc.editable = isEditable(doc.kind)
  doc.saved = doc.text
  doc.dirty = false
  doc.size = doc.text.length
  if (S.state.activeId === oldId) S.state.activeId = path
  sidebar.invalidate(dirname(path))
  await sidebar.refresh()
  S.emit('docs')
  S.emit('active')
  toast('已保存')
  return true
}

function newUntitled(): void {
  const n = S.state.docs.filter((d) => !d.path).length + 1
  S.createUntitled(n)
  setTimeout(() => editor.focus(), 30)
}

async function openFile(path: string, name?: string, retry = true): Promise<void> {
  if (path && !path.startsWith('ssh://')) await allowRoot(dirname(path))
  const display = name ?? basename(path)
  if (ARCHIVE_RE.test(display)) { await offerExtract(path); return }
  try {
    const doc = await S.openPath(path, { name })
    if (doc.editable) setTimeout(() => editor.focus(), 30)
  } catch (err: any) {
    const msg = String(err?.message ?? '')
    if (retry && msg.includes('已加密')) {
      const root = await invoke<string | null>('vault.findRoot', { path }).catch(() => null)
      if (root) {
        if (await unlockVault(root)) return openFile(path, name, false)
      } else if (path.endsWith('.bnenc')) {
        const pw = await prompt({ title: '解锁文件', label: basename(path), password: true, confirmText: '解锁' })
        if (pw !== null) {
          try {
            await invoke('vault.unlockFile', { path, password: pw })
            return openFile(path, name, false)
          } catch (e: any) {
            toast(e.message || '密码错误')
            return
          }
        }
      }
    }
    toast(msg || '无法打开文件')
  }
}

async function offerExtract(path: string): Promise<void> {
  const base = basename(path).replace(ARCHIVE_RE, '')
  const ok = await confirmDialog('解压压缩包？', `将把「${basename(path)}」解压到同目录下的「${base}」文件夹。`)
  if (!ok) return
  try {
    const res = await invoke<{ dir: string }>('fs.unzip', { path })
    sidebar.invalidate(dirname(path))
    await sidebar.refresh()
    toast(`已解压到 ${basename(res.dir)}`)
  } catch (err: any) {
    toast(err.message || '解压失败')
  }
}

async function newFile(dir: string): Promise<void> {
  if (!dir) { await openFolder(); return }
  const name = await prompt({ title: '新建文件', label: '文件名', placeholder: 'untitled.md', value: 'untitled.md' })
  if (!name) return
  const path = joinPath(dir, name)
  try {
    await invoke('fs.create', { path })
    sidebar.invalidate(dir)
    S.state.expanded.add(dir)
    await sidebar.refresh()
    await openFile(path, name)
    setTimeout(() => editor.focus(), 50)
  } catch (err: any) {
    toast(err.message)
  }
}

async function newFolder(dir: string): Promise<void> {
  if (!dir) { await openFolder(); return }
  const name = await prompt({ title: '新建文件夹', label: '文件夹名', placeholder: 'notes' })
  if (!name) return
  try {
    await invoke('fs.mkdir', { path: joinPath(dir, name) })
    sidebar.invalidate(dir)
    S.state.expanded.add(dir)
    await sidebar.refresh()
  } catch (err: any) {
    toast(err.message)
  }
}

async function renameEntry(entry: Entry): Promise<void> {
  const name = await prompt({ title: '重命名', label: '新名称', value: entry.displayName })
  if (!name || name === entry.displayName) return
  const to = joinPath(dirname(entry.path), name + (entry.encrypted ? '.bnenc' : ''))
  try {
    await invoke('fs.rename', { from: entry.path, to })
    const doc = S.state.docs.find((d) => d.path === entry.path)
    if (doc) {
      editor.forget(doc.id)
      doc.path = to
      doc.id = to
      doc.name = name
      doc.ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : ''
      S.setActive(to)
    }
    sidebar.invalidate(dirname(entry.path))
    await sidebar.refresh()
  } catch (err: any) {
    toast(err.message)
  }
}

async function deleteEntry(entry: Entry): Promise<void> {
  const ok = await confirmDialog('移到废纸篓？', `「${entry.displayName}」将被移入废纸篓。`, true)
  if (!ok) return
  try {
    await invoke('fs.trash', { path: entry.path })
    for (const d of S.state.docs.slice()) {
      if (d.path === entry.path || d.path.startsWith(entry.path + '/')) S.closeDoc(d.id)
    }
    sidebar.invalidate(dirname(entry.path))
    await sidebar.refresh()
  } catch (err: any) {
    toast(err.message)
  }
}

async function encryptFolder(dir: string): Promise<void> {
  if (!dir) return
  const ok = await confirmDialog(
    '加密此文件夹？',
    '文件夹内的所有文件会以 AES-256-GCM 加密（扩展名变为 .bnenc），原文件将被删除。\n\n密码不会保存在任何地方，忘记密码将无法恢复数据。'
  )
  if (!ok) return
  const pw = await prompt({ title: '设置密码', label: '密码', password: true, note: '至少 4 位，请务必牢记' })
  if (!pw) return
  const pw2 = await prompt({ title: '确认密码', password: true })
  if (pw2 !== pw) { toast('两次密码不一致'); return }
  try {
    await invoke('vault.create', { path: dir, password: pw, convert: true })
    S.state.vaults.set(dir, false)
    S.state.expanded.delete(dir)
    for (const d of S.state.docs.filter((x) => x.path.startsWith(dir + '/') || x.path === dir)) await S.closeDoc(d.id)
    sidebar.invalidate()
    await sidebar.refresh()
    if (lockedRoot === dir) lockedRoot = null
    S.emit('active')
    toast('已加密并锁定')
  } catch (err: any) {
    toast(err.message)
  }
}

async function removeVaultEncryption(dir: string): Promise<void> {
  const ok = await confirmDialog(
    '解除这个目录的加密？',
    '目录里所有 .bnenc 文件都会被解密还原成普通文件，加密标记随之删除。\n\n这会真正移除保护，不可撤销。'
  )
  if (!ok) return
  const pw = await prompt({ title: '输入密码', label: basename(dir), password: true, confirmText: '解除加密' })
  if (!pw) return
  toast('正在解密，文件较多时请稍候…', 3000)
  try {
    await invoke('vault.remove', { path: dir, password: pw })
    S.state.vaults.delete(dir)
    S.state.expanded.delete(dir)
    sidebar.invalidate()
    await sidebar.refresh()
    toast('已解除加密，目录恢复为普通文件夹')
  } catch (err: any) {
    toast(err.message || '解除失败')
  }
}

async function removeFileEncryption(entry: Entry): Promise<void> {
  const ok = await confirmDialog('解除此文件的加密？', `「${entry.displayName}」会还原成普通文件，保护随之移除。`, true)
  if (!ok) return
  const pw = await prompt({ title: '输入密码', password: true, confirmText: '解除加密' })
  if (!pw) return
  try {
    const res = await invoke<{ path: string }>('vault.decryptFile', { path: entry.path, password: pw })
    sidebar.invalidate(dirname(entry.path))
    await sidebar.refresh()
    toast('已还原为普通文件')
    if (res?.path) await openFile(res.path)
  } catch (err: any) {
    toast(err.message || '解除失败')
  }
}

async function encryptFile(entry: Entry): Promise<void> {
  const ok = await confirmDialog('加密此文件？', `「${entry.displayName}」将被单独加密为 .bnenc 文件，原文件删除。\n\n密码丢失将无法恢复。`)
  if (!ok) return
  const pw = await prompt({ title: '设置密码', label: '密码', password: true, note: '至少 4 位，请务必牢记' })
  if (!pw) return
  const pw2 = await prompt({ title: '确认密码', password: true })
  if (pw2 !== pw) { toast('两次密码不一致'); return }
  try {
    const res = await invoke<{ path: string }>('vault.encryptFile', { path: entry.path, password: pw })
    sidebar.invalidate(dirname(entry.path))
    await sidebar.refresh()
    toast('已加密')
    if (res?.path) await openFile(res.path)
  } catch (err: any) {
    toast(err.message)
  }
}

async function unlockFile(entry: Entry): Promise<void> {
  const pw = await prompt({ title: '解锁文件', label: entry.displayName, password: true, confirmText: '解锁' })
  if (pw === null) return
  try {
    await invoke('vault.unlockFile', { path: entry.path, password: pw })
    toast('已解锁')
    await openFile(entry.path, entry.displayName, false)
  } catch (err: any) {
    toast(err.message || '密码错误')
  }
}

async function lockVault(dir: string): Promise<void> {
  try {
    await invoke('vault.lock', { path: dir })
    S.state.vaults.set(dir, false)
    for (const d of S.state.docs.filter((x) => x.path.startsWith(dir + '/') || x.path === dir)) S.closeDoc(d.id)
    lockedRoot = S.state.roots.includes(dir) ? dir : null
    if (lockedRoot) showLockScreen(dir)
    S.emit('root')
    S.emit('active')
    toast('已锁定')
  } catch (err: any) {
    toast(err.message)
  }
}

/* ---------- copy / cut / paste ---------- */

async function uniquePath(dir: string, name: string): Promise<string> {
  let candidate = joinPath(dir, name)
  if (!(await invoke<boolean>('fs.exists', { path: candidate }).catch(() => false))) return candidate
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 200; i++) {
    candidate = joinPath(dir, `${stem} 副本${i > 1 ? ' ' + i : ''}${ext}`)
    if (!(await invoke<boolean>('fs.exists', { path: candidate }).catch(() => false))) return candidate
  }
  return joinPath(dir, `${stem} 副本 ${Date.now()}${ext}`)
}

async function pasteInto(dir: string): Promise<void> {
  if (!clip) { toast('剪贴板为空'); return }
  const moved = clip.mode === 'cut'
  try {
    const dest = await uniquePath(dir, basename(clip.path))
    if (moved) await invoke('fs.move', { from: clip.path, to: dest })
    else await invoke('fs.copy', { from: clip.path, to: dest })
    if (moved) clip = null
    sidebar.invalidate(dir)
    S.state.expanded.add(dir)
    await sidebar.refresh()
    toast(moved ? '已移动' : '已粘贴')
  } catch (err: any) {
    toast(err.message)
  }
}

async function moveEntry(src: string, destDir: string): Promise<void> {
  if (!src || !destDir) return
  if (src === destDir) return
  if (destDir === src || destDir.startsWith(src + '/')) {
    toast('不能把文件夹移动到它自己的子目录')
    return
  }
  if (dirname(src) === destDir) return
  try {
    const dest = await uniquePath(destDir, basename(src))
    await invoke('fs.move', { from: src, to: dest })
    for (const d of S.state.docs) {
      if (d.path === src || d.path.startsWith(src + '/')) {
        const oldId = d.id
        const newPath = dest + d.path.slice(src.length)
        editor.forget(oldId)
        d.path = newPath
        d.id = newPath
        if (S.state.activeId === oldId) S.state.activeId = newPath
      }
    }
    sidebar.invalidate(dirname(src))
    sidebar.invalidate(destDir)
    S.state.expanded.add(destDir)
    await sidebar.refresh()
    S.emit('active')
    toast(`已移动到「${basename(destDir)}」`)
  } catch (err: any) {
    toast(err.message || '移动失败')
  }
}

function entryMenu(entry: Entry, ev: MouseEvent): void {
  const items: any[] = []
  if (entry.isDir) {
    items.push({ label: '新建文件', icon: 'file-plus', onClick: () => newFile(entry.path) })
    items.push({ label: '新建文件夹', icon: 'folder-plus', onClick: () => newFolder(entry.path) })
    items.push({ sep: true })
  }
  items.push({ label: '拷贝', icon: 'copy', sub: '⌘C', onClick: () => { clip = { mode: 'copy', path: entry.path }; toast(`已拷贝 ${entry.displayName}`) } })
  items.push({ label: '剪切', icon: 'cut', sub: '⌘X', onClick: () => { clip = { mode: 'cut', path: entry.path }; toast(`已剪切 ${entry.displayName}`) } })
  if (clip) items.push({ label: '粘贴到此', icon: 'paste', sub: '⌘V', onClick: () => pasteInto(entry.isDir ? entry.path : dirname(entry.path)) })
  items.push({ sep: true })
  items.push({ label: '在 Finder 中显示', icon: 'external', onClick: () => invoke('ui.reveal', { path: entry.path }) })
  items.push({ label: '拷贝路径', icon: 'file', onClick: () => copyText(entry.path, '已拷贝路径') })
  items.push({ sep: true })
  items.push({ label: '重命名…', icon: 'pencil', onClick: () => renameEntry(entry) })
  items.push({ label: '移到废纸篓', icon: 'trash', danger: true, onClick: () => deleteEntry(entry) })
  items.push({ sep: true })
  if (entry.isDir) {
    if (entry.vault) {
      items.push(S.state.vaults.get(entry.path)
        ? { label: '锁定目录', icon: 'lock', onClick: () => lockVault(entry.path) }
        : { label: '解锁目录', icon: 'unlock', onClick: () => unlockVault(entry.path) })
      items.push({ label: '解除加密（还原文件）…', icon: 'unlock', danger: true, onClick: () => removeVaultEncryption(entry.path) })
    } else {
      items.push({ label: '加密此文件夹…', icon: 'lock', onClick: () => encryptFolder(entry.path) })
    }
  } else if (entry.encrypted && entry.inVault && entry.vaultRoot) {
    items.push({ label: '解锁所在目录…', icon: 'unlock', onClick: () => unlockVault(entry.vaultRoot!) })
  } else if (entry.encrypted) {
    items.push({ label: '解锁此文件…', icon: 'unlock', onClick: () => unlockFile(entry) })
    items.push({ label: '解除加密（还原文件）…', icon: 'unlock', danger: true, onClick: () => removeFileEncryption(entry) })
  } else {
    items.push({ label: '加密此文件…', icon: 'lock', onClick: () => encryptFile(entry) })
  }
  contextMenu(ev.clientX, ev.clientY, items)
}

function rootMenu(root: string, ev: MouseEvent): void {
  contextMenu(ev.clientX, ev.clientY, [
    { label: '新建文件', icon: 'file-plus', onClick: () => newFile(root) },
    { label: '新建文件夹', icon: 'folder-plus', onClick: () => newFolder(root) },
    { sep: true },
    { label: '在 Finder 中显示', icon: 'external', onClick: () => invoke('ui.reveal', { path: root }) },
    { label: '拷贝路径', icon: 'file', onClick: () => copyText(root, '已拷贝路径') },
    { sep: true },
    { label: '加密此文件夹…', icon: 'lock', onClick: () => encryptFolder(root) },
    { label: '解除加密（还原文件）…', icon: 'unlock', danger: true, onClick: () => removeVaultEncryption(root) },
    { label: '从工作区移除', icon: 'close', danger: true, onClick: () => removeRoot(root) }
  ])
}

/* ============================================================
   fs events
   ============================================================ */

const onFsChange = debounce(async (payload: { paths: string[] }) => {
  const dirs = new Set<string>()
  for (const p of payload.paths ?? []) {
    dirs.add(dirname(p))
    // 目录本身的属性变了（例如变成加密目录），父级列表也要失效
    dirs.add(dirname(dirname(p)))
  }
  for (const d of dirs) sidebar.invalidate(d)
  fileIndex = []
  await sidebar.refresh()

  for (const doc of S.state.docs) {
    if (!doc.editable || doc.dirty) continue
    try {
      const st = await invoke<{ mtime: number }>('fs.stat', { path: doc.path })
      if (st && st.mtime > doc.mtime + 0.001) {
        const res = await invoke<{ text?: string; mtime: number }>('fs.read', { path: doc.path })
        if (res.text !== undefined && res.text !== doc.text) {
          doc.text = res.text
          doc.saved = res.text
          doc.mtime = res.mtime
          editor.forget(doc.id)
          if (doc.id === S.state.activeId) {
            editor.setDoc(doc)
            previewDocId = ''
            previewText = ''
            S.emit('active')
          }
          S.emit('docs')
        }
      }
    } catch {}
  }
}, 320)

/* ============================================================
   boot
   ============================================================ */

window.addEventListener('error', (ev: any) => {
  invoke('app.log', { line: `JSERR ${ev?.message ?? ''} @${ev?.filename ?? ''}:${ev?.lineno ?? 0}` }).catch(() => {})
})
window.addEventListener('unhandledrejection', (ev: any) => {
  const r = ev?.reason
  invoke('app.log', { line: `JSREJECT ${String(r?.stack ?? r).slice(0, 400)}` }).catch(() => {})
})

const saveSession = debounce(() => {
  const paths = S.state.docs.filter((d) => d.path).map((d) => d.path).slice(0, 12)
  S.state.settings.openDocs = paths
  S.state.settings.activePath = S.activeDoc()?.path ?? ''
  S.saveSettings()
}, 800)

async function boot(): Promise<void> {
  S.loadSettings()
  applyTheme(S.state.settings.theme, S.state.settings.iconSet)
  buildShell()

  sidebar.setActions({
    open: (entry) => openFile(entry.path, entry.displayName),
    newFile,
    newFolder,
    rename: renameEntry,
    remove: deleteEntry,
    reveal: (entry) => invoke('ui.reveal', { path: entry.path }),
    encrypt: encryptFolder,
    lockVault,
    openVault: (entry) => unlockVault(entry.path),
    contextMenu: entryMenu,
    moveTo: moveEntry,
    moveInto: (src, dir) => moveEntry(src, dir),
    copyInto: async (src, dir) => {
      const dest = await uniquePath(dir, basename(src))
      await invoke('fs.copy', { from: src, to: dest })
      sidebar.invalidate(dir)
      S.state.expanded.add(dir)
      await sidebar.refresh()
      toast(`已复制到「${basename(dir)}」`)
    },
    openFolder,
    openBrowser: () => openBrowser(),
    openTerminal: (ev) => terminalMenu(ev.clientX, ev.clientY),
    openQuickCommands: () => openQuickCommandManager(),
    openSettings,
    removeRoot,
    rootMenu,
    addRemoteRoot: () => addRemoteRoot(),
    removeRemoteRoot: (p) => removeRemoteRoot(p),
    remoteRootMenu: (p, ev) => remoteRootMenu(p, ev),
    multiMenu: (paths, ev) => multiMenu(paths, ev)
  })

  S.setSaveAsHandler(saveAsDoc)
  registerRemoteRoots()
  // 远端下载下来的文件，保存后自动传回去
  S.setAfterSaveHandler((doc) => {
    const backing = remoteBacking.get(doc.path)
    if (!backing) return
    const p = backing.profile
    invoke('remote.upload', {
      host: p.host, port: p.port ?? 22, user: p.user ?? 'root',
      secretId: p.hasPassword ? p.id : undefined,
      local: doc.path, to: backing.remote
    }).then(() => toast('已同步到远端', 1200)).catch((e) => toast(`同步失败：${e.message}`))
  })

  // 切回窗口 / 切标签时，顺带刷新远程树（节流，避免频繁 ssh）
  let lastRemoteRefresh = 0
  const refreshRemoteTree = (force = false) => {
    const roots = S.state.remoteRoots ?? []
    if (!roots.length) return
    const now = Date.now()
    if (!force && now - lastRemoteRefresh < 2500) return
    lastRemoteRefresh = now
    for (const r of roots) sidebar.invalidateQuiet(remoteRootPath(r))
    sidebar.refresh().catch(() => {})
  }
  ;(window as any).__bnbRefreshRemote = refreshRemoteTree
  window.addEventListener('focus', () => refreshRemoteTree())
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshRemoteTree() })

  S.subscribe((kind) => {
    if (kind === 'active' || kind === 'docs') saveSession()
    if (kind === 'active') refreshRemoteTree()
    if (kind === 'root') { sidebar.refresh(); renderTitle() }
    else if (kind === 'active' || kind === 'docs') {
      syncActive()
      // 关掉的终端会话要释放
      for (const [id, t] of Array.from(terminals)) {
        if (!S.state.docs.some((d) => d.id === id)) { t.dispose(); terminals.delete(id) }
      }
      // 关掉的远端文件面板也要从 DOM 和 map 里移除，避免残留面板继续占位
      for (const [id, p] of Array.from(ctx.remotePanels)) {
        if (!S.state.docs.some((d) => d.id === id)) { p.el.remove(); ctx.remotePanels.delete(id) }
      }
    }
  })

  // 空闲 15 分钟自动锁定所有已解锁的加密目录
  let lastActivity = Date.now()
  const markActive = () => { lastActivity = Date.now() }
  window.addEventListener('keydown', markActive, true)
  window.addEventListener('mousedown', markActive, true)
  window.addEventListener('wheel', markActive, { capture: true, passive: true })
  setInterval(() => {
    if (Date.now() - lastActivity < 15 * 60_000) return
    const unlocked = Array.from(S.state.vaults.entries()).filter(([, ok]) => ok).map(([p]) => p)
    if (!unlocked.length) return
    for (const v of unlocked) {
      invoke('vault.lock', { path: v }).catch(() => {})
      S.state.vaults.set(v, false)
    }
    toast('已空闲 15 分钟，加密目录已自动锁定', 4000)
    sidebar.refresh()
  }, 60_000)

  ui.termHost = termHost
  ui.remoteHost = remoteHost
  ctx.ui = ui
  ctx.sidebar = sidebar
  ctx.editor = editor
  ctx.terminals = terminals
  ctx.aiPanel = aiPanel
  ctx.sync = syncActive
  ctx.browser = browser

  installKeys()
  onEvent('fs.change', (payload) => onFsChange(payload))
  onEvent('ui.fullscreen', (payload: any) => {
    document.documentElement.classList.toggle('fullscreen', !!payload?.value)
  })
  onEvent('pty.data', (payload: any) => {
    if (payload?.id && ptyCaptures.has(payload.id)) {
      const bin = atob(payload.data ?? '')
      const txt = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
      ptyCaptures.set(payload.id, (ptyCaptures.get(payload.id) ?? '') + txt)
    }
    const s = [...terminals.values()].find((t) => t.ptyId === payload?.id)
    if (!s || !payload?.data) return
    const bin = atob(payload.data)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    s.write(bytes)
  })
  onEvent('pty.exit', (payload: any) => {
    const s = [...terminals.values()].find((t) => t.ptyId === payload?.id)
    if (!s) return
    const code = Number(payload?.code ?? 0)
    s.markExited(code)
    // 保存的密码被拒（ssh 退出码 255）时，自动改成手动输入
    if (code === 255 && s.usedSecret && !s.retried) {
      toast('保存的密码不可用，请手动输入')
      s.restart(false).catch(() => {})
      return
    }
    // 第一次退出：回落到本地终端；再退出一次：关掉这个标签
    if (!s.restarted) {
      s.fallbackToLocal().catch(() => {})
    } else {
      const doc = S.state.docs.find((d) => d.id === s.docId)
      if (doc && doc.locked) {
        s.write(new TextEncoder().encode('\r\n\x1b[2m[标签已锁定，未被关闭]\x1b[0m\r\n'))
      } else {
        void S.closeDoc(s.docId)
      }
    }
  })

  // 复制/剪切/粘贴快捷键：只在上一次按下鼠标位于文件树时生效
  let pointerInTree = false
  document.addEventListener('mousedown', (ev) => {
    pointerInTree = !!(ev.target as HTMLElement)?.closest?.('.tree')
  }, true)
  window.addEventListener('keydown', (ev) => {
    if (!ev.metaKey || ev.ctrlKey) return
    if (!pointerInTree) return
    const sel0 = window.getSelection()
    if (sel0 && !sel0.isCollapsed) return
    const target = ev.target as HTMLElement
    if (target?.closest?.('input, textarea, .cm-editor, .md, .pdf-view, .csv-wrap, .ai-panel')) return
    const k = ev.key.toLowerCase()
    const sel = S.state.selected
    if (k === 'c' && sel) {
      ev.preventDefault(); clip = { mode: 'copy', path: sel }; toast('已拷贝')
    } else if (k === 'x' && sel) {
      ev.preventDefault(); clip = { mode: 'cut', path: sel }; toast('已剪切')
    } else if (k === 'v' && clip && sel) {
      ev.preventDefault()
      const dir = S.state.expanded.has(sel) ? sel : dirname(sel)
      pasteInto(dir)
    }
  }, true)

  // 从访达拖文件进窗口
  const fileToBase64 = (f: File): Promise<string> =>
    new Promise((res, rej) => {
      const r = new FileReader()
      r.onload = () => res(String(r.result ?? '').split(',')[1] ?? '')
      r.onerror = () => rej(r.error)
      r.readAsDataURL(f)
    })

  document.addEventListener('dragover', (ev) => {
    if (!ev.dataTransfer?.types.includes('Files')) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy'
  })

  document.addEventListener('drop', async (ev) => {
    const files = Array.from(ev.dataTransfer?.files ?? [])
    if (!files.length) return
    ev.preventDefault()
    ev.stopPropagation()
    const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null
    const row = under?.closest('.tree-row') as HTMLElement | null
    let dir = ''
    if (row && (row.dataset.dir === '1' || row.dataset.root === '1')) dir = row.dataset.path || ''
    else if (browser.visible()) dir = browser.currentDir()
    else dir = S.state.roots[0] ?? ''
    if (!dir) { toast('没有可用的目标目录'); return }
    let n = 0
    for (const f of files) {
      try {
        const target = await uniquePath(dir, f.name)
        const b64 = await fileToBase64(f)
        await invoke('fs.writeBytes', { path: target, base64: b64 })
        n++
      } catch (err: any) {
        toast(`导入 ${f.name} 失败：${err?.message ?? ''}`)
      }
    }
    sidebar.invalidate(dir)
    S.state.expanded.add(dir)
    await sidebar.refresh()
    if (browser.visible()) await browser.refreshAll()
    if (n) toast(`已导入 ${n} 个文件到「${basename(dir)}」`)
  })

  document.addEventListener('contextmenu', (ev) => {
    const target = ev.target as HTMLElement
    if (target.closest('.tree-row') || target.closest('.tab') || target.closest('.md') ||
        target.closest('.cm-editor') || target.closest('.ai-panel') || target.closest('.ai-input')) return
    ev.preventDefault()
  })

  let initial = ''
  let initialFile = ''
  try {
    const info = await invoke<{ initial: string; initialFile: string; samples: string }>('app.info')
    initial = info.initial || ''
    initialFile = info.initialFile || ''
    samplesPath = info.samples || ''
  } catch {}

  invoke<boolean>('ui.isFullscreen').then((fs) => {
    document.documentElement.classList.toggle('fullscreen', !!fs)
  }).catch(() => {})

  const wanted = initial ? [initial] : (S.state.settings.roots.length ? S.state.settings.roots : [])
  for (const r of wanted) await allowRoot(r)
  for (const r of wanted) {
    const exists = await invoke('fs.exists', { path: r }).catch(() => false)
    if (exists) await openWorkspace(r)
    else S.state.roots = S.state.roots.filter((x) => x !== r)
  }
  S.state.settings.roots = S.state.roots.slice()
  S.saveSettings()

  if (initialFile) await openFile(initialFile).catch(() => {})
  else if (!initial) {
    const remembered = (S.state.settings.openDocs ?? []).slice(0, 12)
    for (const p of remembered) {
      if (!p) continue
      try {
        const st = await invoke<{ size: number }>('fs.stat', { path: p }).catch(() => null)
        if (!st) continue
        if ((st.size ?? 0) > 2_000_000) continue
        await openFile(p)
      } catch {}
    }
    const activePath = S.state.settings.activePath
    const target = activePath ? S.state.docs.find((d) => d.path === activePath) : null
    if (target) S.setActive(target.id)
  }
  await offerDraftRecovery()
  // 只有远程工作区、没有本地根时也要渲染树
  await sidebar.refresh()
  syncActive()
  renderTitle()
  if (!S.state.docs.length) setTimeout(() => editor.focus(), 100)
}

;(window as any).__betternotebook = {
  open: (p: string) => openFile(p),
  workspace: (p: string) => openWorkspace(p),
  theme: (id: string) => { S.state.settings.theme = id; applyTheme(id); editor.applySettings(); S.emit('active') },
  view: (v: string) => { const d = S.activeDoc(); if (d) S.setView(d, v as any) },
  state: () => S.state,
  invoke: (m: string, a: any) => invoke(m, a),
  openDoc: (p: string) => S.openPath(p),
  // 测试用：当前编辑器光标与选区
  cursorInfo: () => ({ ...cursor, text: editor.selectionText() }),
  check: () => { const d = S.activeDoc(); if (d) runCheck(d) },
  searchDoc: (t: string) => editor.searchFor(t),
  termInput: (t: string) => {
    const d = S.activeDoc()
    const s = d ? terminals.get(d.id) : null
    if (!s?.ptyId) return false
    const bytes = new TextEncoder().encode(t)
    let bin = ''
    bytes.forEach((b) => { bin += String.fromCharCode(b) })
    invoke('pty.write', { id: s.ptyId, data: btoa(bin) }).catch(() => {})
    return true
  },
  ptyRun: async (program: string, args: string[], env: Record<string, string>) => {
    const r = await invoke<{ id: string }>('pty.open', { program, args, env, cols: 80, rows: 24 })
    ptyCaptures.set(r.id, '')
    await new Promise((ok) => setTimeout(ok, 1200))
    const out = ptyCaptures.get(r.id) ?? ''
    ptyCaptures.delete(r.id)
    await invoke('pty.close', { id: r.id }).catch(() => {})
    return out
  },
  openRemoteMock: () => openRemote({ id: 'mock', name: '模拟远端', kind: 'ssh', host: 'mock', user: 'me', port: 22 }),
  openTerm: (kind: string) => openTerminal({ id: 'local', name: '终端', kind: (kind as any) || 'local' }),
  type: (t: string) => {
    const d = S.activeDoc()
    if (!d) return
    d.text = t
    d.dirty = t !== d.saved
    editor.setDoc(d)
    editor.setIssues(d.path, d.issues)
    S.emit('docs')
  },
  log: (line: string) => invoke('app.log', { line })
}

window.addEventListener('error', (e) => {
  invoke('app.log', { line: `ERR ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}` }).catch(() => {})
})
window.addEventListener('unhandledrejection', (e) => {
  invoke('app.log', { line: `REJECT ${String((e as any).reason?.stack ?? (e as any).reason)}` }).catch(() => {})
})

boot().then(() => {
  const sb = document.querySelector('.sidebar')?.getBoundingClientRect()
  invoke('app.log', {
    line: `BOOT ok theme=${document.documentElement.dataset.theme} win=${innerWidth}x${innerHeight} sidebar=${Math.round(sb?.width ?? 0)} rows=${document.querySelectorAll('.tree-row').length} tabs=${document.querySelectorAll('.tab').length}`
  }).catch(() => {})
}).catch((err) => {
  invoke('app.log', { line: `BOOT FAIL ${String(err?.stack ?? err)}` }).catch(() => {})
  console.error(err)
  document.body.innerHTML = `<div style="padding:40px;font-family:-apple-system;color:#888">SuperWorkStation 启动失败：${String(err?.message ?? err)}</div>`
})
