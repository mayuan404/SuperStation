// 严格 JSON 语法检查，返回首个错误的位置与说明（用于编辑器内联标注）

export interface JSONIssue {
  line: number
  col: number
  message: string
}

export function checkJSON(text: string): JSONIssue | null {
  let i = 0
  const n = text.length

  // 手写递归下降，好处是错误位置精确到字符
  class Err extends Error {
    at: number
    constructor(msg: string, at: number) { super(msg); this.at = at }
  }

  const ws = () => { while (i < n && ' \t\n\r'.includes(text[i])) i++ }
  const expect = (ch: string) => {
    ws()
    if (text[i] !== ch) throw new Err(`期望「${ch}」`, i)
    i++
  }

  function parseString(): void {
    expect('"')
    while (i < n) {
      const c = text[i]
      if (c === '"') { i++; return }
      if (c === '\\') {
        i++
        const e = text[i]
        if (e === 'u') { i += 5; continue }
        if (!'"\\/bfnrt'.includes(e ?? '')) throw new Err('非法的转义字符', i)
        i++
        continue
      }
      if (c === '\n' || c === '\r') throw new Err('字符串未闭合', i)
      i++
    }
    throw new Err('字符串未闭合', i)
  }

  function parseNumber(): void {
    const start = i
    if (text[i] === '-') i++
    if (!/[0-9]/.test(text[i] ?? '')) throw new Err('数字格式错误', i)
    while (/[0-9]/.test(text[i] ?? '')) i++
    if (text[i] === '.') {
      i++
      if (!/[0-9]/.test(text[i] ?? '')) throw new Err('小数点后缺少数字', i)
      while (/[0-9]/.test(text[i] ?? '')) i++
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++
      if (text[i] === '+' || text[i] === '-') i++
      if (!/[0-9]/.test(text[i] ?? '')) throw new Err('指数部分缺少数字', i)
      while (/[0-9]/.test(text[i] ?? '')) i++
    }
    if (i === start) throw new Err('数字格式错误', i)
  }

  function parseValue(): void {
    ws()
    const c = text[i]
    if (c === '{') return parseObject()
    if (c === '[') return parseArray()
    if (c === '"') return parseString()
    if (c === '-' || /[0-9]/.test(c ?? '')) return parseNumber()
    if (text.startsWith('true', i)) { i += 4; return }
    if (text.startsWith('false', i)) { i += 5; return }
    if (text.startsWith('null', i)) { i += 4; return }
    throw new Err(c === undefined ? '内容意外结束' : `意外的字符「${c}」`, i)
  }

  function parseObject(): void {
    expect('{')
    ws()
    if (text[i] === '}') { i++; return }
    while (true) {
      ws()
      if (text[i] !== '"') throw new Err('属性名必须是字符串', i)
      parseString()
      ws()
      if (text[i] !== ':') throw new Err('属性名后缺少「:」', i)
      i++
      parseValue()
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === '}') { i++; return }
      throw new Err('对象缺少「}」或多余内容', i)
    }
  }

  function parseArray(): void {
    expect('[')
    ws()
    if (text[i] === ']') { i++; return }
    while (true) {
      parseValue()
      ws()
      if (text[i] === ',') { i++; continue }
      if (text[i] === ']') { i++; return }
      throw new Err('数组缺少「]」或多余内容', i)
    }
  }

  try {
    parseValue()
    ws()
    if (i < n) throw new Err('JSON 结束后还有多余内容', i)
    return null
  } catch (e: any) {
    if (!(e instanceof Err)) return null
    const prefix = text.slice(0, e.at)
    const line = prefix.split('\n').length
    const col = e.at - prefix.lastIndexOf('\n')
    return { line, col, message: e.message }
  }
}
