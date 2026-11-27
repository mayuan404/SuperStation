// 远端仓库的 Git 面板：变更 / 历史 / diff / 提交 / 分支 / 输出。
// 所有命令都通过 lib/git.ts 走 remote.exec，这里只管交互和渲染。

import { el, clear } from '../lib/dom'
import { basename } from '../lib/files'
import { openSheet, toast, confirmDialog } from './overlays'
import {
  commit, discard, fetchRepo, pullRepo, pushRepo, readBranches, readDiff, readLog, readStatus,
  showCommit, switchBranch, type GitRun
} from '../lib/git'
import { graphRowSvg, graphWidth, laneColor, laneCount, layoutGraph, GRAPH_ROW_HEIGHT } from './gitgraph'
import type { GitBranch, GitCommit, GitFile, GitStatusParsed } from '../lib/git-parse'

const STATUS_TEXT: Record<string, string> = {
  M: '修改', A: '新增', D: '删除', R: '重命名', C: '复制', U: '冲突', '??': '未跟踪'
}

export interface GitPanelOpts {
  /** 在远端终端里打开这个仓库（冲突要手动解决时用） */
  openTerminal?: () => void
}

export function openGitPanel(treePath: string, title: string, opts: GitPanelOpts = {}): void {
  openSheet(`Git · ${title}`, (body) => {
    mountGitPanel(body, treePath, title, opts)
  }, 1100, true, 'git-modal')
}

/** 把面板挂到任意容器：标签页里用这个，弹窗只是它的一个外壳 */
export function mountGitPanel(host: HTMLElement, treePath: string, title: string, opts: GitPanelOpts = {}): void {
  let status: GitStatusParsed = { branch: '', ahead: 0, behind: 0, files: [] }
  let branches: GitBranch[] = []
  let log: GitCommit[] = []
  let selected = new Set<string>()
  let activePath = ''
  let activeCommit = ''
  let tab: 'changes' | 'history' = 'changes'
  let busy = false
  // 历史分页：一次 30 条，滚到底再加载，直到没有更多
  const PAGE = 30
  let historyLimit = PAGE
  let historyBusy = false
  let hasMoreHistory = true

  const body = host
  body.classList.add('git-panel-root')
  {
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

    /* ---------- 上：变更 / 历史 + 提交 ---------- */
    const tabChanges = el('button', { class: 'git-tab active' }, '变更')
    const tabHistory = el('button', { class: 'git-tab' }, '历史')
    const tabs = el('div', { class: 'git-tabs' }, tabChanges, tabHistory)
    const listHead = el('div', { class: 'git-list-head' })
    const list = el('div', { class: 'git-list' })
    // 初始就是隐藏：否则在 git status 回来之前会闪一下冲突告警的红框
    const warn = el('div', { class: 'git-warn', style: { display: 'none' } })
    const msg = el('textarea', { class: 'git-msg', placeholder: '提交信息（⌘⏎ 提交）', rows: '2' }) as HTMLTextAreaElement
    const commitBtn = el('button', { class: 'primary' }, '提交选中')
    const lastLine = el('div', { class: 'git-last' })
    const commitBox = el('div', { class: 'git-commit' }, msg, el('div', { class: 'git-commit-bar' }, lastLine, commitBtn))
    const listArea = el('div', { class: 'git-list-area' }, tabs, warn, listHead, list, commitBox)

    /* ---------- 下：diff / 提交详情（整宽，不再挤在右半边） ---------- */
    const diffName = el('div', { class: 'git-diff-name' }, '选择上面的文件或提交查看改动')
    const diffPre = el('pre', { class: 'git-diff' })
    const detail = el('div', { class: 'git-detail' }, diffName, diffPre)

    /* ---------- 底：命令输出（抽屉，默认收起；看历史时不占地方） ---------- */
    const out = el('pre', { class: 'git-out' }, '尚未执行命令')
    const outClose = el('button', { class: 'git-out-close', title: '收起输出' }, '收起')
    const outHead = el('div', { class: 'git-out-head' },
      el('span', {}, '命令输出'), el('div', { class: 'spacer' }), outClose)
    const outWrap = el('div', { class: 'git-out-wrap' }, outHead, out)

    const splitMain = el('div', { class: 'git-hsplit', title: '拖动调整上下比例' })
    const splitOut = el('div', { class: 'git-hsplit', title: '拖动调整输出区高度' })
    const main = el('div', { class: 'git-main' }, listArea, splitMain, detail)
    const foot = el('div', { class: 'git-foot' }, splitOut, outWrap)
    let outOpen = false
    foot.hidden = true

    // 顶部一个「输出」按钮，随时能把抽屉拉出来看最后一次结果
    const outBtn = el('button', { class: 'git-btn', title: '查看命令输出' }, '输出')
    head.insertBefore(outBtn, head.lastChild)

    body.append(head, main, foot)

    const setOutOpen = (open: boolean): void => {
      outOpen = open
      foot.hidden = !open
      outBtn.classList.toggle('on', open)
      if (open) requestAnimationFrame(() => { outWrap.scrollTop = outWrap.scrollHeight })
    }
    outBtn.addEventListener('click', () => setOutOpen(!outOpen))
    outClose.addEventListener('click', () => setOutOpen(false))

    /* ---------- 两处可拖拽分割线 ---------- */
    // 详情/输出的初始高度按窗口估，挂载后再用实测可用高度钳一次
    let detailH = Math.max(150, Math.min(320, Math.round(window.innerHeight * 0.26)))
    let outH = Math.max(120, Math.min(240, Math.round(window.innerHeight * 0.16)))
    const LIST_MIN = 140
    const maxFor = (px: number): number => Math.max(120, Math.min(px, Math.round(window.innerHeight * 0.62)))
    const applySizes = (): void => {
      detail.style.height = `${detailH}px`
      outWrap.style.height = `${outH}px`
    }
    const clampDetail = (): void => {
      const mainH = main.clientHeight
      if (!mainH) return
      // 至少给列表留 LIST_MIN，详情不许把主区撑破（撑破就会被 overflow 裁掉）
      const maxDetail = Math.max(120, mainH - LIST_MIN - 14)
      if (detailH > maxDetail) {
        detailH = maxDetail
        detail.style.height = `${detailH}px`
      }
    }
    detail.style.height = `${detailH}px`
    outWrap.style.height = `${outH}px`
    requestAnimationFrame(clampDetail)
    window.addEventListener('resize', clampDetail)
    function draggable(handle: HTMLElement, size: () => number, apply: (v: number) => void): void {
      handle.addEventListener('mousedown', (ev) => {
        ev.preventDefault()
        const y0 = ev.clientY
        const base = size()
        const move = (e: MouseEvent): void => apply(maxFor(base - (e.clientY - y0)))
        const up = (): void => {
          document.removeEventListener('mousemove', move)
          document.removeEventListener('mouseup', up)
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
        document.addEventListener('mousemove', move)
        document.addEventListener('mouseup', up)
      })
    }
    draggable(splitMain, () => detailH, (v) => { detailH = v; applySizes() })
    draggable(splitOut, () => outH, (v) => { outH = v; applySizes() })

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
      setOutOpen(true)
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
      const [sres, brs, lg] = await Promise.all([
        readStatus(treePath),
        readBranches(treePath),
        readLog(treePath, historyLimit),
      ])
      branches = brs
      log = lg
      hasMoreHistory = log.filter((c) => c.hash).length >= historyLimit
      if (sres.run.code !== 0) {
        clear(list)
        list.append(el('div', { class: 'git-empty' }, '这里不是 git 仓库，或 ssh 未连接'))
        warn.style.display = 'none'
        setOutput(sres.run)
        return
      }
      status = sres.status
      const alive = new Set(status.files.map((f) => f.path))
      selected = new Set(Array.from(selected).filter((p) => alive.has(p)))
      if (!selected.size) selected = new Set(alive)
      if (activePath && !alive.has(activePath)) { activePath = ''; diffName.textContent = '选择上面的文件或提交查看改动'; clear(diffPre) }
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
      commitBox.hidden = tab !== 'changes'
      listHead.style.display = ''
    }

    function paintLast(): void {
      clear(lastLine)
      const c = log.find((x) => x.hash)
      if (!c) return
      lastLine.append(el('span', { class: 'git-hash' }, c.hash), el('span', {}, ` ${c.subject}`))
      lastLine.title = `${c.hash} ${c.author} ${c.when}\n${c.subject}`
    }

    function paintChanges(): void {
      clear(list)
      commitBox.hidden = tab !== 'changes'
      const n = status.files.length
      clear(listHead)
      const toggle = el('button', { class: 'git-link' }, n && selected.size === n ? '全不选' : '全选')
      toggle.addEventListener('click', () => {
        selected = selected.size === n ? new Set() : new Set(status.files.map((f) => f.path))
        paintChanges()
      })
      listHead.append(el('span', {}, `已选 ${selected.size} / ${n}`), el('div', { class: 'spacer' }), toggle)

      if (!n) {
        list.classList.add('is-empty')
        list.append(el('div', { class: 'git-empty' }, '工作区干净，没有需要提交的改动'))
        return
      }
      list.classList.remove('is-empty')

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

    async function loadMoreHistory(): Promise<void> {
      if (historyBusy || !hasMoreHistory) return
      historyBusy = true
      const keep = list.scrollTop
      const foot = list.querySelector('.git-more')
      if (foot) foot.textContent = '加载中…'
      historyLimit = Math.min(historyLimit * 2, 2000)
      const rows = await readLog(treePath, historyLimit)
      log = rows
      hasMoreHistory = rows.filter((c) => c.hash).length >= historyLimit
      historyBusy = false
      paintHistory()
      list.scrollTop = keep
    }

    function paintHistory(): void {
      clear(list)
      list.classList.remove('is-empty')
      clear(listHead)
      const commits = log.filter((c) => c.hash)
      listHead.append(
        el('span', {}, `已加载 ${commits.length} 条提交${hasMoreHistory ? '' : '（全部）'}`),
        el('div', { class: 'spacer' }),
      )
      if (!commits.length) {
        list.append(el('div', { class: 'git-empty' }, '还没有提交记录'))
        return
      }
      const rows = layoutGraph(commits.map((c) => ({ ...c, parents: c.parents ?? [] })))
      const lanes = laneCount(rows)
      const gw = graphWidth(rows)
      for (const r of rows) {
        const c = r.commit as GitCommit
        const row = el('div', { class: 'git-row hist' + (c.hash === activeCommit ? ' active' : '') })
        row.style.height = `${GRAPH_ROW_HEIGHT}px`
        const svg = graphRowSvg(r, lanes, laneColor)
        svg.style.width = `${gw}px`
        svg.style.minWidth = `${gw}px`
        row.append(svg)
        row.append(
          el('span', { class: 'git-hash' }, c.hash),
          el('span', { class: 'nm' }, c.subject),
          el('span', { class: 'git-when' }, c.when.replace(/ ago$/, ''))
        )
        row.title = `${c.hash} · ${c.author} · ${c.when}\n${c.subject}`
        row.addEventListener('click', () => {
          activeCommit = c.hash
          activePath = ''
          for (const rr of Array.from(list.querySelectorAll('.git-row'))) rr.classList.toggle('active', rr === row)
          void showCommitDiff(c)
        })
        list.append(row)
      }
      if (hasMoreHistory) {
        const more = el('div', { class: 'git-more' }, '加载更多…')
        more.addEventListener('click', () => void loadMoreHistory())
        list.append(more)
      }
      // 内容还没占满一屏时不会有滚动事件，主动再拉一页，直到填满或没有更多
      requestAnimationFrame(() => {
        if (tab === 'history' && hasMoreHistory && !historyBusy && list.scrollHeight <= list.clientHeight + 8) {
          void loadMoreHistory()
        }
      })
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

    list.addEventListener('scroll', () => {
      if (tab !== 'history' || historyBusy || !hasMoreHistory) return
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 80) void loadMoreHistory()
    })

    tabChanges.addEventListener('click', () => { tab = 'changes'; paintTabs(); paintChanges() })
    tabHistory.addEventListener('click', () => {
      tab = 'history'
      if (log.filter((c) => c.hash).length < historyLimit) historyLimit = Math.max(PAGE, log.filter((c) => c.hash).length)
      paintTabs()
      paintHistory()
    })

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
    // 只有「变更」页且提交框可见时才抢焦点（历史页里它是隐藏的）
    setTimeout(() => { if (tab === 'changes') msg.focus() }, 60)
  }
}
