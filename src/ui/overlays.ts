import { el, clear } from '../lib/dom'
import { icon } from '../lib/icons'

/* ---------------- toast ---------------- */

let toastHost: HTMLElement | null = null

export function toast(message: string, ms = 2000): void {
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' })
    document.body.append(toastHost)
  }
  const node = el('div', { class: 'toast' }, message)
  toastHost.append(node)
  setTimeout(() => {
    node.style.opacity = '0'
    node.style.transition = 'opacity .2s'
    setTimeout(() => node.remove(), 220)
  }, ms)
}

/* ---------------- modal ---------------- */

function modalShell(): { scrim: HTMLElement; modal: HTMLElement; close: () => void } {
  const modal = el('div', { class: 'modal' })
  const scrim = el('div', { class: 'scrim' }, modal)
  document.body.append(scrim)
  const close = () => {
    scrim.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close() }
  }
  document.addEventListener('keydown', onKey, true)
  scrim.addEventListener('mousedown', (ev) => { if (ev.target === scrim) close() })
  return { scrim, modal, close }
}

export interface PromptOptions {
  title: string
  label?: string
  value?: string
  placeholder?: string
  password?: boolean
  confirmText?: string
  cancelText?: string
  note?: string
  validate?: (v: string) => string | null
}

export function prompt(opts: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const { modal, close } = modalShell()
    modal.append(el('h3', {}, opts.title))
    const body = el('div', { class: 'body' })
    if (opts.label) body.append(el('div', { style: { marginBottom: '6px' } }, opts.label))
    const input = el('input', {
      type: opts.password ? 'password' : 'text',
      value: opts.value ?? '',
      placeholder: opts.placeholder ?? '',
      spellcheck: 'false',
      autocomplete: 'off'
    })
    const field = el('div', { class: 'field' }, input)
    body.append(field)
    if (opts.note) body.append(el('div', { style: { color: 'var(--fg-3)', fontSize: '11.5px' } }, opts.note))
    const err = el('div', { class: 'err' }, '')
    const actions = el('div', { class: 'actions' })
    const cancel = el('button', { class: 'ghost' }, opts.cancelText ?? '取消')
    const ok = el('button', { class: 'primary' }, opts.confirmText ?? '确定')
    actions.append(cancel, ok)
    modal.append(body, err, actions)

    const finish = (v: string | null) => { close(); resolve(v) }
    const submit = () => {
      const v = input.value
      const msg = opts.validate?.(v) ?? null
      if (msg) { err.textContent = msg; return }
      finish(v)
    }
    cancel.addEventListener('click', () => finish(null))
    ok.addEventListener('click', submit)
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); submit() }
    })
    setTimeout(() => { input.focus(); input.select() }, 30)
  })
}

export function openSheet(title: string, build: (body: HTMLElement, close: () => void) => void, width = 420, resizable = false): void {
  const { modal, close } = modalShell()
  modal.style.width = `${width}px`
  if (resizable) modal.classList.add('resizable')
  modal.append(el('h3', {}, title))
  const body = el('div', { class: 'body' })
  modal.append(body)
  build(body, close)
}

export function askSave(name: string): Promise<'save' | 'discard' | 'cancel'> {
  return new Promise((resolve) => {
    const { modal, close } = modalShell()
    modal.append(el('h3', {}, `是否保存「${name}」？`))
    modal.append(el('div', { class: 'body' }, '这个文件还没有保存到磁盘。关闭后会丢失未保存的内容。'))
    const actions = el('div', { class: 'actions' })
    const cancel = el('button', { class: 'ghost' }, '取消')
    const discard = el('button', { class: 'ghost' }, '不保存')
    const save = el('button', { class: 'primary' }, '保存…')
    actions.append(cancel, discard, save)
    modal.append(actions)
    const done = (v: 'save' | 'discard' | 'cancel') => { close(); resolve(v) }
    cancel.addEventListener('click', () => done('cancel'))
    discard.addEventListener('click', () => done('discard'))
    save.addEventListener('click', () => done('save'))
    setTimeout(() => save.focus(), 30)
  })
}

export function confirmDialog(title: string, message: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const { modal, close } = modalShell()
    modal.append(el('h3', {}, title))
    modal.append(el('div', { class: 'body' }, message))
    const actions = el('div', { class: 'actions' })
    const cancel = el('button', { class: 'ghost' }, '取消')
    const ok = el('button', { class: 'primary' }, danger ? '删除' : '确定')
    if (danger) { ok.style.background = '#e5484d' }
    actions.append(cancel, ok)
    modal.append(actions)
    cancel.addEventListener('click', () => { close(); resolve(false) })
    ok.addEventListener('click', () => { close(); resolve(true) })
    setTimeout(() => ok.focus(), 30)
  })
}

/* ---------------- context menu ---------------- */

export interface MenuItem {
  header?: boolean
  label?: string
  icon?: string
  danger?: boolean
  sep?: boolean
  sub?: string
  onClick?: () => void
}

let openCtx: HTMLElement | null = null

export function closeContextMenu(): void {
  openCtx?.remove()
  openCtx = null
}

export function contextMenu(x: number, y: number, items: MenuItem[]): void {
  closeContextMenu()
  const menu = el('div', { class: 'ctx' })
  for (const item of items) {
    if (item.sep) { menu.append(el('div', { class: 'sep' })); continue }
    if (item.header) { menu.append(el('div', { class: 'ctx-sec' }, item.label ?? '')); continue }
    const row = el('div', { class: 'mi' + (item.danger ? ' danger' : '') })
    const slot = el('div', { class: 'mi-ic' })
    if (item.icon) slot.append(icon(item.icon))
    row.append(slot, el('span', { class: 'mi-label' }, item.label ?? ''))
    if (item.sub) row.append(el('span', { class: 'sub' }, item.sub))
    row.addEventListener('click', () => { closeContextMenu(); item.onClick?.() })
    menu.append(row)
  }
  document.body.append(menu)
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`
  openCtx = menu
  setTimeout(() => {
    document.addEventListener('mousedown', onClickOutside, true)
    document.addEventListener('keydown', onEsc, true)
  }, 0)
  function onClickOutside(ev: MouseEvent) {
    if (openCtx && !openCtx.contains(ev.target as Node)) destroy()
  }
  function onEsc(ev: KeyboardEvent) {
    if (ev.key === 'Escape') destroy()
  }
  function destroy() {
    closeContextMenu()
    document.removeEventListener('mousedown', onClickOutside, true)
    document.removeEventListener('keydown', onEsc, true)
  }
}

/* ---------------- command palette ---------------- */

export interface PaletteItem {
  id: string
  label: string
  sub?: string
  icon?: string
  keywords?: string
  run: () => void
}

export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let qi = 0
  let score = 0
  let streak = 0
  let last = -2
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      score += 1
      if (i === last + 1) { streak++; score += streak * 4 }
      else streak = 0
      if (i === 0 || '/-_ .'.includes(t[i - 1])) score += 8
      last = i
      qi++
    }
  }
  return qi === q.length ? score : -1
}

export function openPalette(opts: {
  placeholder?: string
  items: PaletteItem[]
  emptyText?: string
}): void {
  const input = el('input', { type: 'text', placeholder: opts.placeholder ?? '搜索…', spellcheck: 'false' })
  const list = el('div', { class: 'list' })
  const panel = el('div', { class: 'palette' }, input, list)
  const scrim = el('div', { class: 'scrim', style: { alignItems: 'flex-start' } }, panel)
  document.body.append(scrim)

  let filtered: PaletteItem[] = opts.items.slice(0, 80)
  let sel = 0

  const render = () => {
    clear(list)
    if (filtered.length === 0) {
      list.append(el('div', { class: 'empty-row' }, opts.emptyText ?? '没有匹配项'))
      return
    }
    filtered.forEach((item, i) => {
      const row = el('div', { class: 'item' + (i === sel ? ' sel' : '') })
      const ic = el('div', { class: 'ic' })
      if (item.icon) ic.append(icon(item.icon))
      row.append(ic, el('span', {}, item.label))
      if (item.sub) row.append(el('span', { class: 'sub' }, item.sub))
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render() } })
      row.addEventListener('click', () => { close(); item.run() })
      list.append(row)
    })
    list.children[sel]?.scrollIntoView({ block: 'nearest' })
  }

  const filter = () => {
    const q = input.value.trim()
    const scored = opts.items
      .map((it) => ({ it, s: fuzzyScore(q, `${it.label} ${it.sub ?? ''} ${it.keywords ?? ''}`) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 80)
      .map((x) => x.it)
    filtered = scored
    sel = 0
    render()
  }

  const close = () => {
    scrim.remove()
    document.removeEventListener('keydown', onKey, true)
  }
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); close() }
    else if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); render() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(sel - 1, 0); render() }
    else if (ev.key === 'Enter') {
      ev.preventDefault()
      const item = filtered[sel]
      if (item) { close(); item.run() }
    }
  }

  input.addEventListener('input', filter)
  document.addEventListener('keydown', onKey, true)
  scrim.addEventListener('mousedown', (ev) => { if (ev.target === scrim) close() })
  render()
  setTimeout(() => input.focus(), 20)
}
