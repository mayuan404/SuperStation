// 远端仓库的 git 操作层：命令统一走 remote.exec（native 只负责跑 shell），
// 解析放在 git-parse.ts，UI 在 ui/gitpanel.ts。

import { invoke } from './bridge'
import { parseBranches, parseLogGraph, parseStatusZ, type GitBranch, type GitCommit, type GitFile, type GitStatusParsed } from './git-parse'

export interface GitRun {
  cmd: string
  code: number
  stdout: string
  stderr: string
}

/** 单引号包裹，供远端 sh 使用 */
export function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

// Windows 端本地命令走 cmd.exe，而这些 git 命令里带 POSIX 重定向（2>/dev/null），
// 在 cmd 下跑不了。所以本地 git 只在 macOS 上启用；Windows 维持原状（不显示 blame）。
const isWindowsShell = typeof (window as any).chrome?.webview !== 'undefined'

export async function gitRun(treePath: string, cmd: string, timeout = 120): Promise<GitRun> {
  const remote = treePath.startsWith('ssh://')
  const method = remote || isWindowsShell ? 'remote.exec' : 'local.exec'
  const res = await invoke<any>(method, { path: treePath, cmd, timeout })
    .catch((e) => ({ error: e?.message ?? String(e) }))
  if (res?.error) return { cmd, code: -1, stdout: '', stderr: String(res.error) }
  return {
    cmd,
    code: Number(res.code ?? 0),
    stdout: String(res.stdout ?? ''),
    stderr: String(res.stderr ?? '')
  }
}

export async function readStatus(treePath: string): Promise<{ status: GitStatusParsed; run: GitRun }> {
  const run = await gitRun(treePath, 'git status --porcelain -z --branch --untracked-files=all', 30)
  if (run.code !== 0) {
    return { status: { branch: '', ahead: 0, behind: 0, files: [] }, run }
  }
  return { status: parseStatusZ(run.stdout), run }
}

export async function readBranches(treePath: string): Promise<GitBranch[]> {
  const run = await gitRun(treePath, "git branch -a --format='%(refname:short)%09%(HEAD)'", 20)
  return run.code === 0 ? parseBranches(run.stdout) : []
}

export interface GitBlame {
  hash: string
  author: string
  time: number
  summary: string
  line: number
  uncommitted: boolean
}

/** 当前目录所属仓库的根（远端绝对路径） */
export async function repoRootOf(dir: string): Promise<string | null> {
  const run = await gitRun(dir, 'git rev-parse --show-toplevel 2>/dev/null', 15)
  const root = run.code === 0 ? run.stdout.trim() : ''
  return root || null
}

/** 单行 blame（relPath 相对仓库根） */
export async function readBlame(dir: string, relPath: string, line: number): Promise<GitBlame | null> {
  const run = await gitRun(
    dir,
    `git -c core.quotePath=false blame --line-porcelain -L ${Math.max(1, line)},${Math.max(1, line)} -- ${shq(relPath)} 2>&1`,
    25
  )
  if (run.code !== 0) return null
  const lines = run.stdout.split('\n')
  const m = (lines[0] ?? '').match(/^([0-9a-f]{7,40})\s/)
  if (!m) return null
  const get = (key: string) => lines.find((l) => l.startsWith(key + ' '))?.slice(key.length + 1) ?? ''
  return {
    hash: m[1],
    author: get('author'),
    time: Number(get('author-time')) || 0,
    summary: get('summary'),
    line,
    uncommitted: /^0+$/.test(m[1])
  }
}

/** 提交详情（stat） */
export async function commitStat(dir: string, hash: string): Promise<GitRun> {
  return gitRun(
    dir,
    `git -c core.quotePath=false show --stat --format='commit %H%n作者: %an <%ae>%n时间: %ad%n%n    %s%n' ${shq(hash)} 2>&1`,
    30
  )
}

export async function readLog(treePath: string, n = 5): Promise<GitCommit[]> {
  // --graph 直接把合并拓扑画出来，省得自己实现泳道算法；--all 让未合并的分支也进图
  const run = await gitRun(
    treePath,
    `git log --graph --date-order --all -n ${Math.max(1, n)} --pretty=format:'%x00%h%x09%an%x09%ar%x09%s'`,
    25
  )
  return run.code === 0 ? parseLogGraph(run.stdout) : []
}

/** 单个文件的改动内容：未跟踪的直接读文件，其余走 diff（-c core.quotePath=false 保证中文路径可读） */
export async function readDiff(treePath: string, file: GitFile): Promise<GitRun> {
  const p = shq(file.path)
  const G = 'git -c core.quotePath=false'
  if (file.untracked) {
    return gitRun(treePath, `echo '--- 新文件（git 尚未跟踪）---'; sed -n '1,300p' -- ${p}`, 20)
  }
  if (file.staged && file.unstaged) {
    return gitRun(treePath, `${G} diff --cached --no-color -- ${p}; echo; echo '--- 工作区未暂存部分 ---'; ${G} diff --no-color -- ${p}`, 20)
  }
  if (file.staged) return gitRun(treePath, `${G} diff --cached --no-color -- ${p}`, 20)
  return gitRun(treePath, `${G} diff --no-color -- ${p}`, 20)
}

/**
 * 提交。paths 为空 = 全部改动（git add -A + 全量提交）；
 * 传了具体路径则只提交这些文件：add 之后用 --only，避免把别人已暂存的内容一起带走。
 */
export async function commit(treePath: string, message: string, paths: string[]): Promise<GitRun[]> {
  const runs: GitRun[] = []
  if (!paths.length) {
    runs.push(await gitRun(treePath, 'git add -A', 60))
    if (runs[0].code !== 0) return runs
    runs.push(await gitRun(treePath, `git commit -m ${shq(message)}`, 120))
    return runs
  }
  const list = paths.map(shq).join(' ')
  runs.push(await gitRun(treePath, `git add -- ${list}`, 60))
  if (runs[0].code !== 0) return runs
  runs.push(await gitRun(treePath, `git commit --only -m ${shq(message)} -- ${list}`, 120))
  return runs
}

/** 撤销单个文件的改动（未跟踪 = 删文件；已暂存 = 同时取消暂存） */
export async function discard(treePath: string, file: GitFile): Promise<GitRun> {
  const p = shq(file.path)
  if (file.untracked) return gitRun(treePath, `rm -f -- ${p}`, 20)
  if (file.staged && file.unstaged) {
    return gitRun(treePath, `git restore --staged --worktree -- ${p} 2>&1 || (git reset -q -- ${p} && git checkout -- ${p})`, 30)
  }
  if (file.staged) {
    return gitRun(treePath, `git restore --staged -- ${p} 2>&1 || git reset -q -- ${p}`, 30)
  }
  return gitRun(treePath, `git restore --worktree -- ${p} 2>&1 || git checkout -- ${p}`, 30)
}

/** 某条 commit 的改动（stat + patch） */
export function showCommit(treePath: string, hash: string): Promise<GitRun> {
  return gitRun(treePath, `git -c core.quotePath=false show --no-color --stat --patch ${shq(hash)}`, 30)
}

export function fetchRepo(treePath: string): Promise<GitRun> {
  return gitRun(treePath, 'git fetch --all --prune 2>&1', 120)
}

export function pullRepo(treePath: string): Promise<GitRun> {
  return gitRun(treePath, 'git pull --ff-only 2>&1', 180)
}

export function pushRepo(treePath: string): Promise<GitRun> {
  return gitRun(treePath, 'git push 2>&1', 180)
}

export function switchBranch(treePath: string, name: string): Promise<GitRun> {
  // 老版本 git 没有 switch，退化用 checkout
  return gitRun(treePath, `git switch ${shq(name)} 2>&1 || git checkout ${shq(name)} 2>&1`, 120)
}
