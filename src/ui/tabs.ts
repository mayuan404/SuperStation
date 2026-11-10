import { el, clear } from '../lib/dom'
import { fileIcon, icon, iconColor } from '../lib/icons'
import type { Doc } from '../lib/store'

export interface TabActions {
  select(id: string): void
  close(id: string): void
  newTab(): void
  closeMenu(id: string, ev: MouseEvent): void
  move(id: string, beforeId: string | null): void
}

let lastActive: string | null = null

export function renderTabs(host: HTMLElement, docs: Doc[], activeId: string | null, actions: TabActions): void {
  clear(host)
  let dragId: string | null = null

  for (const doc of docs) {
    const active = doc.id === activeId
    const tab = el('div', {
      class: 'tab' + (active ? ' active' : '') + (doc.locked ? ' locked' : ''),
      title: doc.path || doc.name,
      draggable: 'true',
      dataset: { id: doc.id }
    })
    const ic = el('div', { class: 'ic' })
    ic.append(doc.kind === 'browser' ? icon('folder-open') : fileIcon(doc.ext))
    const c = iconColor(doc.ext)
    if (c && doc.kind !== 'browser') ic.style.color = c
    tab.append(ic, el('div', { class: 'nm' }, doc.name))

    const dot = el('div', { class: 'tab-dot' })
    if (doc.issues.length) dot.append(el('div', { class: 'err-dot', title: doc.issues[0].message }))
    else if (doc.dirty) dot.append(el('div', { class: 'dirty' }))
    tab.append(dot)

    if (doc.locked) {
      const lock = el('div', { class: 'tab-lock', title: '已锁定：右键可解锁' })
      lock.append(icon('lock'))
      tab.append(lock)
    } else {
      const close = el('div', { class: 'close' })
      close.append(icon('close'))
      close.addEventListener('click', (ev) => { ev.stopPropagation(); actions.close(doc.id) })
      tab.append(close)
    }

    tab.addEventListener('click', () => actions.select(doc.id))
    tab.addEventListener('auxclick', (ev) => { if (ev.button === 1) actions.close(doc.id) })
    tab.addEventListener('contextmenu', (ev) => { ev.preventDefault(); actions.closeMenu(doc.id, ev) })

    // 拖动排序
    tab.addEventListener('dragstart', (ev) => {
      dragId = doc.id
      ev.dataTransfer?.setData('application/x-bnb-tab', doc.id)
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
      tab.classList.add('dragging')
    })
    tab.addEventListener('dragend', () => {
      dragId = null
      for (const t of Array.from(host.querySelectorAll('.tab'))) {
        t.classList.remove('dragging', 'drop-before', 'drop-after')
      }
    })
    tab.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer?.types.includes('application/x-bnb-tab')) return
      ev.preventDefault()
      if (dragId === doc.id) return
      const r = tab.getBoundingClientRect()
      const before = ev.clientX < r.left + r.width / 2
      tab.classList.toggle('drop-before', before)
      tab.classList.toggle('drop-after', !before)
    })
    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drop-before', 'drop-after')
    })
    tab.addEventListener('drop', (ev) => {
      ev.preventDefault()
      const src = ev.dataTransfer?.getData('application/x-bnb-tab')
      const r = tab.getBoundingClientRect()
      const before = ev.clientX < r.left + r.width / 2
      tab.classList.remove('drop-before', 'drop-after')
      if (!src || src === doc.id) return
      const idx = docs.findIndex((d) => d.id === doc.id)
      const beforeId = before ? doc.id : (docs[idx + 1]?.id ?? null)
      actions.move(src, beforeId)
    })

    host.append(tab)
    if (active && lastActive !== activeId) {
      lastActive = activeId
      requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }

  const add = el('div', { class: 'tab-add', title: '新建临时文件  ⌘N' })
  add.append(icon('plus'))
  add.addEventListener('click', () => actions.newTab())
  host.append(add)
}
