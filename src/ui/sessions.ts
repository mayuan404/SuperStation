import { el } from '../lib/dom'
import { icon } from '../lib/icons'
import { invoke } from '../lib/bridge'
import * as S from '../lib/store'
import type { Doc } from '../lib/store'
import { openSheet, contextMenu, toast, prompt } from './overlays'
import { remoteRootPath } from './sidebar'
import { TermSession, type TermProfile } from './terminal'
import { RemotePanel, uploadFilesToDir } from './remote'
import { openGitPanel } from './gitpanel'
import { ctx } from '../lib/ctx'
import { basename, dirname } from '../lib/files'

const copyText = (text: string, msg = '已拷贝') => invoke('ui.copy', { text }).then(() => toast(msg))

export function sshSessions(): any[] {
  return S.state.settings.sessions ?? []
}

export function registerRemoteRoots(): void {
  for (const r of S.state.remoteRoots ?? []) {
    invoke('remote.register', {
      id: r.id, host: r.host, port: r.port, user: r.user,
      secretId: r.secretId
    }).catch(() => {})
  }
}

export function addRemoteRoot(): void {
  const sessions = sshSessions().filter((s) => s.kind === 'ssh' && s.host)
  if (!sessions.length) {
    toast('先新建一个 SSH 会话，再把它加为远程工作区')
    sshForm()
    return
  }
  openSheet('添加远程工作区', (body, close) => {
    const sel = el('select', { class: 'txt' }) as HTMLSelectElement
    for (const s of sessions) {
      sel.append(el('option', { value: s.id }, `${s.name}  (${s.user || 'root'}@${s.host})`))
    }
    body.append(el('div', { class: 'sheet-row' }, el('div', { class: 'lbl' }, '会话'), sel))

    const pathInput = sheetInput(body, '仓库路径', '', '也可以直接手打，如 /home/user/project')

    const listBox = el('div', { class: 'remote-picker tall' })
    body.append(el('div', { class: 'sheet-row col' },
      el('div', { class: 'sheet-head-row' },
        el('div', { class: 'lbl' }, '选择目录'),
        el('div', { class: 'picker-hint inline' }, '单击勾选可多选 · 双击进入')),
      listBox))

    const picked = new Set<string>()
    const pickedBar = el('div', { class: 'picker-picked' }, '未选择（不选则用上面的路径）')
    body.append(pickedBar)
    const refreshPicked = () => {
      if (!picked.size) { pickedBar.textContent = '未选择（不选则用上面的路径）'; return }
      pickedBar.textContent = `已选 ${picked.size} 个：` + Array.from(picked).map((p) => p.split('/').filter(Boolean).pop()).join('、')
    }

    const currentSession = () => sessions.find((x) => x.id === sel.value)
    let listedPath = '.'

    const loadDir = async (path: string) => {
      const s = currentSession()
      if (!s) return
      listBox.innerHTML = ''
      listBox.append(el('div', { class: 'picker-hint' }, '读取中…'))
      const res = await invoke<any>('remote.list', {
        host: s.host, port: s.port ?? 22, user: s.user || 'root',
        secretId: s.hasPassword ? s.id : undefined,
        path: path || '.'
      }).catch((e) => ({ error: e.message }))
      listBox.innerHTML = ''
      if (res?.error) {
        listBox.append(el('div', { class: 'picker-hint' }, String(res.error).slice(0, 200)))
        return
      }
      listedPath = path || '.'

      const up = el('div', { class: 'picker-row up' }, '..')
      up.addEventListener('click', () => {
        const parent = listedPath.replace(/\/[^/]+$/, '') || '/'
        pathInput.value = parent
        loadDir(parent)
      })
      listBox.append(up)

      const dirs = (res?.entries ?? []).filter((e: any) => e.isDir).map((e: any) => e.name)
      if (!dirs.length) listBox.append(el('div', { class: 'picker-hint' }, '（没有子目录）'))
      for (const d of dirs) {
        const full = listedPath === '.' ? d : `${listedPath.replace(/\/$/, '')}/${d}`
        const box = el('input', { type: 'checkbox', class: 'picker-check' }) as HTMLInputElement
        box.checked = picked.has(full)
        const row = el('div', { class: 'picker-row pickable' + (box.checked ? ' checked' : '') })
        row.append(box, el('span', {}, d))
        box.addEventListener('click', (ev) => ev.stopPropagation())
        box.addEventListener('change', () => {
          if (box.checked) picked.add(full)
          else picked.delete(full)
          row.classList.toggle('checked', box.checked)
          refreshPicked()
        })
        row.addEventListener('click', () => {
          box.checked = !box.checked
          box.dispatchEvent(new Event('change'))
        })
        row.addEventListener('dblclick', () => {
          pathInput.value = full
          loadDir(full)
        })
        listBox.append(row)
      }
    }

    let primed = false
    const prime = () => {
      const s = currentSession()
      if (!s) return
      if (!primed) {
        primed = true
        if (!pathInput.value.trim() && s.remotePath) pathInput.value = s.remotePath
      }
      loadDir(s.remotePath || '.')
    }
    sel.addEventListener('change', () => { primed = false; picked.clear(); refreshPicked(); prime() })
    pathInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') loadDir(pathInput.value.trim() || '.')
    })
    setTimeout(prime, 0)

    const add = el('button', { class: 'primary' }, '添加')
    add.addEventListener('click', async () => {
      const session = currentSession()
      if (!session) return
      const manual = pathInput.value.trim()
      const targets = picked.size ? Array.from(picked) : (manual ? [manual] : [])
      if (!targets.length) { toast('请选择或填写仓库路径'); return }
      for (const p of targets) {
        const root = {
          id: `r${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
          name: p.split('/').filter(Boolean).pop() || 'remote',
          host: session.host, port: session.port ?? 22, user: session.user || 'root',
          path: p, secretId: session.hasPassword ? session.id : undefined
        }
        S.state.remoteRoots.push(root)
        S.state.settings.remoteRoots = S.state.remoteRoots.slice()
        await invoke('remote.register', {
          id: root.id, host: root.host, port: root.port, user: root.user, secretId: root.secretId
        }).catch(() => {})
        S.state.expanded.add(remoteRootPath(root))
      }
      S.saveSettings()
      close()
      await ctx.sidebar?.refresh()
      ctx.sidebar?.showTab('remote')
      toast(`已添加 ${targets.length} 个工作区`)
    })
    const cancel = el('button', { class: 'ghost' }, '取消')
    cancel.addEventListener('click', () => close())
    body.append(el('div', { class: 'sheet-actions' }, cancel, add))
  }, 660, true)
}

export function removeRemoteRoot(path: string): void {
  const id = path.replace(/^ssh:\/\//, '').split('/')[0]
  S.state.remoteRoots = (S.state.remoteRoots ?? []).filter((r) => r.id !== id)
  S.state.settings.remoteRoots = S.state.remoteRoots.slice()
  S.saveSettings()
  invoke('remote.forget', { id }).catch(() => {})
  ctx.sidebar?.refresh()
}

export async function gitAction(root: any, action: string, message = ''): Promise<void> {
  toast(action === 'pull' ? '正在拉取…' : action === 'push' ? '正在推送…' : '正在提交…', 2000)
  const res = await invoke<any>('remote.git', {
    id: root.id, path: remoteRootPath(root), action, message
  }).catch((e) => ({ ok: false, output: e.message }))
  const out = String(res?.output ?? '').trim()
  toast(out ? out.slice(0, 120) : (res?.ok ? '完成' : '失败'), 4000)
  ctx.sidebar?.invalidate(remoteRootPath(root))
  ctx.sidebar?.refresh()
}

export function remoteRootMenu(path: string, ev: MouseEvent): void {
  const id = path.replace(/^ssh:\/\//, '').split('/')[0]
  const root = (S.state.remoteRoots ?? []).find((r) => r.id === id)
  if (!root) return
  contextMenu(ev.clientX, ev.clientY, [
    { label: '刷新', icon: 'refresh', onClick: () => { ctx.sidebar?.invalidate(path); ctx.sidebar?.refresh() } },
    { sep: true },
    { label: 'Git 面板…', icon: 'git', onClick: () => openGitPanel(path, root.name, {
      openTerminal: () => openTerminal({ id: root.secretId || 'tmp', name: root.name, kind: 'ssh', host: root.host, port: root.port, user: root.user, remotePath: root.path, hasPassword: !!root.secretId })
    }) },
    { label: '获取 git fetch', icon: 'refresh', onClick: () => gitAction(root, 'fetch') },
    { label: '拉取 git pull', icon: 'arrow-left', onClick: () => gitAction(root, 'pull') },
    { label: '推送 git push', icon: 'external', onClick: () => gitAction(root, 'push') },
    { label: '提交全部改动…', icon: 'check', onClick: async () => {
      const msg = await prompt({ title: '提交信息', label: 'git commit -m' })
      if (msg) gitAction(root, 'commit', msg)
    } },
    { sep: true },
    { label: '上传文件到此处…', icon: 'upload', onClick: () => { uploadFilesToDir(
      { host: root.host, port: root.port ?? 22, user: root.user ?? 'root', secretId: root.secretId },
      root.path,
      { refresh: () => { ctx.sidebar?.invalidate(path); ctx.sidebar?.refresh() } }
    ) } },
    { label: '在终端打开此目录', icon: 'terminal', onClick: () => openTerminal({ id: root.secretId || 'tmp', name: root.name, kind: 'ssh', host: root.host, port: root.port, user: root.user, remotePath: root.path, hasPassword: !!root.secretId }) },
    { label: '浏览远端文件', icon: 'folder-open', onClick: () => openRemote({ id: root.secretId || 'tmp', name: root.name, kind: 'ssh', host: root.host, port: root.port, user: root.user, remotePath: root.path, hasPassword: !!root.secretId }) },
    { sep: true },
    { label: '断开并移除', icon: 'close', danger: true, onClick: () => removeRemoteRoot(path) }
  ])
}

const remoteSaveTimers = new Map<string, any>()

/** 远端文档：停止输入 3 秒后写回服务器 */
export function remoteSaveQueue(doc: Doc): void {
  const key = doc.path
  clearTimeout(remoteSaveTimers.get(key))
  remoteSaveTimers.set(key, setTimeout(() => {
    remoteSaveTimers.delete(key)
    if (!doc.dirty) return
    S.saveDoc(doc).then(() => toast('已同步到远端', 1000)).catch((e) => toast(`同步失败：${e.message}`))
  }, 3000))
}

export function openRemote(profile: TermProfile): void {
  const doc = S.createRemoteDoc(`${profile.name} · 文件`)
  const panel = new RemotePanel(profile, {
    openLocal: (p, n) => ctx.openFile(p, n),
    toast,
    menu: (x, y, items) => contextMenu(x, y, items),
    prompt
  })
  ;(panel as any).deps.onClose = () => void S.closeDoc(doc.id)
  ctx.remotePanels.set(doc.id, panel)
  ctx.ui?.remoteHost?.append(panel.el)
  ctx.sync()
  // 先把底层 ssh 连接建起来，后面的列目录就不用每次都重连
  invoke('remote.warm', {
    host: profile.host, port: profile.port ?? 22, user: profile.user ?? 'root',
    secretId: profile.hasPassword ? profile.id : undefined,
    mockLocal: profile.host === 'mock'
  }).catch(() => {})
  panel.load(profile.remotePath || '.')
}

export function openTerminal(profile: TermProfile): void {
  const detail = profile.kind === 'ssh' ? (profile.host || 'SSH') : '本地'
  const p: TermProfile = { ...profile }
  if (p.kind === 'local' && !p.cwd) p.cwd = S.state.settings.localCwd?.trim() || undefined
  const doc = S.createTerminalDoc(p.name, detail, p.color)
  const session = new TermSession(doc.id, p, {
    onBrowseRemote: (p) => openRemote(p),
    onExit: (ptyId, code) => {
      const s = [...ctx.terminals.values()].find((t) => t.ptyId === ptyId)
      if (s && code !== 0) toast(`终端已退出（${code}）`)
    },
    toast
  })
  ctx.terminals.set(doc.id, session)
  ctx.ui?.termHost?.append(session.el)
  ctx.sync()
}

export function openTerminalMenuAtCenter(): void {
  const r = ctx.ui?.editorPane?.getBoundingClientRect() ?? { left: 200, top: 100 }
  terminalMenu(r.left + 120, r.top + 80)
}

export function terminalMenu(x: number, y: number): void {
  const sessions = S.state.settings.sessions ?? []
  const localDir = S.state.settings.localCwd?.trim() || ''
  const localSub = localDir ? basename(localDir) : '~'
  const items: any[] = [
    { label: '本地终端（zsh）', icon: 'terminal', sub: localSub, onClick: () => openTerminal({ id: 'local', name: '终端', kind: 'local' }) }
  ]
  const active = S.activeDoc()
  const activeDir = active?.path && !active.path.startsWith('ssh://') ? dirname(active.path) : ''
  if (activeDir && activeDir !== localDir) {
    items.push({ label: '本地终端（当前文件目录）', icon: 'terminal', sub: basename(activeDir),
      onClick: () => openTerminal({ id: 'local', name: '终端', kind: 'local', cwd: activeDir }) })
  }
  items.push({ sep: true })
  const groups = new Map<string, typeof sessions>()
  for (const s of sessions) {
    const g = s.group?.trim() || '未分组'
    if (!groups.has(g)) groups.set(g, [])
    groups.get(g)!.push(s)
  }
  for (const [name, list] of groups) {
    items.push({ header: true, label: name })
    for (const s of list) {
      items.push({
        label: s.name + (s.kind === 'ssh' && s.host ? `  ${s.user || 'root'}@${s.host}` : '') + (s.hasPassword ? '  🔑' : ''),
        icon: s.kind === 'ssh' ? 'external' : 'terminal',
        onClick: () => openTerminal(s)
      })
    }
  }
  if (sessions.length) items.push({ sep: true })
  items.push({ label: '新建 SSH 会话…', icon: 'plus', onClick: () => sshForm() })
  if (sessions.length) items.push({ label: '管理会话…', icon: 'settings', onClick: () => manageSessions() })
  contextMenu(x, y, items)
}

export function sheetInput(parent: HTMLElement, label: string, value = '', placeholder = ''): HTMLInputElement {
  const input = el('input', { class: 'txt', placeholder, value, spellcheck: 'false' }) as HTMLInputElement
  parent.append(el('div', { class: 'sheet-row' }, el('div', { class: 'lbl' }, label), input))
  return input
}

export function sshForm(existing?: any): void {
  openSheet(existing ? '编辑 SSH 会话' : '新建 SSH 会话', (body, close) => {
    const name = sheetInput(body, '名称', existing?.name ?? '', '生产机 / 跳板机')
    const host = sheetInput(body, '主机', existing?.host ?? '', 'example.com 或 10.0.0.1')
    const user = sheetInput(body, '用户名', existing?.user ?? 'root')
    const port = sheetInput(body, '端口', String(existing?.port ?? 22))
    const group = sheetInput(body, '分组', existing?.group ?? '', '生产 / 测试 / 内网（可留空）')
    const remotePath = sheetInput(body, '初始目录', existing?.remotePath ?? '', '/var/www/app（留空则进 home）')

    const pw = el('input', {
      type: 'password',
      class: 'txt',
      placeholder: existing?.hasPassword
        ? '已保存，留空保持不变'
        : '留空则每次在终端里手动输入',
      spellcheck: 'false'
    }) as HTMLInputElement
    const pwRow = el('div', { class: 'sheet-row' },
      el('div', { class: 'lbl' }, '密码'), pw)
    body.append(pwRow)
    body.append(el('div', { class: 'sheet-hint' }, '保存的密码写入本机 0600 权限文件，与 ssh 私钥同级；不会进入设置或日志'))
    if (existing?.hasPassword) {
      const clr = el('button', { class: 'ghost' }, '清除已保存的密码')
      clr.addEventListener('click', async () => {
        await invoke('ssh.setSecret', { id: existing.id, password: '' }).catch(() => {})
        existing.hasPassword = false
        pw.placeholder = '已清除，留空则手动输入'
        clr.remove()
        toast('已清除保存的密码')
      })
      body.append(el('div', { class: 'sheet-row' }, el('div', { class: 'lbl' }, ''), clr))
    }

    const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6']
    let color = existing?.color ?? COLORS[0]
    const swatches = el('div', { class: 'swatches' })
    for (const c of COLORS) {
      const sw = el('button', { class: 'swatch' + (c === color ? ' active' : '') })
      sw.style.background = c
      sw.addEventListener('click', () => {
        color = c
        for (const other of Array.from(swatches.children)) other.classList.remove('active')
        sw.classList.add('active')
      })
      swatches.append(sw)
    }
    body.append(el('div', { class: 'sheet-row' }, el('div', { class: 'lbl' }, '颜色'), swatches))
    const save = el('button', { class: 'primary' }, existing ? '保存' : '保存并连接')
    save.addEventListener('click', async () => {
      const profile: TermProfile = {
        id: existing?.id ?? `s${Date.now()}`,
        name: name.value.trim() || host.value.trim() || 'SSH',
        kind: 'ssh',
        host: host.value.trim(),
        user: user.value.trim() || 'root',
        port: Number(port.value.trim() || 22),
        group: group.value.trim(),
        color,
        remotePath: remotePath.value.trim(),
        hasPassword: false
      }
      if (pw.value) {
        await invoke('ssh.setSecret', { id: profile.id, password: pw.value }).catch(() => {})
        profile.hasPassword = true
      } else {
        profile.hasPassword = existing?.hasPassword ?? false
      }
      if (!profile.host) { toast('请填写主机'); return }
      const list = (S.state.settings.sessions ?? []).filter((s) => s.id !== profile.id)
      S.state.settings.sessions = [...list, profile]
      S.saveSettings()
      close()
      openTerminal(profile)
    })
    const cancel = el('button', { class: 'ghost' }, '取消')
    cancel.addEventListener('click', () => close())
    body.append(el('div', { class: 'sheet-actions' }, cancel, save))
  }, 440)
}

export function manageSessions(): void {
  openSheet('SSH 会话', (body, close) => {
    const list = S.state.settings.sessions ?? []
    if (!list.length) body.append(el('div', { class: 'sheet-hint' }, '还没有保存的会话'))
    for (const s of list) {
      const dot = el('span', { class: 'term-dot' })
      if (s.color) dot.style.background = s.color
      const meta = `${s.user || 'root'}@${s.host}:${s.port || 22}${s.remotePath ? '  ·  ' + s.remotePath : ''}`
      const main = el('div', { class: 'sess-main' },
        el('div', { class: 'lbl' }, `${s.name}${s.group ? '  ·  ' + s.group : ''}`),
        el('div', { class: 'hint', title: meta }, meta))
      const row = el('div', { class: 'sheet-row sess-row' }, dot, main)
      const connect = el('button', { class: 'ghost' }, '连接')
      connect.addEventListener('click', () => { close(); openTerminal(s) })
      const edit = el('button', { class: 'ghost' }, '编辑')
      edit.addEventListener('click', () => { close(); sshForm(s) })
      const del = el('button', { class: 'ghost danger' }, '删除')
      del.addEventListener('click', () => {
        S.state.settings.sessions = list.filter((x) => x.id !== s.id)
        S.saveSettings()
        row.remove()
      })
      row.append(el('div', { class: 'sheet-actions inline sess-actions' }, connect, edit, del))
      body.append(row)
    }
    const done = el('button', { class: 'primary' }, '完成')
    done.addEventListener('click', () => close())
    body.append(el('div', { class: 'sheet-actions' }, done))
  }, 460)
}

