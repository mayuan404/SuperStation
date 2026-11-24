/**
 * 应用级错误记录。
 *
 * 以前错误只经 toast 闪一下，长一点的文案还没看完就没了，事后也没法回查。
 * 这里把失败集中收起来，状态栏显示计数，点开能看到历史（持久化到 localStorage）。
 */

export interface AppError {
  id: string
  at: number
  message: string
}

const KEY = 'sws.errors'
const MAX = 100

let list: AppError[] = load()
const listeners = new Set<() => void>()

function load(): AppError[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '[]') as AppError[]
  } catch {
    return []
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX)))
  } catch {
    /* 存储满了就算了，不影响主流程 */
  }
}

function notify(): void {
  for (const fn of listeners) fn()
}

export function recordError(message: unknown): void {
  const msg = String(message ?? '').trim()
  if (!msg) return
  const now = Date.now()
  // 同一个错误短时间反复触发（重连、轮询之类），只更新时间不刷屏
  if (list[0] && list[0].message === msg && now - list[0].at < 3000) {
    list[0].at = now
    save()
    notify()
    return
  }
  list.unshift({ id: `${now}-${Math.random().toString(36).slice(2, 8)}`, at: now, message: msg })
  if (list.length > MAX) list.length = MAX
  save()
  notify()
}

export function getErrors(): AppError[] {
  return list.slice()
}

export function clearErrors(): void {
  list = []
  save()
  notify()
}

export function subscribeErrors(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}
