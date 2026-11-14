// 远端图片 → 可放进 <img src> 的地址。
//
// betternotebook://file 只服务本机路径（AllowedRoots 白名单），ssh:// 拼出来的
// 地址会被挡成 403（日志里的 `SCHEME 403 //r<rootId>/...`）。所以远端图片先
// 用现成的 remote.download 拉到系统临时目录（两端白名单里都包含临时目录），
// 再交给同一个 scheme 去渲染。

import { fileURL, invoke } from '../lib/bridge'
import { extname, joinPath } from '../lib/files'
import { remoteJoin } from '../lib/paths'
import { tempDir } from '../lib/platform'
import { remoteTargetFor } from '../lib/store'

const ready = new Map<string, string>()
const inflight = new Map<string, Promise<string>>()

function hash(s: string): string {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** 远端图片地址；同一次会话内按路径缓存，失败抛出可读错误 */
export function remoteImageSrc(treePath: string): Promise<string> {
  const done = ready.get(treePath)
  if (done) return Promise.resolve(done)
  const running = inflight.get(treePath)
  if (running) return running

  const job = (async () => {
    const conn = remoteTargetFor(treePath)
    if (!conn) throw new Error('找不到对应的 SSH 连接')
    const ext = extname(conn.abs) || 'bin'
    const dest = joinPath(tempDir(), 'sws-remote-img', `img-${hash(treePath)}.${ext}`)
    const res = await invoke<any>('remote.download', { ...conn.target, path: conn.abs, to: dest })
      .catch((e) => ({ error: e?.message ?? String(e) }))
    if (res?.error) throw new Error(String(res.error).slice(0, 120))
    const url = fileURL(dest)
    ready.set(treePath, url)
    return url
  })()

  inflight.set(treePath, job)
  void job.catch(() => {}).finally(() => inflight.delete(treePath))
  return job
}
