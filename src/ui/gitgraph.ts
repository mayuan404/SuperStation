// 提交历史的泳道图：纯函数算车道 + 生成 SVG。
// 单独成文件是为了能脱离面板在浏览器里直接验证渲染效果。

export interface GraphCommit {
  hash: string
  parents: string[]
  /** 文本列：作者、时间、标题等由调用方自己拼 */
}

export interface GraphRow<T extends GraphCommit> {
  commit: T
  lane: number
  /** 进入本行时每条车道在等的提交（null = 空） */
  before: (string | null)[]
  /** 处理完本行后每条车道的状态 */
  after: (string | null)[]
  /** 本提交的其它父提交落在哪条车道（合并的斜线） */
  mergeTo: number[]
}

const LANE_W = 14
const ROW_H = 22
const DOT_R = 3.2

/** 经典泳道分配：先找「已经在等这个提交」的车道，找不到就占一条空车道 */
export function layoutGraph<T extends GraphCommit>(commits: T[]): GraphRow<T>[] {
  const lanes: (string | null)[] = []
  const rows: GraphRow<T>[] = []

  // 关键：只保留「已加载窗口里真的会出现」的车道。
  // 以前父提交不管在不在窗口内都占一条车道，`--all` + 分页加载之后
  // 车道只会越积越多（30 条时 10 条，630 条时上百条），图宽把文字列挤没了。
  const known = new Set(commits.map((c) => c.hash))
  const MAX_LANES = 12

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash)
    if (lane < 0) {
      lane = lanes.indexOf(null)
      if (lane < 0) { lane = lanes.length; lanes.push(null) }
    }

    const before = lanes.slice()
    const parents = commit.parents.filter((h) => known.has(h))
    const first = parents[0] ?? null
    lanes[lane] = first

    const mergeTo: number[] = []
    for (const p of parents.slice(1)) {
      let j = lanes.indexOf(p)
      if (j < 0) {
        j = lanes.indexOf(null)
        if (j < 0 && lanes.length < MAX_LANES) { j = lanes.length; lanes.push(null) }
        // 车道数到上限就不再新增，多余的合并线并到最右一条，保证图不无限变宽
        if (j < 0) j = MAX_LANES - 1
        lanes[j] = p
      }
      if (j !== lane && !mergeTo.includes(j)) mergeTo.push(j)
    }

    const after = lanes.slice()
    // 尾部空车道收掉，避免图越来越宽
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()

    rows.push({ commit, lane, before, after, mergeTo })
  }
  return rows
}

export function laneCount<T extends GraphCommit>(rows: GraphRow<T>[]): number {
  let n = 1
  for (const r of rows) n = Math.max(n, r.before.length, r.after.length, r.lane + 1, ...(r.mergeTo.length ? [Math.max(...r.mergeTo) + 1] : [0]))
  return Math.min(n, 12)
}

export function graphWidth<T extends GraphCommit>(rows: GraphRow<T>[]): number {
  return laneCount(rows) * LANE_W + 6
}

const x = (lane: number): number => lane * LANE_W + LANE_W / 2 + 3

/** 生成一行对应的 SVG；同一套坐标保证上下两行接得上 */
export function graphRowSvg<T extends GraphCommit>(row: GraphRow<T>, lanes: number, colorOf: (lane: number) => string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg') as SVGSVGElement
  svg.setAttribute('class', 'git-graph')
  svg.setAttribute('width', String(lanes * LANE_W + 6))
  svg.setAttribute('height', String(ROW_H))
  svg.setAttribute('viewBox', `0 0 ${lanes * LANE_W + 6} ${ROW_H}`)

  const line = (lane: number, y1: number, y2: number, color: string): void => {
    const p = document.createElementNS(NS, 'line')
    p.setAttribute('x1', String(x(lane)))
    p.setAttribute('y1', String(y1))
    p.setAttribute('x2', String(x(lane)))
    p.setAttribute('y2', String(y2))
    p.setAttribute('stroke', color)
    p.setAttribute('stroke-width', '1.6')
    p.setAttribute('stroke-linecap', 'round')
    svg.append(p)
  }

  const maxBefore = row.before.length
  const maxAfter = row.after.length
  const n = Math.max(maxBefore, maxAfter, row.lane + 1)

  // 贯穿本行的线：进入和离开都在的，画满整行；只在一边的，画半行，上下自然接续
  for (let i = 0; i < n; i++) {
    const had = i < maxBefore && row.before[i] !== null
    const has = i < maxAfter && row.after[i] !== null
    const color = colorOf(i)
    if (had && has) line(i, 0, ROW_H, color)
    else if (had) line(i, 0, ROW_H / 2, color)
    else if (has) line(i, ROW_H / 2, ROW_H, color)
  }

  // 合并的斜线：从圆点弯到目标车道
  for (const j of row.mergeTo) {
    const p = document.createElementNS(NS, 'path')
    const x1 = x(row.lane), y1 = ROW_H / 2
    const x2 = x(j), y2 = ROW_H
    p.setAttribute('d', `M ${x1} ${y1} C ${x1} ${y1 + 8}, ${x2} ${y2 - 8}, ${x2} ${y2}`)
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', colorOf(j))
    p.setAttribute('stroke-width', '1.6')
    p.setAttribute('stroke-linecap', 'round')
    svg.append(p)
  }

  const dot = document.createElementNS(NS, 'circle')
  dot.setAttribute('cx', String(x(row.lane)))
  dot.setAttribute('cy', String(ROW_H / 2))
  dot.setAttribute('r', String(DOT_R))
  dot.setAttribute('fill', colorOf(row.lane))
  dot.setAttribute('class', 'dot')
  svg.append(dot)

  return svg
}

/** 稳定的车道配色：同一条车道在不同行颜色一致 */
export function laneColor(lane: number): string {
  const palette = ['#61afef', '#98c379', '#e5c07b', '#e06c75', '#c678dd', '#56b6c2', '#d19a66', '#7aa2f7', '#b48ead', '#8fbcbb']
  return palette[lane % palette.length]
}

export const GRAPH_ROW_HEIGHT = ROW_H
