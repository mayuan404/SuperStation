// RPC bridge to the native shell.

export interface BetterNoteBookReply { id: number; ok: boolean; result: any; error: any }

type Pending = { resolve: (v: any) => void; reject: (e: any) => void }

const pending = new Map<number, Pending>()
let seq = 0
const listeners = new Map<string, Set<(payload: any) => void>>()

// macOS: WKWebView message handler；Windows: WebView2 postMessage
const wkHandler = (window as any).webkit?.messageHandlers?.betternotebook
const webview2 = (window as any).chrome?.webview
const hasNative = typeof wkHandler !== 'undefined' || typeof webview2 !== 'undefined'

const settle = (msg: BetterNoteBookReply) => {
  const p = pending.get(msg.id)
  if (!p) return
  pending.delete(msg.id)
  if (msg.ok) p.resolve(msg.result)
  else p.reject(new Error(String(msg.error)))
}

;(window as any).__betternotebookReply = settle

;(window as any).__betternotebookEvent = (msg: { name: string; payload: any }) => {
  const set = listeners.get(msg.name)
  if (set) set.forEach((fn) => fn(msg.payload))
}

if (webview2) {
  webview2.addEventListener('message', (ev: MessageEvent) => {
    const msg = ev.data
    if (!msg) return
    if (typeof msg.id === 'number') settle(msg as BetterNoteBookReply)
    else if (typeof msg.event === 'string') {
      const set = listeners.get(msg.event)
      if (set) set.forEach((fn) => fn(msg.payload))
    }
  })
}

export function invoke<T = any>(method: string, params: Record<string, any> = {}): Promise<T> {
  if (!hasNative) return Promise.reject(new Error('未在 SuperWorkStation 应用中运行'))
  return new Promise<T>((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    if (wkHandler) wkHandler.postMessage({ id, method, params })
    else webview2.postMessage({ id, method, params })
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

export function isWebView2(): boolean {
  return typeof webview2 !== 'undefined'
}

/** Open a path in the in-app viewer (Windows 走本地 http 服务，macOS 走自定义协议). */
export function fileURL(path: string): string {
  if (webview2) {
    const bytes = new TextEncoder().encode(path)
    let binary = ''
    for (const b of bytes) binary += String.fromCharCode(b)
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    return `${location.origin}/__file/${token}`
  }
  return 'betternotebook://file' + path.split('/').map((seg, i) => (i === 0 ? '' : encodeURIComponent(seg))).join('/')
}
