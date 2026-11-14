import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import bash from 'highlight.js/lib/languages/bash'
import json from 'highlight.js/lib/languages/json'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import sql from 'highlight.js/lib/languages/sql'
import java from 'highlight.js/lib/languages/java'
import cpp from 'highlight.js/lib/languages/cpp'
import c from 'highlight.js/lib/languages/c'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import ini from 'highlight.js/lib/languages/ini'
import { fileURL, invoke } from '../lib/bridge'
import { isWindows } from '../lib/platform'
import { dirname, humanSize } from '../lib/files'
import { remoteJoin } from '../lib/paths'
import { el, escapeHTML } from '../lib/dom'
import { icon } from '../lib/icons'
import { toast, openPalette } from '../ui/overlays'
import { installLineSelection, clearLineSelection, installCopyToNative, writeClipboard } from '../lib/textselect'
import { refreshScrollSync } from './scroll-sync'
import { remoteImageSrc } from './remote-image'
import type { Doc } from '../lib/store'

hljs.registerLanguage('javascript', javascript)
hljs.registerLanguage('typescript', typescript)
hljs.registerLanguage('python', python)
hljs.registerLanguage('go', go)
hljs.registerLanguage('rust', rust)
hljs.registerLanguage('bash', bash)
hljs.registerLanguage('shell', bash)
hljs.registerLanguage('json', json)
hljs.registerLanguage('css', css)
hljs.registerLanguage('xml', xml)
hljs.registerLanguage('html', xml)
hljs.registerLanguage('sql', sql)
hljs.registerLanguage('java', java)
hljs.registerLanguage('cpp', cpp)
hljs.registerLanguage('c', c)
hljs.registerLanguage('yaml', yaml)
hljs.registerLanguage('markdown', markdown)
hljs.registerLanguage('ini', ini)
hljs.registerLanguage('toml', ini)

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[`*_~\[\]()#!>]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value
      } catch {}
    }
    return escapeHTML(str)
  }
})

// 给每个标题生成 GitHub 风格的 id，目录/锚点链接才能生效
md.core.ruler.push('bnb_heading_ids', (state: any) => {
  const used = new Map<string, number>()
  for (let i = 0; i < state.tokens.length; i++) {
    const t = state.tokens[i]
    if (t.type !== 'heading_open') continue
    const inline = state.tokens[i + 1]
    const raw = String(inline?.content ?? '').replace(/`/g, '')
    let slug = slugify(raw) || `section-${i}`
    const n = used.get(slug) ?? 0
    used.set(slug, n + 1)
    if (n > 0) slug = `${slug}-${n}`
    t.attrSet('id', slug)
  }
})

// 给顶层块记下源文件行号（渲染成 data-line），编辑/预览滚动同步拿它当锚点
md.core.ruler.push('bnb_block_lines', (state: any) => {
  for (const t of state.tokens) {
    if (t.level === 0 && t.nesting >= 0 && t.map) t.attrSet('data-line', String(t.map[0]))
  }
})

function normalize(base: string, rel: string): string {
  let p = rel
  let suffix = ''
  const q = p.search(/[?#]/)
  if (q >= 0) { suffix = p.slice(q); p = p.slice(0, q) }
  try { p = decodeURIComponent(p) } catch {}
  if (p.startsWith('/')) {
    return p.split('/').reduce<string[]>((acc, seg) => {
      if (seg === '..') acc.pop()
      else if (seg !== '.' && seg !== '') acc.push(seg)
      return acc
    }, []).join('/').replace(/^/, '/') + suffix
  }
  const parts = base.split('/').filter(Boolean)
  for (const seg of p.split('/')) {
    if (seg === '..') parts.pop()
    else if (seg !== '.' && seg !== '') parts.push(seg)
  }
  return '/' + parts.join('/') + suffix
}

/** 1x1 透明占位：远端图片要异步取回，先占住位置避免弹出破图图标 */
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

md.renderer.rules.image = (tokens, idx, options, env) => {
  const token = tokens[idx]
  const src = String(token.attrGet('src') || '')
  if (!/^(https?:|data:|blob:|betternotebook:)/i.test(src)) {
    const base = String((env as any).basePath || '/')
    if (base.startsWith('ssh://')) {
      // 远端文档：本地 scheme 读不到，先记下相对路径，渲染完再异步换成真实地址
      token.attrSet('data-remote-src', src)
      token.attrSet('src', BLANK_IMG)
    } else {
      token.attrSet('src', fileURL(normalize(base, src)))
    }
  }
  token.attrSet('loading', 'lazy')
  token.attrSet('alt', token.content ? escapeHTML(token.content) : '')
  return md.renderer.renderToken(tokens, idx, options)
}

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const href = String(tokens[idx].attrGet('href') || '')
  if (/^https?:/i.test(href)) tokens[idx].attrSet('target', '_blank')
  return self.renderToken(tokens, idx, options)
}

// 代码块统一包一层容器，右上角挂复制按钮（点击由 preview 的委托处理器接管）
function copyButton(extraClass = ''): HTMLButtonElement {
  return el('button', {
    type: 'button',
    class: `md-code-copy${extraClass ? ' ' + extraClass : ''}`,
    title: '复制代码',
    'aria-label': '复制代码'
  }, '复制')
}

/** fence 走字符串渲染，这里复用同一份按钮标记，避免两处各写一遍 */
const COPY_BTN_HTML = copyButton().outerHTML

md.renderer.rules.fence = (tokens, idx, options) => {
  const token = tokens[idx]
  const info = String(token.info || '').trim()
  const lang = info.split(/\s+/)[0] || ''
  const body = (options.highlight
    ? options.highlight(token.content, lang, '')
    : '') || escapeHTML(token.content)
  const cls = lang ? ` class="language-${escapeHTML(lang)}"` : ''
  const dl = token.attrGet('data-line')
  const anchor = dl === null || dl === undefined ? '' : ` data-line="${escapeHTML(String(dl))}"`
  return `<div class="md-code"${anchor}><pre><code${cls}>${body}</code></pre>${COPY_BTN_HTML}</div>\n`
}

/** 复制按钮的点击处理（命中按钮返回 true），md / json 等预览共用同一份逻辑 */
function handleCopyClick(ev: MouseEvent): boolean {
  const btn = (ev.target as HTMLElement | null)?.closest('.md-code-copy') as HTMLElement | null
  if (!btn) return false
  ev.preventDefault()
  const code = btn.closest('.md-code, .json-scroll')?.querySelector('pre')?.textContent ?? ''
  writeClipboard(code).catch(() => {})
  btn.textContent = '已复制'
  btn.classList.add('copied')
  const prevTimer = (btn as any).__copyTimer as number | undefined
  if (prevTimer) window.clearTimeout(prevTimer)
  ;(btn as any).__copyTimer = window.setTimeout(() => {
    btn.textContent = '复制'
    btn.classList.remove('copied')
  }, 1200)
  return true
}

/* ---------------- CSV ---------------- */

function detectDelimiter(text: string): string {
  const line = text.slice(0, 4000).split('\n')[0] ?? ''
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 }
  let inQ = false
  for (const ch of line) {
    if (ch === '"') inQ = !inQ
    else if (!inQ && ch in counts) counts[ch]++
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
}

export function parseCSV(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cur = ''
  let inQ = false
  let i = 0
  while (i < text.length) {
    const c = text[i]
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue }
        inQ = false; i++; continue
      }
      cur += c; i++; continue
    }
    if (c === '"') { inQ = true; i++; continue }
    if (c === delim) { row.push(cur); cur = ''; i++; continue }
    if (c === '\r') { i++; continue }
    if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; i++; continue }
    cur += c; i++
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row) }
  return rows
}

function renderCSV(doc: Doc): HTMLElement {
  const delim = detectDelimiter(doc.text)
  const rows = parseCSV(doc.text, delim)
  const limit = 3000
  const shown = rows.slice(0, limit)
  const head = shown[0] ?? []
  const body = shown.slice(1)

  const table = el('table')
  const thead = el('thead')
  const htr = el('tr')
  htr.append(el('th', { class: 'rownum' }, '#'))
  head.forEach((h, i) => htr.append(el('th', {}, h || `列 ${i + 1}`)))
  thead.append(htr)
  table.append(thead)

  const tbody = el('tbody')
  body.forEach((r, ri) => {
    const tr = el('tr')
    tr.append(el('td', { class: 'rownum' }, String(ri + 1)))
    for (let c = 0; c < Math.max(head.length, r.length); c++) tr.append(el('td', { title: r[c] ?? '' }, r[c] ?? ''))
    tbody.append(tr)
  })
  table.append(tbody)

  const wrap = el('div', { class: 'csv-wrap' })
  const meta = el('div', { class: 'csv-meta' },
    `${rows.length} 行 × ${Math.max(head.length, ...body.map((r) => r.length))} 列 · 分隔符「${delim === '\t' ? '\\t' : delim}」`,
    rows.length > limit ? ` · 仅显示前 ${limit} 行` : '')
  wrap.append(meta, el('div', { class: 'csv-scroll' }, table))
  return wrap
}

/* ---------------- image ---------------- */

/** 远端 md 里的相对图片：渲染完再逐个取回，成功就替换占位图 */
function hydrateRemoteImages(article: HTMLElement, doc: Doc): void {
  const imgs = Array.from(article.querySelectorAll<HTMLImageElement>('img[data-remote-src]'))
  for (const img of imgs) {
    const rel = img.dataset.remoteSrc || ''
    const treePath = remoteJoin(dirname(doc.path), rel)
    if (!treePath) continue
    remoteImageSrc(treePath)
      .then((url) => {
        img.src = url
        img.removeAttribute('data-remote-src')
      })
      .catch(() => {
        img.removeAttribute('data-remote-src')
        img.classList.add('md-img-failed')
        img.setAttribute('title', `图片无法加载：${rel}`)
        img.alt = `图片无法加载：${rel}`
      })
  }
}

function renderImage(doc: Doc): HTMLElement {
  const remote = doc.path.startsWith('ssh://')
  // 本地直接走自定义 scheme；远端先占位，取回后再换 src（见 remote-image.ts）
  const img = el('img', remote ? { alt: doc.name, draggable: 'false' } : { src: fileURL(doc.path), alt: doc.name, draggable: 'false' })
  const sizeLabel = el('span', {}, '')
  const zoomLabel = el('span', {}, '100%')
  const info = el('div', { class: 'image-info' }, sizeLabel, el('span', {}, '·'), zoomLabel)

  let zoom = 1
  let panX = 0
  let panY = 0
  const apply = () => {
    img.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`
  }
  const setZoom = (next: number, cx = 0, cy = 0) => {
    const z = Math.min(12, Math.max(0.05, next))
    const px = (cx - panX) / zoom
    const py = (cy - panY) / zoom
    panX = cx - px * z
    panY = cy - py * z
    zoom = z
    apply()
  }

  const wrap = el('div', { class: 'image-wrap' }, img, info)
  wrap.tabIndex = 0

  img.addEventListener('load', () => {
    sizeLabel.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`
  })

  // 解码失败（HEIC/TIFF 这类引擎不支持的格式，或远端读取失败）时给一个明确的落点，
  // 而不是留一个破图图标让人以为是文件坏了
  let failed = false
  const fail = (reason?: string) => {
    if (failed) return
    failed = true
    img.style.display = 'none'
    info.style.display = 'none'
    const box = el('div', { class: 'image-fail' })
    box.append(
      el('div', { class: 'image-fail-name' }, doc.name),
      el('div', { class: 'image-fail-sub' }, reason ? `无法预览：${reason}` : '这个格式无法直接预览'),
      el('div', { class: 'image-fail-hint' },
        remote ? '可以先「下载到…」再打开' : '可以点下面的按钮用系统默认程序打开')
    )
    if (!remote) {
      const btn = el('button', { class: 'ghost' }, '用默认程序打开')
      btn.addEventListener('click', () => { invoke('ui.openPath', { path: doc.path }).catch(() => {}) })
      box.append(btn)
    }
    wrap.append(box)
  }

  if (remote) {
    remoteImageSrc(doc.path).then((url) => { img.src = url }).catch((e) => fail(String(e?.message ?? e)))
  }

  wrap.addEventListener('wheel', (ev) => {
    ev.preventDefault()
    const r = wrap.getBoundingClientRect()
    setZoom(zoom * Math.exp(-ev.deltaY * 0.0018), ev.clientX - r.left - r.width / 2, ev.clientY - r.top - r.height / 2)
  }, { passive: false })

  let dragging = false
  let sx = 0
  let sy = 0
  wrap.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0) return
    dragging = true
    sx = ev.clientX - panX
    sy = ev.clientY - panY
    wrap.classList.add('grabbing')
  })
  window.addEventListener('mousemove', (ev) => {
    if (!dragging) return
    panX = ev.clientX - sx
    panY = ev.clientY - sy
    apply()
  })
  window.addEventListener('mouseup', () => {
    dragging = false
    wrap.classList.remove('grabbing')
  })

  img.addEventListener('error', () => { if (img.getAttribute('src')) fail() })
  wrap.addEventListener('dblclick', () => { zoom = 1; panX = 0; panY = 0; apply() })
  wrap.addEventListener('keydown', (ev) => {
    if (ev.key === '+' || ev.key === '=') { setZoom(zoom * 1.25); ev.preventDefault() }
    else if (ev.key === '-') { setZoom(zoom / 1.25); ev.preventDefault() }
    else if (ev.key === '0') { zoom = 1; panX = 0; panY = 0; apply(); ev.preventDefault() }
  })
  return wrap
}

/* ---------------- pdf ---------------- */

function renderPDF(doc: Doc): HTMLElement {
  const scroll = el('div', { class: 'pdf-scroll' })
  const pagesHost = el('div', { class: 'pdf-pages' })
  scroll.append(pagesHost)

  const zoomLabel = el('span', { class: 'pdf-zoom' }, '100%')
  const countLabel = el('span', { class: 'pdf-count' }, '')
  const btnOut = el('button', { class: 'pdf-btn', title: '缩小 ⌘-' })
  btnOut.append(icon('zoom-out'))
  const btnIn = el('button', { class: 'pdf-btn', title: '放大 ⌘+' })
  btnIn.append(icon('zoom-in'))
  const btnFit = el('button', { class: 'pdf-btn', title: '适应宽度' })
  btnFit.append(icon('fit'))
  const hint = el('span', { class: 'pdf-hint' }, '⌘/Ctrl + 滚轮缩放')
  const toolbar = el('div', { class: 'pdf-toolbar' }, btnOut, zoomLabel, btnIn, btnFit, hint, countLabel)

  let zoom = 1
  let pages: { width: number; height: number }[] = []
  let renderToken = 0

  const applyZoom = () => {
    zoom = Math.min(4, Math.max(0.25, zoom))
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`
    const hostW = scroll.clientWidth - 48
    pagesHost.style.setProperty('--pdf-zoom', String(zoom))
    for (const [i, p] of pages.entries()) {
      const node = pagesHost.children[i] as HTMLElement | undefined
      if (!node) continue
      const w = Math.min(hostW * 3, p.width * zoom)
      node.style.width = `${w}px`
      node.style.height = `${(p.height / p.width) * w}px`
    }
  }

  const loadPage = async (i: number) => {
    const node = pagesHost.children[i] as HTMLElement | undefined
    if (!node || node.dataset.loaded) return
    node.dataset.loaded = '1'
    try {
      const r = await invoke<{ file: string }>('pdf.render', { path: doc.path, page: i, width: 1400 })
      if (r?.file) {
        node.replaceChildren(el('img', { src: fileURL(r.file), alt: `第 ${i + 1} 页` }))
      }
    } catch {
      node.dataset.loaded = ''
    }
  }

  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const idx = Number((e.target as HTMLElement).dataset.page)
        loadPage(idx)
      }
    }
  }, { root: scroll, rootMargin: '600px' })

  invoke<{ count: number; pages: { width: number; height: number }[] }>('pdf.info', { path: doc.path })
    .then((info) => {
      if (!info) { pagesHost.append(el('div', { class: 'pdf-error' }, '无法打开 PDF')); return }
      pages = info.pages
      countLabel.textContent = `${info.count} 页`
      pagesHost.replaceChildren()
      pages.forEach((p, i) => {
        const page = el('div', { class: 'pdf-page', dataset: { page: String(i) } })
        page.append(el('div', { class: 'pdf-loading' }, String(i + 1)))
        observer.observe(page)
        pagesHost.append(page)
      })
      applyZoom()
    })
    .catch(() => pagesHost.append(el('div', { class: 'pdf-error' }, '无法打开 PDF')))

  scroll.addEventListener('wheel', (ev) => {
    // 普通滚轮/触摸板滑动 = 上下翻页；⌘(Ctrl) + 滚轮 / 双指捏合 = 缩放
    if (!ev.ctrlKey && !ev.metaKey) return
    ev.preventDefault()
    zoom *= Math.exp(-ev.deltaY * 0.0015)
    applyZoom()
  }, { passive: false })

  // drag to pan when zoomed in
  let panning = false
  let panX = 0
  let panY = 0
  let originL = 0
  let originT = 0
  scroll.addEventListener('mousedown', (ev) => {
    if (ev.button !== 0 || ev.target !== scroll) return
    panning = true
    panX = ev.clientX
    panY = ev.clientY
    originL = scroll.scrollLeft
    originT = scroll.scrollTop
    scroll.classList.add('grabbing')
  })
  window.addEventListener('mousemove', (ev) => {
    if (!panning) return
    scroll.scrollLeft = originL - (ev.clientX - panX)
    scroll.scrollTop = originT - (ev.clientY - panY)
  })
  window.addEventListener('mouseup', () => {
    panning = false
    scroll.classList.remove('grabbing')
  })

  scroll.addEventListener('keydown', (ev) => {
    if (ev.key === '+' || ev.key === '=') { zoom *= 1.2; applyZoom(); ev.preventDefault() }
    else if (ev.key === '-') { zoom /= 1.2; applyZoom(); ev.preventDefault() }
    else if (ev.key === '0') { zoom = 1; applyZoom(); ev.preventDefault() }
  })
  scroll.tabIndex = 0

  btnIn.addEventListener('click', () => { zoom *= 1.2; applyZoom() })
  btnOut.addEventListener('click', () => { zoom /= 1.2; applyZoom() })
  btnFit.addEventListener('click', () => {
    if (!pages.length) return
    const hostW = scroll.clientWidth - 48
    zoom = hostW / pages[0].width
    applyZoom()
  })

  window.addEventListener('resize', () => applyZoom())

  return el('div', { class: 'pdf-view' }, toolbar, scroll)
}

/* ---------------- epub ---------------- */

function renderEPUB(doc: Doc): HTMLElement {
  const body = el('article', { class: 'md epub-body' })
  const scroll = el('div', { class: 'epub-scroll', tabIndex: 0 }, body)
  const titleEl = el('div', { class: 'epub-title' }, '加载中…')
  const counter = el('div', { class: 'epub-count' }, '')

  const btnPrev = el('button', { class: 'pdf-btn', title: '上一节  ←' })
  btnPrev.append(icon('chevron'))
  btnPrev.classList.add('flip')
  const btnNext = el('button', { class: 'pdf-btn', title: '下一节  →' })
  btnNext.append(icon('chevron'))
  const btnToc = el('button', { class: 'pdf-btn epub-toc-btn', title: '目录' })
  btnToc.append(icon('book'))

  const toolbar = el('div', { class: 'pdf-toolbar epub-toolbar' }, btnPrev, btnNext, btnToc, titleEl, el('div', { class: 'spacer' }), counter)
  const view = el('div', { class: 'epub-view' }, toolbar, scroll)

  let chapters: { file: string; label: string }[] = []
  let toc: { file: string; label: string; href: string }[] = []
  let index = 0
  let meta: any = null

  const save = () => { try { localStorage.setItem(`bnb.epub.${doc.path}`, String(index)) } catch {} }

  const load = async (i: number) => {
    if (!chapters.length) return
    index = Math.min(Math.max(0, i), chapters.length - 1)
    const ch = chapters[index]
    titleEl.textContent = ch.label || `第 ${index + 1} 节`
    counter.textContent = `${index + 1} / ${chapters.length}`
    try {
      const res = await invoke<{ text: string }>('fs.read', { path: ch.file })
      body.innerHTML = rewriteChapter(res.text ?? '', ch.file, chapters)
      if (index === 0) prependBookHeader(body, meta)
      scroll.scrollTop = 0
      save()
    } catch (err: any) {
      body.innerHTML = `<p style="color:var(--fg-3)">无法读取章节：${err?.message ?? ''}</p>`
    }
  }

  btnPrev.addEventListener('click', () => load(index - 1))
  btnNext.addEventListener('click', () => load(index + 1))
  btnToc.addEventListener('click', () => {
    const items = chapters.map((c, i) => ({
      id: String(i),
      label: c.label || `第 ${i + 1} 节`,
      sub: `${i + 1}`,
      icon: 'file',
      run: () => load(i)
    }))
    openPalette({ placeholder: '跳转到章节…', items, emptyText: '没有目录' })
  })

  body.addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement).closest('a')
    if (!a) return
    ev.preventDefault()
    const ch = a.getAttribute('data-chapter')
    if (ch !== null) { load(Number(ch)); return }
    const href = a.getAttribute('href') || ''
    if (/^https?:/i.test(href)) invoke('ui.openExternal', { url: href })
    else if (href.startsWith('#')) {
      let id = href.slice(1)
      try { id = decodeURIComponent(id) } catch {}
      const target = body.querySelector(`[id="${id}"], [name="${id}"]`)
      if (target) scrollTo(body, target)
    }
  })

  scroll.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown') { ev.preventDefault(); load(index + 1) }
    else if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') { ev.preventDefault(); load(index - 1) }
  })

  invoke<any>('epub.info', { path: doc.path })
    .then((info) => {
      meta = info
      chapters = info?.chapters ?? []
      toc = info?.toc ?? []
      if (!chapters.length) {
        body.innerHTML = '<p style="color:var(--fg-3)">这本 EPUB 没有可读章节</p>'
        return
      }
      let saved = 0
      try { saved = Number(localStorage.getItem(`bnb.epub.${doc.path}`) ?? '0') || 0 } catch {}
      load(Math.min(saved, chapters.length - 1))
    })
    .catch((err) => { body.innerHTML = `<p style="color:var(--fg-3)">无法打开 EPUB：${err?.message ?? ''}</p>` })

  return view
}

function rewriteChapter(raw: string, file: string, chapters: { file: string }[]): string {
  const d = new DOMParser().parseFromString(raw, 'text/html')
  d.querySelectorAll('script, iframe, object, embed').forEach((n) => n.remove())
  const base = dirname(file)

  d.querySelectorAll('img').forEach((img) => {
    const src = img.getAttribute('src')
    if (!src || /^(https?:|data:)/i.test(src)) return
    img.setAttribute('src', fileURL(normalize(base, src)))
    img.removeAttribute('width')
    img.removeAttribute('height')
  })
  d.querySelectorAll('image').forEach((img) => {
    const src = img.getAttribute('xlink:href') || img.getAttribute('href')
    if (!src || /^(https?:|data:)/i.test(src)) return
    img.setAttribute('href', fileURL(normalize(base, src)))
  })

  d.querySelectorAll('a').forEach((a) => {
    const href = a.getAttribute('href')
    if (!href) return
    if (/^https?:/i.test(href)) { a.setAttribute('target', '_blank'); return }
    if (href.startsWith('#')) return
    const target = normalize(base, href.split('#')[0])
    const idx = chapters.findIndex((c) => c.file === target)
    if (idx >= 0) {
      a.setAttribute('data-chapter', String(idx))
      a.setAttribute('href', '#')
    }
  })
  return d.body.innerHTML
}

function prependBookHeader(body: HTMLElement, meta: any): void {
  if (!meta) return
  const head = el('div', { class: 'epub-cover' })
  if (meta.cover) {
    const img = el('img', { src: fileURL(meta.cover), alt: meta.title || '' })
    head.append(img)
  }
  const info = el('div', { class: 'epub-meta' })
  info.append(el('h1', {}, meta.title || ''))
  if (meta.author) info.append(el('div', { class: 'epub-author' }, meta.author))
  head.append(info)
  body.prepend(head)
}

/* ---------------- office ---------------- */

function renderOffice(doc: Doc): HTMLElement {
  const wrap = el('div', { class: 'office-view' })
  const img = el('img', { class: 'office-thumb', alt: doc.name })
  img.style.display = 'none'
  const hint = el('div', { class: 'office-hint' }, '正在生成预览…')
  const btn = el('button', { class: 'primary' }, isWindows() ? '用默认应用打开' : '在「快速查看」中打开')
  btn.addEventListener('click', () => invoke('office.quickLook', { path: doc.path }).catch(() => {}))
  wrap.append(img, hint, btn)

  invoke<{ file: string } | null>('office.thumb', { path: doc.path })
    .then((r) => {
      if (r?.file) {
        img.src = fileURL(r.file)
        img.style.display = 'block'
        hint.textContent = '第一页预览 · 完整内容请在「快速查看」中查看'
      } else {
        hint.textContent = '无法生成预览：加密目录需要先解锁；文件较大时也可能超时'
      }
    })
    .catch(() => { hint.textContent = '预览失败' })
  return wrap
}

/* ---------------- rich ---------------- */

function renderHTML(doc: Doc): HTMLElement {
  // 远端（ssh://）文档没有本地文件：betternotebook://file 只服务本机路径，早先会把
  // ssh:// 拼成 // 开头的路径，被 AllowedRoots 挡成 403（日志里那串 SCHEME 403）。
  // 远端改用已读到的正文做 blob，本地仍走自定义 scheme（保留相对资源加载）。
  const remote = doc.path.startsWith('ssh://')
  const blob = remote ? URL.createObjectURL(new Blob([doc.text || ''], { type: 'text/html' })) : ''
  const iframe = el('iframe', {
    src: remote ? blob : fileURL(doc.path),
    sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-downloads',
    style: { border: '0', width: '100%', height: '100%', background: '#fff' }
  })
  if (blob) {
    iframe.addEventListener('load', () => setTimeout(() => URL.revokeObjectURL(blob), 1000), { once: true })
  }
  // iframe 里也按行选：双击选整行、三击选段落
  const wire = () => {
    try {
      const w = iframe.contentWindow
      if (w && w.document && !(w as any).__lineSelect) {
        ;(w as any).__lineSelect = true
        installLineSelection(w.document.body as HTMLElement)
      }
    } catch {}
  }
  iframe.addEventListener('load', wire)
  return el('div', { style: { height: '100%', background: '#fff' } }, iframe)
}

function renderMedia(doc: Doc): HTMLElement {
  const tag = doc.kind === 'audio' ? 'audio' : 'video'
  const node = el(tag as any, { src: fileURL(doc.path), controls: 'true', style: { maxWidth: '90%', maxHeight: '80%' } })
  return el('div', { class: 'image-wrap' }, node)
}

function renderBinary(doc: Doc): HTMLElement {
  const box = el('div', { class: 'empty' })
  box.append(el('div', { class: 'logo' }, '◆'))
  box.append(el('h1', {}, doc.name))
  box.append(el('p', {}, `二进制文件 · ${humanSize(doc.size)}`))
  return box
}

/* ---------------- main ---------------- */

function scrollTo(article: HTMLElement, target: Element): void {
  const scroller = article.closest('.preview-scroll') as HTMLElement | null
  if (!scroller) { (target as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'start' }); return }
  const sr = scroller.getBoundingClientRect()
  const tr = (target as HTMLElement).getBoundingClientRect()
  const top = tr.top - sr.top + scroller.scrollTop - 16
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

export function renderPreview(host: HTMLElement, doc: Doc | null): void {
  const prevId = (host as any).__docId as string | undefined
  const prevScroll = (host.querySelector('.preview-scroll') as HTMLElement | null)?.scrollTop ?? 0
  clearLineSelection(host)
  host.innerHTML = ''
  if (!doc) { (host as any).__docId = undefined; return }
  buildPreview(host, doc)
  // 双击选整行 / 三击选段落（CodeMirror 之外的所有预览都用这一套）
  if (doc.kind !== 'html') {
    installLineSelection(host)
    // 预览里的 ⌘C 走原生剪贴板，避免 WKWebView 里 select 后复制不生效
    installCopyToNative(host)
  }
  const sc = host.querySelector('.preview-scroll') as HTMLElement | null
  if (sc) sc.scrollTop = prevId === doc.id ? prevScroll : 0
  ;(host as any).__docId = doc.id
  // 预览重建后重新绑定滚动同步（容器是新的，旧锚点也失效了）
  refreshScrollSync()
}

function buildPreview(host: HTMLElement, doc: Doc): void {

  if (doc.kind === 'md') {
    const article = el('article', { class: 'md' })
    article.innerHTML = md.render(doc.text, { basePath: dirname(doc.path) })
    if (doc.path.startsWith('ssh://')) hydrateRemoteImages(article, doc)
    article.addEventListener('click', (ev) => {
      if (handleCopyClick(ev)) return
      const hit = ev.target as HTMLElement
      const a = hit.closest('a')
      if (!a) return
      const href = a.getAttribute('href') || ''
      ev.preventDefault()
      if (/^https?:/i.test(href)) invoke('ui.openExternal', { url: href }).catch(() => {})
      else if (href.startsWith('#')) {
        let id = href.slice(1)
        try { id = decodeURIComponent(id) } catch {}
        const target = article.querySelector(`[id="${id.replace(/"/g, '\\"')}"]`)
        if (target) scrollTo(article, target)
        else if (id === '' || id === 'top') scrollTo(article, article)
        else toast(`找不到锚点「${id}」`)
      }
    })
    host.append(el('div', { class: 'preview-scroll' }, article))
    return
  }
  if (doc.kind === 'csv') {
    host.append(el('div', { class: 'preview-scroll' }, renderCSV(doc)))
    return
  }
  if (doc.kind === 'image') { host.append(renderImage(doc)); return }
  if (doc.kind === 'pdf') { host.append(renderPDF(doc)); return }
  if (doc.kind === 'epub') { host.append(renderEPUB(doc)); return }
  if (doc.kind === 'office') { host.append(renderOffice(doc)); return }
  if (doc.kind === 'html') { host.append(renderHTML(doc)); return }
  if (doc.kind === 'video' || doc.kind === 'audio') { host.append(renderMedia(doc)); return }
  if (doc.kind === 'json') {
    let pretty = doc.text
    try { pretty = JSON.stringify(JSON.parse(doc.text), null, 2) } catch {}
    const pre = el('pre', { class: 'md', style: { fontFamily: 'var(--mono)', fontSize: '12.5px', whiteSpace: 'pre-wrap' } }, pretty)
    // 长 JSON 要滚动，工具栏 sticky 在右上角，滚到哪儿都够得着
    const scroller = el('div', { class: 'preview-scroll json-scroll' },
      el('div', { class: 'json-bar' }, copyButton()),
      pre)
    scroller.addEventListener('click', handleCopyClick)
    host.append(scroller)
    return
  }
  host.append(renderBinary(doc))
}

export function renderEmpty(
  host: HTMLElement,
  onOpen: () => void,
  recents: { path: string; name: string }[] = [],
  onPick?: (path: string) => void,
  onSamples?: () => void
): void {
  host.innerHTML = ''
  const box = el('div', { class: 'empty' })
  box.append(el('div', { class: 'logo' }, '◆'))
  box.append(el('h1', {}, 'SuperWorkStation'))
  box.append(el('p', {}, '本地优先的工作台'))
  const hint = el('div', { class: 'hint' })
  hint.append(el('kbd', {}, '⌘O'), el('kbd', {}, '⌘P'), el('kbd', {}, '⌘K'))
  box.append(hint)
  const btn = el('button', { class: 'primary' }, '打开文件夹')
  btn.addEventListener('click', onOpen)
  box.append(btn)
  if (onSamples) {
    const demo = el('button', { class: 'ghost', style: { height: '28px', fontSize: '12px' } }, '浏览示例文档')
    demo.addEventListener('click', onSamples)
    box.append(demo)
  }

  if (recents.length) {
    const wrap = el('div', { class: 'recent' })
    wrap.append(el('div', { class: 'recent-title' }, '最近打开'))
    for (const r of recents.slice(0, 5)) {
      const row = el('div', { class: 'recent-row', title: r.path })
      row.append(el('span', { class: 'nm' }, r.name), el('span', { class: 'pth' }, r.path))
      row.addEventListener('click', () => onPick?.(r.path))
      wrap.append(row)
    }
    box.append(wrap)
  }
  host.append(box)
}

export { md }
