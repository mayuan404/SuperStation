export type DocKind = 'text' | 'md' | 'csv' | 'html' | 'json' | 'image' | 'pdf' | 'video' | 'audio' | 'epub' | 'office' | 'browser' | 'terminal' | 'sftp' | 'binary'

const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'tiff', 'heic'])
const VIDEO = new Set(['mp4', 'webm', 'mov', 'm4v'])
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'])
const CSV = new Set(['csv', 'tsv'])
const HTML = new Set(['html', 'htm', 'xhtml'])
const MD = new Set(['md', 'markdown', 'mdx'])

export function detectKind(ext: string): DocKind {
  const e = ext.toLowerCase()
  if (MD.has(e)) return 'md'
  if (CSV.has(e)) return 'csv'
  if (HTML.has(e)) return 'html'
  if (e === 'json') return 'json'
  if (IMAGE.has(e)) return 'image'
  if (e === 'pdf') return 'pdf'
  if (e === 'epub') return 'epub'
  if (['ppt','pptx','pps','ppsx','key','doc','docx','rtf','odt','xls','xlsx','numbers','ods','odp'].includes(e)) return 'office'
  if (VIDEO.has(e)) return 'video'
  if (AUDIO.has(e)) return 'audio'
  return 'text'
}

export function isEditable(kind: DocKind): boolean {
  return kind === 'text' || kind === 'md' || kind === 'csv' || kind === 'html' || kind === 'json'
}

export function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

export function dirname(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function extname(name: string): string {
  const base = basename(name)
  const i = base.lastIndexOf('.')
  return i <= 0 ? '' : base.slice(i + 1).toLowerCase()
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join('/').replace(/\/+/g, '/')
}

export function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function relativeTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = Date.now()
  const diff = (now - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
