// RPC bridge to the native shell.

export interface BetterNoteBookReply { id: number; ok: boolean; result: any; error: any }

type Pending = { resolve: (v: any) => void; reject: (e: any) => void }

const pending = new Map<number, Pending>()
let seq = 0
const listeners = new Map<string, Set<(payload: any) => void>>()

const hasNative = typeof (window as any).webkit?.messageHandlers?.betternotebook !== 'undefined'

;(window as any).__betternotebookReply = (msg: BetterNoteBookReply) => {
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.result)
  else p.reject(new Error(String(msg.error)))
}

;(window as any).__betternotebookEvent = (msg: { name: string; payload: any }) => {
  const set = listeners.get(msg.name)
  if (set) set.forEach((fn) => fn(msg.payload))
}

export function invoke<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  if (!hasNative) return Promise.reject(new Error('未在 SuperWorkStation 应用中运行'))
  return new Promise<T>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ;(window as any).webkit.messageHandlers.betternotebook.postMessage({ id, method, params })
  })
}

export function onEvent(name: string, fn: (payload: any) => void): () => void {
  if (!listeners.has(name)) listeners.set(name, new Set())
  listeners.get(name)!.add(fn)
  return () => listeners.get(name)?.delete(fn)
}

export function nativeAvailable(): boolean {
  return hasNative
}

/** Open a path in the in-app viewer (betternotebook:// scheme, supports relative assets). */
export function fileURL(path: string): string {
  return 'betternotebook://file' + path.split('/').map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg))).join('/')
}
