const P: Record<string, string> = {
  chevron: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  'chevron-down': '<path d="M3.5 6L8 10.5 12.5 6"/>',
  folder: '<path d="M2 5.2A1.2 1.2 0 0 1 3.2 4h3l1.5 2h5.1A1.2 1.2 0 0 1 14 7.2v5.6A1.2 1.2 0 0 1 12.8 14H3.2A1.2 1.2 0 0 1 2 12.8z"/>',
  disk: '<rect x="2" y="3.3" width="12" height="9.4" rx="1.6"/><path d="M2.6 9.1h10.8"/><path d="M4.2 6.2h3.6"/><circle cx="11.7" cy="6.2" r=".65" fill="currentColor" stroke="none"/>',
  'folder-open': '<path d="M2 12.6V5.2A1.2 1.2 0 0 1 3.2 4h3l1.5 2h4.1A1.2 1.2 0 0 1 13 7.2v.8"/><path d="M2.6 13.4l1.7-5a1 1 0 0 1 1-.7h8.3a.7.7 0 0 1 .7.9l-1.6 4.8z"/>',
  file: '<path d="M4 2.2h5l3 3v8.6H4z"/><path d="M9 2.2v3h3"/>',
  lock: '<rect x="3.4" y="7" width="9.2" height="6.8" rx="1.6"/><path d="M5.6 7V5.1a2.4 2.4 0 0 1 4.8 0V7"/>',
  unlock: '<rect x="3.4" y="7" width="9.2" height="6.8" rx="1.6"/><path d="M5.6 7V5.1a2.4 2.4 0 0 1 4.6-.9"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.4 10.4L14 14"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  minus: '<path d="M3 8h10"/>',
  sun: '<circle cx="8" cy="8" r="3"/><path d="M8 1.4v1.4M8 13.2v1.4M1.4 8h1.4M13.2 8h1.4M3.3 3.3l1 1M11.7 11.7l1 1M12.7 3.3l-1 1M4.3 11.7l-1 1"/>',
  moon: '<path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8z"/>',
  eye: '<path d="M1.4 8S3.9 3.6 8 3.6 14.6 8 14.6 8 12.1 12.4 8 12.4 1.4 8 1.4 8z"/><circle cx="8" cy="8" r="1.9"/>',
  pencil: '<path d="M11.2 2.5l2.3 2.3L6.2 12.1l-3 .7.7-3z"/><path d="M9.6 4.1l2.3 2.3"/>',
  split: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="M8 3v10"/>',
  image: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><circle cx="5.6" cy="6.4" r=".9"/><path d="M2.6 11.4l3.2-3.1 2.4 2.3 2.4-2.6 2.8 2.9"/>',
  table: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="M1.8 6.4h12.4M6.6 3v10"/>',
  code: '<path d="M5.4 4.6L2 8l3.4 3.4M10.6 4.6L14 8l-3.4 3.4"/>',
  palette: '<path d="M8 1.8a6.2 6.2 0 1 0 0 12.4c.9 0 1.3-.6 1.3-1.3 0-.4-.2-.7-.4-1-.2-.3-.3-.5-.3-.8 0-.7.6-1.2 1.3-1.2h1.4a3.6 3.6 0 0 0 3.6-3.6c0-2.5-3.1-4.5-6.9-4.5z"/><circle cx="5" cy="6" r=".9"/><circle cx="8" cy="4.4" r=".9"/><circle cx="11.2" cy="6" r=".9"/>',
  sidebar: '<rect x="1.8" y="3" width="12.4" height="10" rx="1.6"/><path d="M6.2 3v10"/>',
  more: '<circle cx="3.4" cy="8" r="1.1"/><circle cx="8" cy="8" r="1.1"/><circle cx="12.6" cy="8" r="1.1"/>',
  refresh: '<path d="M13.4 8a5.4 5.4 0 1 1-1.6-3.8"/><path d="M13.6 2.2v3h-3"/>',
  trash: '<path d="M2.6 4.2h10.8M5.8 4.2V2.8h4.4v1.4M4.2 4.2l.7 9.2h6.2l.7-9.2"/>',
  external: '<path d="M9 2.6h4.4V7"/><path d="M13.4 2.6L7 9"/><path d="M12 9.6v3.2a.6.6 0 0 1-.6.6H3a.6.6 0 0 1-.6-.6V4.4a.6.6 0 0 1 .6-.6h3.4"/>',
  'file-plus': '<path d="M4 2.2h5l3 3v8.6H4z"/><path d="M9 2.2v3h3"/><path d="M8 8v3.4M6.3 9.7h3.4"/>',
  'folder-plus': '<path d="M2 5.2A1.2 1.2 0 0 1 3.2 4h3l1.5 2h5.1A1.2 1.2 0 0 1 14 7.2v5.6A1.2 1.2 0 0 1 12.8 14H3.2A1.2 1.2 0 0 1 2 12.8z"/><path d="M8 7.4v4M6 9.4h4"/>',
  command: '<path d="M6 4.2a1.9 1.9 0 1 0-1.9 1.9H6zM10 4.2a1.9 1.9 0 1 1 1.9 1.9H10zM6 11.8a1.9 1.9 0 1 1-1.9-1.9H6zM10 11.8a1.9 1.9 0 1 0 1.9-1.9H10z"/><rect x="6" y="6.1" width="4" height="3.8" rx=".6"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.6l.6 2a4.8 4.8 0 0 1 1.7 1l2-.6 1.2 2-1.4 1.5a4.8 4.8 0 0 1 0 2l1.4 1.5-1.2 2-2-.6a4.8 4.8 0 0 1-1.7 1l-.6 2h-2.4l-.6-2a4.8 4.8 0 0 1-1.7-1l-2 .6-1.2-2L2.1 9.5a4.8 4.8 0 0 1 0-2L.7 6l1.2-2 2 .6a4.8 4.8 0 0 1 1.7-1l.6-2z"/>',
  book: '<path d="M2.4 3.2A1.6 1.6 0 0 1 4 1.6h3.2A2.4 2.4 0 0 1 9.6 4v10a2 2 0 0 0-2-2H3.2a.8.8 0 0 1-.8-.8z"/><path d="M13.6 3.2A1.6 1.6 0 0 0 12 1.6H8.8A2.4 2.4 0 0 0 6.4 4v10a2 2 0 0 1 2-2h4.4a.8.8 0 0 0 .8-.8z"/>',
  markdown: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.4"/><path d="M4 10V6l2 2 2-2v4M11.4 6v3.2M10.2 8.2l1.2 1.2 1.2-1.2"/>',
  pdf: '<path d="M4 2.2h5l3 3v8.6H4z"/><path d="M9 2.2v3h3"/><path d="M6 10.6V8.2h1.2a.9.9 0 0 1 0 1.8H6M9.2 10.6V8.2h1"/><path d="M11.6 10.6V8.2"/>',
  play: '<path d="M5 3.6l7 4.4-7 4.4z"/>',
  'arrow-left': '<path d="M12 8H4M7.4 4.6L4 8l3.4 3.4"/>',
  check: '<path d="M3.2 8.4l3.1 3.1 6.5-6.6"/>',
  contrast: '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none"/>',
  archive: '<rect x="2" y="3" width="12" height="3.4" rx=".8"/><path d="M3.2 6.4v6.2a.9.9 0 0 0 .9.9h7.8a.9.9 0 0 0 .9-.9V6.4"/><path d="M6.6 9.2h2.8"/>',
  copy: '<rect x="5.6" y="5.6" width="7.9" height="7.9" rx="1.2"/><path d="M10.4 5.6V3.9a1.3 1.3 0 0 0-1.3-1.3H3.9a1.3 1.3 0 0 0-1.3 1.3v5.2a1.3 1.3 0 0 0 1.3 1.3h1.7"/>',
  cut: '<circle cx="4.4" cy="11.9" r="1.7"/><circle cx="4.4" cy="4.1" r="1.7"/><path d="M5.9 5.2L13 12.2M5.9 10.8L13 3.8"/>',
  paste: '<path d="M5.6 3.6H4.3A1.3 1.3 0 0 0 3 4.9v8.4a1.3 1.3 0 0 0 1.3 1.3h7.4a1.3 1.3 0 0 0 1.3-1.3V4.9a1.3 1.3 0 0 0-1.3-1.3h-1.3"/><rect x="5.6" y="2.3" width="4.8" height="2.6" rx=".8"/>',
  'file-lock': '<path d="M4 2.2h5l3 3v4.2"/><path d="M9 2.2v3h3"/><rect x="9.2" y="10" width="4.6" height="3.6" rx=".9"/><path d="M10.3 10V9a1.2 1.2 0 0 1 2.4 0v1"/>',
  'zoom-in': '<circle cx="7" cy="7" r="4.6"/><path d="M10.3 10.3L14 14M7 5.2v3.6M5.2 7h3.6"/>',
  'zoom-out': '<circle cx="7" cy="7" r="4.6"/><path d="M10.3 10.3L14 14M5.2 7h3.6"/>',
  fit: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>',
  terminal: '<rect x="2" y="3.2" width="12" height="9.6" rx="1.6"/><path d="M4.6 6.6l1.8 1.8-1.8 1.8M8.2 10.2h3.2"/>',
  sparkles: '<path d="M6 2l1.1 3.1L10.2 6.2 7.1 7.3 6 10.4 4.9 7.3 1.8 6.2 4.9 5.1z"/><path d="M11.6 8.6l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/>'
}

export function icon(name: string, cls = ''): Element {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.4')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  if (cls) svg.setAttribute('class', cls)
  svg.innerHTML = P[name] ?? P.file
  return svg
}

const ICONS: Record<string, string> = {
  md: 'markdown', markdown: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', avif: 'image', bmp: 'image', ico: 'image',
  csv: 'table', tsv: 'table',
  html: 'code', htm: 'code', js: 'code', ts: 'code', jsx: 'code', tsx: 'code', py: 'code', go: 'code', rs: 'code', c: 'code', cpp: 'code', h: 'code', css: 'code', sh: 'code', json: 'code', yaml: 'code', yml: 'code', toml: 'code', xml: 'code',
  pdf: 'pdf',
  epub: 'book',
  ppt: 'file', pptx: 'file', doc: 'file', docx: 'file', xls: 'file', xlsx: 'file', key: 'file', numbers: 'file', pages: 'file'
}

export function fileIcon(ext: string): Element {
  return icon(ICONS[ext] ?? 'file')
}

import { iconVarFor } from '../ui/theme'

const COLORS: Record<string, string> = {
  md: '#519aba', markdown: '#519aba',
  json: '#cbcb41', yaml: '#cbcb41', yml: '#cbcb41',
  js: '#e6c447', ts: '#519aba', jsx: '#61dafb', tsx: '#61dafb',
  py: '#4b8bbe', go: '#4bd5e0', rs: '#dea584', c: '#a8b9cc', cpp: '#f34b7d',
  html: '#e34c26', css: '#563d7c', sh: '#89e051',
  png: '#a074c4', jpg: '#a074c4', jpeg: '#a074c4', gif: '#a074c4', webp: '#a074c4', svg: '#ffb13b',
  csv: '#89e051', tsv: '#89e051',
  pdf: '#e34c26'
}

export function iconColor(ext: string): string | null {
  return iconVarFor(ext)
}
