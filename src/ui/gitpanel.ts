// 远端仓库的 Git 面板：变更 / 历史 / diff / 提交 / 分支 / 输出。
// 所有命令都通过 lib/git.ts 走 remote.exec，这里只管交互和渲染。

import { el, clear } from '../lib/dom'
import { basename } from '../lib/files'
import { openSheet, toast, confirmDialog } from './overlays'
import {
  commit, discard, fetchRepo, pullRepo, pushRepo, readBranches, readDiff, readLog, readStatus,
  showCommit, switchBranch, type GitRun
} from '../lib/git'
import type { GitBranch, GitCommit, GitFile, GitStatusParsed } from '../lib/git-parse'

const STATUS_TEXT: Record<string, string> = {
  M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '??': '未跟踪'
}

export interface GitPanelOpts {
  /** 在远端终端里打开这个仓库（冲突要手动解决时用） */
  openTerminal?: () => void
}

export function openGitPanel(treePath: string, title: string, opts: GitPanelOpts = {}): void {
  let status: GitStatusParsed = { branch: '', ahead: 0, behind: 0, files: [] }
  let branches: GitBranch[] = []
  let log: GitCommit[] = []
  let selected = new Set<string>()
  let activePath = ''
  let activeCommit = ''
  let tab: 'changes' | 'history' = 'changes'
  let busy = false

  openSheet(`Git · ${title}`, (body) => {
    /* ---------- 顶部 ---------- */
    const branchSel = el('select', { class: 'git-branch' }) as HTMLSelectElement
    const ab = el('div', { class: 'git-ab' })
    const head = el('div', { class: 'git-head' })
    const mkBtn = (label: string, fn: () => void, titleText?: string) => {
      const b = el('button', { class: 'git-btn', title: titleText ?? label }, label)
      b.addEventListener('click', () => { if (!busy) fn() })
      return b
    }
    const termBtn = mkBtn('终端', () => { opts.openTerminal?.() }, '在当前仓库打开远端终端（冲突处理）')
    termBtn.style.display = opts.openTerminal ? '' : 'none'
    head.append(
      el('span', { class: 'git-chip' }, '分支'),
      branchSel, ab, el('div', { class: 'spacer' }),
      termBtn,
      mkBtn('获取', () => run(fetchRepo(treePath), '已获取', true)),
      mkBtn('拉取', () => run(pullRepo(treePath), '已拉取')),
      mkBtn('推送', () => run(pushRepo(treePath), '已推送')),
      mkBtn('刷新', () => refresh())
    )

    /* ---------- 左：变更 / 历史 + 提交 ---------- */
    const tabChanges = el('button', { class: 'git-tab active' }, '变更')
    const tabHistory = el('button', { class: 'git-tab' }, '历史')
    const tabs = el('div', { class: 'git-tabs' }, tabChanges, tabHistory)
    const listHead = el('div', { class: 'git-list-head' })
    const list = el('div', { class: 'git-list' })
    const warn = el('div', { class: 'git-warn' })
    const msg = el('textarea', { class: 'git-msg', placeholder: '提交信息（⌘⏎ 提交）', rows: '2' }) as HTMLTextAreaElement
    const commitBtn = el('button', { class: 'primary' }, '提交选中')
    const lastLine = el('div', { class: 'git-last' })
    const commitBox = el('div', { class: 'git-commit' }, msg, el('div', { class: 'git-commit-bar' }, lastLine, commitBtn))
    const left = el('div', { class: 'git-left' }, tabs, warn, listHead, list, commitBox)

    /* ---------- 右：diff ---------- */
    const diffName = el('div', { class: 'git-diff-name' }, '选择左侧文件或提交查看改动')
    const diffPre = el('pre', { class: 'git-diff' })
    const right = el('div', { class: 'git-right' }, diffName, diffPre)

    /* ---------- 底部输出 ---------- */
    const out = el('pre', { class: 'git-out' }, '尚未执行命令')

    body.append(head, el('div', { class: 'git-body' }, left, right), out)

    /* ---------- 行为 ---------- */
    function setOutput(runs: GitRun[] | GitRun): void {
      const arr = Array.isArray(runs) ? runs : [runs]
      clear(out)
      for (const r of arr) {
        out.append(el('div', { class: 'git-cmd' }, `$ ${r.cmd}`))
        const text = (r.stdout ?? '').trim()
        if (text) out.append(el('div', {}, text))
        const errText = (r.stderr ?? '').trim()
        if (errText) out.append(el('div', { class: 'git-err' }, errText))
        out.append(el('div', { class: 'git-code' }, `exit ${r.code}`))
      }
      out.scrollTop = out.scrollHeight
    }

    async function run(promise: Promise<GitRun> | Promise<GitRun[]>, doneMsg: string, reportDivergence = false): Promise<void> {
      busy = true
      commitBtn.setAttribute('disabled', '')
      setOutput({ cmd: '执行中…', code: 0, stdout: '', stderr: '' })
      const res = await promise
      const arr = Array.isArray(res) ? res : [res]
      setOutput(arr)
      const failed = arr.some((r) => r.code !== 0)
      if (failed) toast('命令失败，详情见面板底部', 3200)
      busy = false
      commitBtn.removeAttribute('disabled')
      await refresh()
      if (failed) return
      if (reportDivergence && (status.ahead || status.behind)) {
        const bits = []
        if (status.behind) bits.push(`落后 ${status.behind}`)
        if (status.ahead) bits.push(`领先 ${status.ahead}`)
        toast(`${doneMsg} · ${bits.join(' / ')}`, 3000)
      } else {
        toast(doneMsg, 1600)
      }
    }

    async function refresh(): Promise<void> {
      const sres = await readStatus(treePath)
      if (sres.run.code !== 0) {
        clear(list)
        list.append(el('div', { class: 'git-empty' }, '这里不是 git 仓库，或 ssh 未连接'))
        warn.style.display = 'none'
        setOutput(sres.run)
        return
      }
      status = sres.status
      branches = await readBranches(treePath)
      log = await readLog(treePath, 20)
      const alive = new Set(status.files.map((f) => f.path))
      selected = new Set(Array.from(selected).filter((p) => alive.has(p)))
      if (!selected.size) selected = new Set(alive)
      if (activePath && !alive.has(activePath)) { activePath = ''; diffName.textContent = '选择左侧文件或提交查看改动'; clear(diffPre) }
      paintBranches()
      paintWarn()
      paintTabs()
      if (tab === 'changes') paintChanges()
      else paintHistory()
      paintLast()
    }

    function paintBranches(): void {
      clear(branchSel)
      const local = branches.filter((b) => !b.name.includes('/'))
      for (const b of local) {
        branchSel.append(el('option', { value: b.name, selected: b.current ? 'selected' : undefined }, b.name))
      }
      if (!local.length && status.branch) {
        branchSel.append(el('option', { value: status.branch, selected: 'selected' }, status.branch))
      }
      clear(ab)
      if (status.ahead) ab.append(el('span', { class: 'ahead' }, `↑${status.ahead}`))
      if (status.behind) ab.append(el('span', { class: 'behind' }, `↓${status.behind}`))
      if (!status.ahead && !status.behind) ab.append(el('span', { class: 'same' }, '已同步'))
    }

    function paintWarn(): void {
      const conflicts = status.files.filter((f) => f.code === 'U')
      clear(warn)
      warn.style.display = conflicts.length ? '' : 'none'
      if (!conflicts.length) return
      warn.append(el('span', {}, `⚠ ${conflicts.length} 个文件有冲突，需要在终端解决`))
      if (opts.openTerminal) {
        const b = el('button', { class: 'git-link' }, '打开终端')
        b.addEventListener('click', () => opts.openTerminal?.())
        warn.append(b)
      }
    }

    function paintTabs(): void {
      tabChanges.textContent = `变更 ${status.files.length}`
      tabHistory.textContent = '历史'
      tabChanges.classList.toggle('active', tab === 'changes')
      tabHistory.classList.toggle('active', tab === 'history')
      commitBox.style.display = tab === 'changes' ? '' : 'none'
      listHead.style.display = tab === 'changes' ? '' : 'none'
    }

    function paintLast(): void {
      clear(lastLine)
      const c = log[0]
      if (!c) return
      lastLine.append(el('span', { class: 'git-hash' }, c.hash), el('span', {}, ` ${c.subject}`))
      lastLine.title = `${c.hash} ${c.author} ${c.when}\n${c.subject}`
    }

    function paintChanges(): void {
      clear(list)
      const n = status.files.length
      clear(listHead)
      const toggle = el('button', { class: 'git-link' }, n && selected.size === n ? '全不选' : '全选')
      toggle.addEventListener('click', () => {
        selected = selected.size === n ? new Set() : new Set(status.files.map((f) => f.path))
        paintChanges()
      })
      listHead.append(el('span', {}, `已选 ${selected.size} / ${n}`), el('div', { class: 'spacer' }), toggle)

      if (!n) {
        list.append(el('div', { class: 'git-empty' }, '工作区干净，没有需要提交的改动'))
        return
      }

      for (const f of status.files) {
        const row = el('div', { class: 'git-row' + (f.path === activePath ? ' active' : '') })
        const box = el('input', { type: 'checkbox' }) as HTMLInputElement
        box.checked = selected.has(f.path)
        box.addEventListener('change', () => {
          if (box.checked) selected.add(f.path)
          else selected.delete(f.path)
          paintChanges()
        })
        box.addEventListener('click', (ev) => ev.stopPropagation())
        const st = el('span', { class: 'st' }, f.code)
        st.dataset.code = f.code
        st.title = STATUS_TEXT[f.code] ?? f.code
        const nm = el('span', { class: 'nm' }, basename(f.path))
        nm.title = f.path
        const undo = el('button', { class: 'git-row-act', title: f.untracked ? '删除这个未跟踪文件' : '撤销这个文件的改动' }, '撤销')
        undo.addEventListener('click', async (ev) => {
          ev.stopPropagation()
          if (busy) return
          const ok = await confirmDialog(
            f.untracked ? '删除未跟踪文件' : '撤销改动',
            f.untracked
              ? `「${f.path}」还没有进版本库，删除后磁盘上的文件也会消失，无法恢复。`
              : `「${f.path}」的本地改动会丢失，无法恢复。`,
            true
          )
          if (!ok) return
          await run(discard(treePath, f), '已撤销')
        })
        row.append(box, st, nm, undo)
        row.addEventListener('click', () => {
          activePath = f.path
          activeCommit = ''
          for (const r of Array.from(list.querySelectorAll('.git-row'))) r.classList.toggle('active', r === row)
          void showFileDiff(f)
        })
        list.append(row)
      }
    }

    function paintHistory(): void {
      clear(list)
      clear(listHead)
      listHead.append(el('span', {}, `最近 ${log.length} 条提交`))
      if (!log.length) {
        list.append(el('div', { class: 'git-empty' }, '还没有提交记录'))
        return
      }
      for (const c of log) {
        const row = el('div', { class: 'git-row hist' + (c.hash === activeCommit ? ' active' : '') })
        row.append(
          el('span', { class: 'git-hash' }, c.hash),
          el('span', { class: 'nm' }, c.subject),
          el('span', { class: 'git-when' }, c.when.replace(/ ago$/, ''))
        )
        row.title = `${c.hash} · ${c.author} · ${c.when}\n${c.subject}`
        row.addEventListener('click', () => {
          activeCommit = c.hash
          activePath = ''
          for (const r of Array.from(list.querySelectorAll('.git-row'))) r.classList.toggle('active', r === row)
          void showCommitDiff(c)
        })
        list.append(row)
      }
    }

    async function showFileDiff(f: GitFile): Promise<void> {
      diffName.textContent = f.path
      diffPre.textContent = '读取中…'
      const r = await readDiff(treePath, f)
      diffPre.textContent = (r.stdout || '').trim() || (r.stderr || '').trim() || '（没有文本差异，可能是二进制文件）'
      diffPre.scrollTop = 0
    }

    async function showCommitDiff(c: GitCommit): Promise<void> {
      diffName.textContent = `${c.hash} ${c.subject}`
      diffPre.textContent = '读取中…'
      const r = await showCommit(treePath, c.hash)
      diffPre.textContent = (r.stdout || '').trim() || (r.stderr || '').trim() || '（没有内容）'
      diffPre.scrollTop = 0
    }

    tabChanges.addEventListener('click', () => { tab = 'changes'; paintTabs(); paintChanges() })
    tabHistory.addEventListener('click', () => { tab = 'history'; paintTabs(); paintHistory() })

    branchSel.addEventListener('change', async () => {
      const next = branchSel.value
      if (!next || next === status.branch) return
      const ok = await confirmDialog('切换分支', `切到「${next}」？未提交的改动会跟着带过去。`)
      if (!ok) { paintBranches(); return }
      await run(switchBranch(treePath, next), `已切换到 ${next}`)
    })

    commitBtn.addEventListener('click', async () => {
      const text = msg.value.trim()
      if (!text) { toast('先写提交信息'); msg.focus(); return }
      if (!status.files.length) { toast('没有可提交的改动'); return }
      if (!selected.size) { toast('没有勾选任何文件'); return }
      const paths = selected.size === status.files.length ? [] : Array.from(selected)
      await run(commit(treePath, text, paths), '已提交')
      msg.value = ''
    })

    msg.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault()
        commitBtn.click()
      }
    })

    void refresh()
    setTimeout(() => msg.focus(), 60)
  }, 900, true)
}
