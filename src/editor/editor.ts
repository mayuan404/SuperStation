import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, search, openSearchPanel, setSearchQuery, SearchQuery } from '@codemirror/search'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting, HighlightStyle } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap } from '@codemirror/autocomplete'
import { tags as t } from '@lezer/highlight'
import { setDiagnostics, lintGutter, linter, type Diagnostic } from '@codemirror/lint'
import { currentTheme } from '../ui/theme'
import { editorLineSelection } from './lineselect'
import type { Doc } from '../lib/store'

const highlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], class: 'tok-kw' },
  { tag: [t.string, t.special(t.string), t.regexp], class: 'tok-str' },
  { tag: [t.number, t.bool, t.null, t.atom], class: 'tok-num' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'tok-com' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], class: 'tok-fn' },
  { tag: [t.typeName, t.className, t.namespace, t.standard(t.typeName)], class: 'tok-type' },
  { tag: [t.propertyName, t.definition(t.propertyName)], class: 'tok-prop' },
  { tag: [t.operator, t.operatorKeyword], class: 'tok-op' },
  { tag: [t.punctuation, t.bracket, t.separator], class: 'tok-punct' },
  { tag: [t.tagName, t.angleBracket], class: 'tok-tag' },
  { tag: [t.attributeName, t.attributeValue], class: 'tok-attr' },
  { tag: [t.heading], class: 'tok-heading' },
  { tag: [t.link, t.url], class: 'tok-link' },
  { tag: [t.emphasis], class: 'tok-emph' },
  { tag: [t.strong], class: 'tok-strong' },
  { tag: [t.meta, t.annotation, t.processingInstruction], class: 'tok-meta' },
  { tag: [t.constant(t.variableName), t.constant(t.propertyName)], class: 'tok-const' },
  { tag: [t.invalid], class: 'tok-invalid' }
])

function baseTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--fg)', fontSize: 'var(--editor-font-size)' },
      '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: 'var(--editor-line-height)', overflow: 'auto' },
      '.cm-content': { padding: '12px 0 45vh', caretColor: 'var(--accent)' },
      '.cm-line': { padding: '0 20px 0 10px' },
      '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--fg-3)', border: 'none', paddingLeft: '10px' },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 4px', minWidth: '30px' },
      '.cm-activeLine': { backgroundColor: 'var(--accent-soft)' },
      '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-2)' },
      '.cm-selectionBackground': { backgroundColor: 'var(--sel) !important' },
      '&.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--sel) !important' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--accent-soft)', outline: 'none', borderRadius: '2px' },
      '.cm-selectionMatch': { backgroundColor: 'var(--search-hit-selection)' },
      '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-2)', border: 'none', color: 'var(--fg-3)', padding: '0 6px', borderRadius: '4px' },
      '.cm-foldGutter span': { color: 'var(--fg-3)' },
      '.cm-tooltip': { backgroundColor: 'var(--elev)', border: '1px solid var(--line)', borderRadius: '8px', boxShadow: 'var(--shadow)', color: 'var(--fg)' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--accent-soft)', color: 'var(--fg)' },
      '.cm-searchMatch': {
        backgroundColor: 'var(--search-hit-bg)',
        color: 'var(--search-hit-fg)',
        outline: '1px solid var(--search-hit-border)',
        borderRadius: '2px'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: 'var(--search-hit-active-bg)',
        color: 'var(--search-hit-active-fg)',
        outline: '2px solid var(--search-hit-active-border)'
      }
    },
    { dark }
  )
}

type LangLoader = () => Promise<Extension>

function langLoader(ext: string): LangLoader | null {
  const js = ext === 'js' || ext === 'mjs' || ext === 'cjs'
  const jsx = ext === 'jsx'
  const ts = ext === 'ts' || ext === 'mts' || ext === 'cts'
  const tsx = ext === 'tsx'
  if (js || jsx || ts || tsx) {
    return () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: ts || tsx, jsx: jsx || tsx }))
  }
  switch (ext) {
    case 'html': case 'htm': case 'vue': case 'svelte':
      return () => import('@codemirror/lang-html').then((m) => m.html())
    case 'css': case 'scss': case 'less':
      return () => import('@codemirror/lang-css').then((m) => m.css())
    case 'json': case 'jsonc':
      return () => import('@codemirror/lang-json').then((m) => m.json())
    case 'md': case 'markdown':
      return () => import('@codemirror/lang-markdown').then((m) => m.markdown())
    case 'py': case 'pyw':
      return () => import('@codemirror/lang-python').then((m) => m.python())
    case 'go':
      return () => import('@codemirror/lang-go').then((m) => m.go())
    case 'rs':
      return () => import('@codemirror/lang-rust').then((m) => m.rust())
    case 'c': case 'h': case 'cc': case 'cpp': case 'cxx': case 'hpp': case 'hh': case 'm': case 'mm':
      return () => import('@codemirror/lang-cpp').then((m) => m.cpp())
    case 'java':
      return () => import('@codemirror/lang-java').then((m) => m.java())
    case 'php':
      return () => import('@codemirror/lang-php').then((m) => m.php())
    case 'xml': case 'svg': case 'plist':
      return () => import('@codemirror/lang-xml').then((m) => m.xml())
    case 'yaml': case 'yml':
      return () => import('@codemirror/lang-yaml').then((m) => m.yaml())
    case 'sql':
      return () => import('@codemirror/lang-sql').then((m) => m.sql())
    case 'sh': case 'bash': case 'zsh': case 'fish':
      return () => import('@codemirror/legacy-modes/mode/shell').then((m) => import('@codemirror/language').then((l) => l.StreamLanguage.define(m.shell)))
    case 'toml':
      return () => import('@codemirror/legacy-modes/mode/toml').then((m) => import('@codemirror/language').then((l) => l.StreamLanguage.define(m.toml)))
    case 'ini': case 'conf':
      return () => import('@codemirror/legacy-modes/mode/properties').then((m) => import('@codemirror/language').then((l) => l.StreamLanguage.define(m.properties)))
    default:
      return null
  }
}

export class Editor {
  view: EditorView
  private bigTimer: any = null
  private doc: Doc | null = null
  private langComp = new Compartment()
  private wrapComp = new Compartment()
  private themeComp = new Compartment()
  private states = new Map<string, EditorState>()
  private langToken = 0
  onChange: (text: string) => void = () => {}
  onCursor: (info: { line: number; col: number; selChars: number; selLines: number; lines: number }) => void = () => {}

  constructor(host: HTMLElement) {
    this.view = new EditorView({
      parent: host,
      state: EditorState.create({ doc: '', extensions: this.extensions(false, null) })
    })
  }

  private extensions(dark: boolean, lang: Extension | null): Extension[] {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter({ openText: '▾', closedText: '▸' }),
      lintGutter(),
      linter((view) => this.buildDiags(view.state, this.doc?.issues ?? [])),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      search({ top: true }),
      syntaxHighlighting(highlightStyle),
      this.themeComp.of(baseTheme(dark)),
      this.langComp.of(lang ?? []),
      this.wrapComp.of([]),
      // 双击选整行 + ⌘↑/⌘↓ 以整行为单位跳（落点在本行行尾）
      editorLineSelection(),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        indentWithTab
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) {
          // 大文件每次都 toString 会很贵：合并成 180ms 一次
          if (u.state.doc.length > 200_000) {
            clearTimeout(this.bigTimer)
            this.bigTimer = setTimeout(() => this.onChange(this.view.state.doc.toString()), 180)
          } else {
            this.onChange(u.state.doc.toString())
          }
        }
        if (u.selectionSet || u.docChanged) {
          const sel = u.state.selection.main
          const line = u.state.doc.lineAt(sel.head)
          const selText = sel.from !== sel.to ? u.state.sliceDoc(sel.from, sel.to) : ''
          this.onCursor({
            line: line.number,
            col: sel.head - line.from + 1,
            selChars: selText.length,
            selLines: selText ? selText.split('\n').length : 0,
            lines: u.state.doc.lines
          })
        }
      })
    ]
  }

  setDoc(doc: Doc | null): void {
    if (this.doc && this.doc.id !== doc?.id) {
      this.states.set(this.doc.id, this.view.state)
    }
    this.doc = doc
    if (!doc) {
      this.view.setState(EditorState.create({ doc: '', extensions: this.extensions(this.isDark(), null) }))
      return
    }
    const cached = this.states.get(doc.id)
    if (cached) {
      this.view.setState(cached)
    } else {
      const st = EditorState.create({ doc: doc.text, extensions: this.extensions(this.isDark(), null) })
      this.view.setState(st)
      this.states.set(doc.id, st)
    }
    this.loadLanguage(doc)
  }

  private isDark(): boolean {
    return currentTheme().dark
  }

  private loadLanguage(doc: Doc): void {
    const loader = langLoader(doc.ext)
    const token = ++this.langToken
    if (!loader) {
      this.view.dispatch({ effects: this.langComp.reconfigure([]) })
      return
    }
    loader().then((ext) => {
      if (token !== this.langToken) return
      this.view.dispatch({ effects: this.langComp.reconfigure(ext) })
    }).catch(() => {})
  }

  applySettings(): void {
    this.view.dispatch({
      effects: [
        this.themeComp.reconfigure(baseTheme(this.isDark())),
        this.wrapComp.reconfigure([this.wrapEnabled ? EditorView.lineWrapping : []])
      ]
    })
    // re-run language for current doc so cached states get it too
    if (this.doc) this.loadLanguage(this.doc)
  }

  private wrapEnabled = false
  setWrap(on: boolean): void {
    this.wrapEnabled = on
    this.view.dispatch({ effects: this.wrapComp.reconfigure(on ? EditorView.lineWrapping : []) })
  }

  focus(): void { this.view.focus() }

  /** 立即把大文件里挂起的改动同步出去（保存前调用） */
  flush(): void {
    if (!this.bigTimer) return
    clearTimeout(this.bigTimer)
    this.bigTimer = null
    this.onChange(this.view.state.doc.toString())
  }

  openSearch(): void {
    this.view.focus()
    openSearchPanel(this.view)
  }

  searchFor(text: string): void {
    openSearchPanel(this.view)
    this.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: text })) })
    this.view.focus()
  }

  selectionText(): string {
    const s = this.view.state.selection.main
    return s.from === s.to ? '' : this.view.state.sliceDoc(s.from, s.to)
  }

  replaceSelection(text: string): void {
    const s = this.view.state.selection.main
    this.view.dispatch({ changes: { from: s.from, to: s.to, insert: text }, selection: { anchor: s.from + text.length } })
    this.view.focus()
  }

  insertAtCursor(text: string): void {
    const s = this.view.state.selection.main
    this.view.dispatch({ changes: { from: s.head, insert: text } })
    this.view.focus()
  }

  private buildDiags(state: EditorState, issues: { line: number; message: string; severity?: string }[]): Diagnostic[] {
    const diags: Diagnostic[] = []
    for (const it of issues) {
      const lineNo = Math.min(Math.max(1, it.line), state.doc.lines)
      const l = state.doc.line(lineNo)
      diags.push({
        from: l.from,
        to: l.to,
        severity: (it.severity === 'warning' ? 'warning' : 'error') as any,
        message: it.message || '语法错误'
      })
    }
    return diags
  }

  /** Show syntax diagnostics for the given path (ignored if another doc is active). */
  setIssues(path: string, issues: { line: number; message: string; severity?: string }[]): void {
    if (!this.doc || this.doc.path !== path) return
    this.view.dispatch(setDiagnostics(this.view.state, this.buildDiags(this.view.state, issues)))
  }

  clearIssues(): void {
    this.view.dispatch(setDiagnostics(this.view.state, []))
  }

  /** Discard cached state (e.g. file changed on disk and needs reload). */
  forget(id: string): void { this.states.delete(id) }

  scrollToLine(line: number): void {
    const st = this.view.state
    const l = st.doc.line(Math.min(Math.max(1, line), st.doc.lines))
    this.view.dispatch({
      selection: { anchor: l.from },
      effects: EditorView.scrollIntoView(l.from, { y: 'center' }),
      scrollIntoView: true
    })
    this.view.focus()
  }
}
