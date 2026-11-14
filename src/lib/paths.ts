import { basename } from './files'

export interface RemoteRootRef {
  id: string
  path: string
}

/**
 * 远程条目在树里的路径形如 `ssh://<rootId>/<abs>`；本地路径返回 null。
 * 这个前缀只用于让同一棵树区分「哪个 SSH 根」，复制给用户没有意义。
 */
export function parseRemotePath(p: string): { rootId: string; abs: string } | null {
  if (!p.startsWith('ssh://')) return null
  const rest = p.slice('ssh://'.length)
  const i = rest.indexOf('/')
  if (i < 0) return null
  return { rootId: rest.slice(0, i), abs: rest.slice(i) }
}

/** 给人用的路径：远程路径去掉 `ssh://<rootId>` 前缀，本地原样。 */
export function displayPath(p: string): string {
  return parseRemotePath(p)?.abs ?? p
}

/**
 * 在远端目录下解析一个相对路径（用于 md 里的相对图片引用）。
 * 返回 `ssh://<rootId>/<abs>`；外部 URL 或非远端基准返回 null。
 */
export function remoteJoin(baseDir: string, rel: string): string | null {
  const ref = parseRemotePath(baseDir)
  if (!ref) return null
  if (/^[a-z]+:/i.test(rel)) return null
  let clean = rel.split(/[?#]/)[0]
  try { clean = decodeURIComponent(clean) } catch {}
  const parts = clean.startsWith('/') ? [] : ref.abs.split('/').filter(Boolean)
  for (const seg of clean.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return `ssh://${ref.rootId}/${parts.join('/')}`
}

const withoutTrailingSlash = (s: string): string => s.replace(/\/+$/, '')

/**
 * 相对路径：相对所属工作区根（远程按 rootId 找对应根），找不到根时退化为文件名。
 */
export function relativePath(p: string, roots: string[], remoteRoots: RemoteRootRef[]): string {
  const remote = parseRemotePath(p)
  const pairs = remote
    ? remoteRoots.filter((r) => r.id === remote.rootId).map((r) => ({ root: r.path, abs: remote.abs }))
    : roots.map((r) => ({ root: r, abs: p }))

  for (const { root, abs } of pairs) {
    const base = withoutTrailingSlash(root)
    if (abs === base || withoutTrailingSlash(abs) === base) return '.'
    if (abs.startsWith(`${base}/`)) return abs.slice(base.length + 1)
  }
  return basename(p)
}

/** 同时给出两种形态，供复制菜单使用。 */
export function pathVariants(
  p: string,
  roots: string[],
  remoteRoots: RemoteRootRef[]
): { absolute: string; relative: string } {
  return { absolute: displayPath(p), relative: relativePath(p, roots, remoteRoots) }
}
