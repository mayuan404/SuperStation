import { el, clear } from '../lib/dom'
import { icon } from '../lib/icons'
import { state, saveSettings, type QuickCommand } from '../lib/store'
import { openSheet, toast, confirmDialog } from './overlays'

export type { QuickCommand }

/** 快速命令是全局的，存在设置里，跟着窗口走 */
export function quickCommands(): QuickCommand[] {
  if (!Array.isArray(state.settings.quickCommands)) state.settings.quickCommands = []
  return state.settings.quickCommands
}

function persist(): void {
  state.settings.quickCommands = quickCommands().slice()
  saveSettings()
}

function newId(): string {
  return 'qc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\r/g, '').replace(/\n/g, ' ⏎ ')
  return flat.length > max ? flat.slice(0, max) + '…' : flat
}

/* ---------------- 终端里的选择弹层 ---------------- */

interface PickerHandle {
  anchor: HTMLElement
  destroy: () => void
}

let current: PickerHandle | null = null

export function closeQuickCommandPicker(): void {
  current?.destroy()
}

export interface PickerOptions {
  anchor: HTMLElement
  /** 选中后把内容发给终端 */
  onPick: (cmd: QuickCommand) => void
  /** 打开「管理快速命令」 */
  onManage: () => void
  /** 关掉弹层后归还焦点（终端） */
  onClose?: () => void
}

/** 点「快速命令」后弹出：只列名字，↑↓ 选、回车发、Esc 关 */
export function openQuickCommandPicker(opts: PickerOptions): void {
  const { anchor } = opts
  if (current && current.anchor === anchor) {
    closeQuickCommandPicker()
    opts.onClose?.()
    return
  }
  closeQuickCommandPicker()

  const input = el('input', { class: 'qc-filter', type: 'text', placeholder: '筛选命令…', spellcheck: 'false' })
  const list = el('div', { class: 'qc-list' })
  const empty = el('div', { class: 'qc-empty' })
  const manage = el('button', { class: 'qc-manage' })
  manage.append(icon('settings'), el('span', {}, '管理快速命令…'))
  const pop = el('div', { class: 'qc-pop' }, input, list, empty, manage)
  document.body.append(pop)

  const cmds = quickCommands().slice()
  let filtered: QuickCommand[] = cmds
  let sel = 0

  if (!cmds.length) input.hidden = true

  const render = () => {
    clear(list)
    empty.hidden = filtered.length > 0
    if (!filtered.length) empty.textContent = cmds.length ? '没有匹配的命令' : '还没有快速命令，先添加一条'
    filtered.forEach((cmd, i) => {
      const row = el('div', { class: 'qc-item' + (i === sel ? ' sel' : ''), title: cmd.content })
      row.append(el('span', { class: 'qc-name' }, cmd.name))
      row.addEventListener('mousemove', () => { if (sel !== i) { sel = i; render() } })
      row.addEventListener('click', () => { pick(cmd) })
      list.append(row)
    })
    list.children[sel]?.scrollIntoView({ block: 'nearest' })
  }

  const filter = () => {
    const q = input.value.trim().toLowerCase()
    filtered = q
      ? cmds.filter((c) => c.name.toLowerCase().includes(q) || c.content.toLowerCase().includes(q))
      : cmds
    sel = 0
    render()
  }

  const place = () => {
    const r = anchor.getBoundingClientRect()
    const box = pop.getBoundingClientRect()
    const left = Math.max(8, Math.min(r.left, window.innerWidth - box.width - 8))
    let top = r.bottom + 6
    if (top + box.height > window.innerHeight - 8) top = Math.max(8, r.top - box.height - 6)
    pop.style.left = `${Math.round(left)}px`
    pop.style.top = `${Math.round(top)}px`
  }

  const destroy = () => {
    if (!current) return
    current = null
    document.removeEventListener('keydown', onKey, true)
    document.removeEventListener('mousedown', onOutside, true)
    pop.remove()
    opts.onClose?.()
  }

  const close = () => { destroy() }

  const pick = (cmd: QuickCommand) => {
    destroy()
    opts.onPick(cmd)
  }

  const onOutside = (ev: MouseEvent) => {
    const t = ev.target as Node
    if (pop.contains(t) || anchor.contains(t)) return
    close()
  }

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); return }
    if (!filtered.length) return
    if (ev.key === 'ArrowDown') { ev.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); render() }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); sel = Math.max(sel - 1, 0); render() }
    else if (ev.key === 'Enter') {
      ev.preventDefault()
      const cmd = filtered[sel]
      if (cmd) pick(cmd)
    }
  }

  input.addEventListener('input', filter)
  manage.addEventListener('click', () => { close(); opts.onManage() })
  document.addEventListener('keydown', onKey, true)
  document.addEventListener('mousedown', onOutside, true)
  render()
  place()
  current = { anchor, destroy }
  setTimeout(() => { input.hidden ? manage.focus() : input.focus() }, 20)
}

/* ---------------- 管理面板 ---------------- */

export function openQuickCommandManager(): void {
  openSheet('快速命令', (body, close) => {
    body.append(el('div', { class: 'qc-hint' },
      '这些命令是全局的：SSH 终端右上角点「快速命令」，选一条就会直接发到当前会话。'))

    const listBox = el('div', { class: 'qc-rows' })
    const add = el('button', { class: 'qc-add' })
    add.append(icon('plus'), el('span', {}, '新增命令'))

    const editor = el('div', { class: 'qc-editor' })
    editor.hidden = true
    const nameInput = el('input', { class: 'txt', type: 'text', placeholder: '例如：看磁盘占用', spellcheck: 'false' }) as HTMLInputElement
    const contentInput = el('textarea', {
      class: 'qc-content',
      rows: '3',
      placeholder: '例如：df -h\n可以写多行，按顺序发送',
      spellcheck: 'false'
    }) as HTMLTextAreaElement
    const save = el('button', { class: 'primary' }, '保存')
    const cancel = el('button', { class: 'ghost' }, '取消')
    editor.append(
      el('div', { class: 'qc-edit-title' }, '命令'),
      el('div', { class: 'sheet-row' }, el('div', { class: 'lbl' }, '名称'), nameInput),
      el('div', { class: 'sheet-row col' }, el('div', { class: 'lbl' }, '内容'), contentInput),
      el('div', { class: 'sheet-actions inline' }, cancel, save)
    )

    let editing: QuickCommand | null = null

    const renderList = () => {
      clear(listBox)
      const cmds = quickCommands()
      if (!cmds.length) {
        listBox.append(el('div', { class: 'qc-empty' }, '还没有快速命令，点下面「新增命令」'))
        return
      }
      for (const cmd of cmds) {
        const row = el('div', { class: 'qc-row' })
        const main = el('div', { class: 'qc-main' },
          el('div', { class: 'qc-name' }, cmd.name),
          el('div', { class: 'qc-text' }, oneLine(cmd.content))
        )
        main.addEventListener('click', () => startEdit(cmd))
        const edit = el('button', { class: 'qc-icon-btn', title: '编辑' })
        edit.append(icon('pencil'))
        edit.addEventListener('click', () => startEdit(cmd))
        const del = el('button', { class: 'qc-icon-btn danger', title: '删除' })
        del.append(icon('trash'))
        del.addEventListener('click', async () => {
          if (!(await confirmDialog('删除快速命令', `删除「${cmd.name}」？`, true))) return
          state.settings.quickCommands = quickCommands().filter((x) => x.id !== cmd.id)
          saveSettings()
          if (editing?.id === cmd.id) resetEditor()
          renderList()
          toast('已删除')
        })
        row.append(main, edit, del)
        listBox.append(row)
      }
    }

    const resetEditor = () => {
      editing = null
      nameInput.value = ''
      contentInput.value = ''
      editor.hidden = true
    }

    const startEdit = (cmd: QuickCommand | null) => {
      editing = cmd
      nameInput.value = cmd?.name ?? ''
      contentInput.value = cmd?.content ?? ''
      editor.hidden = false
      editor.scrollIntoView({ block: 'nearest' })
      nameInput.focus()
      nameInput.select()
    }

    const commit = () => {
      const name = nameInput.value.trim()
      const content = contentInput.value.replace(/\s+$/, '')
      if (!name) { toast('给这条命令起个名字'); nameInput.focus(); return }
      if (!content) { toast('命令内容不能为空'); contentInput.focus(); return }
      const list = quickCommands()
      if (editing) {
        editing.name = name
        editing.content = content
      } else {
        list.push({ id: newId(), name, content })
      }
      persist()
      resetEditor()
      renderList()
      toast('已保存')
    }

    add.addEventListener('click', () => startEdit(null))
    cancel.addEventListener('click', () => resetEditor())
    save.addEventListener('click', commit)
    nameInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); contentInput.focus() }
    })
    contentInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); commit() }
    })

    body.append(listBox, add, editor)
    renderList()
  }, 560)
}
