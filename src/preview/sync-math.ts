// 编辑区 ↔ 预览区 滚动同步的纯计算部分（不碰 DOM，方便单独验证）。
//
// 两边用「源文件行号」当锚点：预览的顶层块在渲染时带上 data-line，
// 桌面端再把它换算成滚动位置，中间按行号线性插值。
// 比直接按 scrollTop 百分比同步稳：图片、表格、代码块的高度差异
// 不会被放大成「越滚越偏」。

export type Anchor = { line: number; top: number }

/** 首块前面补一个虚拟锚点，让「第 0 行 = 顶部」在插值时成立 */
function withEdges(anchors: Anchor[]): Anchor[] {
  if (!anchors.length) return anchors
  if (anchors[0].line <= 0 && anchors[0].top <= 0) return anchors
  return [{ line: 0, top: 0 }, ...anchors]
}

/** 文档行（0 起，可为小数）→ 预览滚动位置 */
export function topForLine(anchors: Anchor[], line: number, maxScroll = Infinity): number {
  if (!anchors.length) return 0
  // 第一个块之前就是页面顶部（正文栏的上边距要露出来）
  if (line <= anchors[0].line) return 0
  let i = 0
  while (i + 1 < anchors.length && anchors[i + 1].line <= line) i++
  const cur = anchors[i]
  const next = anchors[i + 1]
  let top = cur.top
  if (next && next.line > cur.line) {
    const t = Math.min(1, Math.max(0, (line - cur.line) / (next.line - cur.line)))
    top = cur.top + (next.top - cur.top) * t
  }
  return Math.min(Math.max(0, top), maxScroll)
}

/** 预览滚动位置 → 文档行（0 起，可为小数） */
export function lineForTop(anchors: Anchor[], top: number): number {
  const list = withEdges(anchors)
  if (!list.length) return 0
  let i = 0
  while (i + 1 < list.length && list[i + 1].top <= top) i++
  const cur = list[i]
  const next = list[i + 1]
  if (!next || next.top <= cur.top) return cur.line
  const t = Math.min(1, Math.max(0, (top - cur.top) / (next.top - cur.top)))
  return cur.line + (next.line - cur.line) * t
}
