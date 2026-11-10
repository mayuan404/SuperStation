type Props = Record<string, any>

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string | number | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'style' && typeof v === 'object') Object.assign((node as HTMLElement).style, v)
    else if (k === 'dataset') Object.assign((node as HTMLElement).dataset, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v)
    else if (k === 'html') node.innerHTML = v
    else if (k === 'text') node.textContent = String(v)
    else if (k === 'value') (node as any).value = v
    else node.setAttribute(k, String(v))
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue
    node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return node
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild)
}

export function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: any
  return ((...a: any[]) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }) as T
}

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
}
