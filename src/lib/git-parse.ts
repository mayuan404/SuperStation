// git 输出的纯解析（不碰 DOM / bridge，方便单测）。
// 输入都是真实 `git` 命令的原始输出，格式见各函数注释。

export interface GitFile {
  /** 仓库内相对路径 */
  path: string
  /** 展示用的单字符状态码：M / A / D / R / ?? / U */
  code: string
  staged: boolean
  unstaged: boolean
  untracked: boolean
}

export interface GitStatusParsed {
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
}

export interface GitBranch { name: string; current: boolean }
export interface GitCommit { hash: string; author: string; when: string; subject: string }

function codeOf(x: string, y: string): string {
  const xy = x + y
  if (xy === '??') return '??'
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'U'
  if (x !== ' ') return x            // 暂存的改动优先展示
  if (y !== ' ') return y
  return 'M'
}

/**
 * 解析 `git status --porcelain -z --branch --untracked-files=all`。
 * -z 下条目用 NUL 分隔；重命名/复制（R/C）后面紧跟一个原路径字段，要跳过。
 */
export function parseStatusZ(raw: string): GitStatusParsed {
  const files: GitFile[] = []
  let branch = ''
  let ahead = 0
  let behind = 0

  const tokens = raw.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t) continue

    if (t.startsWith('## ')) {
      const head = t.slice(3)
      const ab = /\[(.*?)\]/.exec(head)
      if (ab) {
        const a = /ahead (\d+)/.exec(ab[1])
        const b = /behind (\d+)/.exec(ab[1])
        if (a) ahead = Number(a[1])
        if (b) behind = Number(b[1])
      }
      const name = head.replace(/\s*\[.*?\]\s*$/, '')
      const sep = name.indexOf('...')
      const b0 = sep >= 0 ? name.slice(0, sep) : name
      branch = b0 === 'HEAD (no branch)' ? '(detached)' : b0
      continue
    }

    if (t.length < 4) continue
    const x = t[0]
    const y = t[1]
    const path = t.slice(3)
    if (x === 'R' || x === 'C') i++   // 跳过紧随其后的原路径
    files.push({
      path,
      code: codeOf(x, y),
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' ',
      untracked: x === '?' && y === '?'
    })
  }
  return { branch, ahead, behind, files }
}

/** 解析 `git branch -a --format='%(refname:short)%09%(HEAD)'` */
export function parseBranches(raw: string): GitBranch[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const name = (tab >= 0 ? line.slice(0, tab) : line).trim()
      const head = tab >= 0 ? line.slice(tab + 1).trim() : ''
      return { name, current: head === '*' }
    })
    .filter((b) => !!b.name && !b.name.endsWith('/HEAD') && b.name !== '(detached)')
}

/** 解析 `git log --pretty=format:'%h%x09%an%x09%ar%x09%s'` */
export function parseLog(raw: string): GitCommit[] {
  return raw
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t')
      return {
        hash: parts[0] ?? '',
        author: parts[1] ?? '',
        when: parts[2] ?? '',
        subject: parts.slice(3).join('\t')
      }
    })
}
