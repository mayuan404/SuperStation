import { EditorState, EditorSelection, Transaction } from '@codemirror/state'
import type { Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { Prec } from '@codemirror/state'

/**
 * 让编辑器里的选择行为对齐 Mac 上的编辑器习惯：
 *
 * 1. 双击 = 选中整行（CodeMirror 默认是「选词」，在等宽代码里很难用）；
 * 2. `⌘↑` / `⌘↓` = 以整行为单位跳，落点在本行行尾，而不是下一行行首。
 *
 * 只用 transactionFilter（作用于「所有」事务，包括手势产生的），
 * 不用 transactionExtender（只作用于 dispatch 产生的事务，且不接受选区）。
 */
export function editorLineSelection(): Extension {
  return [
    EditorView.domEventHandlers({
      dblclick: (ev, view) => {
        const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY }, false)
        const doc = view.state.doc
        if (typeof pos !== 'number' || pos < 0) return false
        const line = doc.lineAt(pos)
        if (ev.detail >= 3) {
          view.dispatch({ selection: EditorSelection.single(0, doc.length) })
        } else {
          view.dispatch({ selection: EditorSelection.single(line.from, line.to) })
        }
        // 不主动 focus：焦点可能正被预览围标，越界设焦点会让上面的 dispatch 落空
        view.requestMeasure()
        return true
      }
    }),
    // 物理按键（真机 Cmd-↓ 等）：在 keydown 阶段经 Prec.highest 解释器转成具体任务
    Prec.highest(keymap.of([
      {
        key: 'Mod-ArrowDown',
        run: (view) => moveWholeLine(view, 1),
        shift: (view) => moveWholeLine(view, 1, true)
      },
      {
        key: 'Mod-ArrowUp',
        run: (view) => moveWholeLine(view, -1),
        shift: (view) => moveWholeLine(view, -1, true)
      }
    ])),
    // 兜底：CodeMirror 自己的输入方式（输入法 / 语音）产生的「落到行首」也吸附
    EditorState.transactionFilter.of((tr) => fixLineLanding(tr))
  ]
}

/**
 * 把「落到某一行行首」的光标吸附回上一行的行尾。
 * 只在没有选区（光标）的情况下处理，扩选、拖选一律不碰。
 */
function fixLineLanding(tr: Transaction) {
  if (tr.docChanged) return tr
  const prev = tr.startState.selection.main
  const next = tr.newSelection.main
  if (!prev.empty || !next.empty) return tr
  const pos = next.head
  if (pos === prev.head || pos === 0) return tr
  const doc = tr.state.doc
  const line = doc.lineAt(pos)
  // 只处理「正好落在行首」的情况：⌘↑/⌘↓ 的默认落点
  if (pos !== line.from) return tr
  const end = pos - 1
  if (end <= 0 || doc.lineAt(end).to !== end) return tr
  if (doc.lineAt(end).from !== prevLineStart(doc, end)) return tr
  // 同一事务里追加：把光标留在上一行行尾
  return [tr, { selection: EditorSelection.single(end), sequential: true }]
}

function prevLineStart(doc: any, end: number): number {
  return doc.lineAt(end).from
}

/**
 * 整行跳（⌘↑ / ⌘↓ 的语义）：
 *   ⌘↓：光标不在行尾 → 跳到本行行尾；已在行尾 → 跳到下一行行尾
 *   ⌘↑：光标不在行首 → 跳到本行行首；已在行首 → 跳到上一行行首
 * 选区版本（⌘⇧↓）保持锚点不动，按整行扩展。
 */
export function moveWholeLine(view: EditorView, dir: 1 | -1, extend = false): boolean {
  const doc = view.state.doc
  const sel = view.state.selection.main
  const head = sel.head

  let target: number
  if (dir > 0) {
    const line = doc.lineAt(head)
    if (head < line.to) target = line.to
    else if (line.to < doc.length) target = doc.lineAt(line.to + 1).to
    else target = doc.length
  } else {
    const line = doc.lineAt(head)
    if (head > line.from) target = line.from
    else if (line.from > 0) target = doc.lineAt(line.from - 1).from
    else target = 0
  }

  view.dispatch({
    selection: extend ? EditorSelection.range(sel.anchor, target) : EditorSelection.single(target),
    scrollIntoView: true
  })
  return true
}
