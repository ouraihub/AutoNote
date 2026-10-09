import { StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import 'katex/dist/katex.min.css'
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view'
import { syntaxTree } from '@codemirror/language'
import { renderMarkdownBlocks, type Heading, type MarkdownBlock } from '../markdown/renderer'

export interface LivePreviewServices {
  title(): string
  prepare(root: HTMLElement, source: string, view: EditorView): () => void
  revision?(): string
  onHeadings?(headings: readonly Heading[]): void
}
const focusChanged = StateEffect.define<boolean>()
const refresh = StateEffect.define<boolean>()
const cleanup = new WeakMap<HTMLElement, () => void>()

class RenderedBlock extends WidgetType {
  constructor(readonly block: MarkdownBlock, readonly source: string, readonly revision: number, readonly services: LivePreviewServices) { super() }
  override eq(other: RenderedBlock): boolean {
    return this.block.html === other.block.html && this.block.startLine === other.block.startLine && this.block.endLine === other.block.endLine && this.revision === other.revision && this.source === other.source
  }
  toDOM(view: EditorView): HTMLElement {
    const host = document.createElement('div')
    host.className = 'ink-prose cm-live-block'
    host.innerHTML = this.block.html
    const dispose = this.services.prepare(host, this.source, view)
    const observer = new ResizeObserver(() => view.requestMeasure())
    observer.observe(host)
    const edit = (event: MouseEvent) => {
      const target = event.target as HTMLElement
      if (target.closest('button,input,summary,a,[data-wikilink],img,[data-embed-target]') || event.ctrlKey || event.metaKey) return
      event.preventDefault()
      const mapped = target.closest<HTMLElement>('[data-line]')
      const index = Math.max(this.block.startLine, Math.min(this.block.endLine - 1, Number(mapped?.dataset.line ?? this.block.startLine)))
      const line = view.state.doc.line(Math.min(view.state.doc.lines, index + 1))
      view.dispatch({ selection: { anchor: line.from }, effects: focusChanged.of(true), userEvent: 'select.pointer' })
      view.focus()
    }
    host.addEventListener('click', edit)
    cleanup.set(host, () => { dispose(); observer.disconnect(); host.removeEventListener('click', edit) })
    return host
  }
  override destroy(dom: HTMLElement): void { cleanup.get(dom)?.(); cleanup.delete(dom) }
  override ignoreEvent(): boolean { return true }
}

interface LiveState {
  blocks: readonly MarkdownBlock[]
  headings: readonly Heading[]
  decorations: DecorationSet
  focused: boolean
  revision: number
}

function decorate(state: EditorState, live: LiveState, services: LivePreviewServices): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const source = state.doc.toString()
  for (const block of live.blocks) {
    if (block.startLine >= state.doc.lines || block.endLine <= block.startLine) continue
    const from = state.doc.line(block.startLine + 1).from
    const to = state.doc.line(Math.min(block.endLine, state.doc.lines)).to
    const active = state.selection.ranges.some(range => (live.focused || !range.empty) && range.from <= to && range.to >= from)
    if (active || from === to) continue
    ranges.push(Decoration.replace({ block: true, widget: new RenderedBlock(block, source, live.revision, services) }).range(from, to))
  }
  return Decoration.set(ranges, true)
}

/** Block replacement model; source, selection and undo remain CodeMirror's. */
export function livePreview(services: LivePreviewServices): Extension {
  const field = StateField.define<LiveState>({
    create(state) {
      const value: LiveState = { ...renderMarkdownBlocks(state.doc.toString()), decorations: Decoration.none, focused: false, revision: 0 }
      value.decorations = decorate(state, value, services)
      return value
    },
    update(value, tr) {
      const focused = tr.effects.find(effect => effect.is(focusChanged))
      const refreshed = tr.effects.find(effect => effect.is(refresh))
      if (!tr.docChanged && !tr.selection && !focused && !refreshed) return value
      const mapped = tr.docChanged ? value.blocks.flatMap(block => {
        const from = tr.startState.doc.line(block.startLine + 1).from
        const to = tr.startState.doc.line(Math.min(block.endLine, tr.startState.doc.lines)).to
        if (tr.changes.touchesRange(from, to)) return []
        const startLine = tr.state.doc.lineAt(tr.changes.mapPos(from, 1)).number - 1
        const delta = startLine - block.startLine
        return [{ ...block, startLine, html: delta ? block.html.replace(/(data-(?:task-)?line=")(\d+)(")/g, (_, before, line, after) => `${before}${Number(line) + delta}${after}`) : block.html, endLine: tr.state.doc.lineAt(tr.changes.mapPos(to, -1)).number }]
      }) : value.blocks
      const next: LiveState = { ...value, blocks: mapped, ...(refreshed ? renderMarkdownBlocks(tr.state.doc.toString()) : {}), focused: focused ? focused.value : value.focused, revision: value.revision + (refreshed?.value ? 1 : 0) }
      next.decorations = decorate(tr.state, next, services)
      return next
    },
    provide: field => EditorView.decorations.from(field, value => value.decorations),
  })
  return [field, ViewPlugin.fromClass(class {
    timer = 0
    observer: MutationObserver
    constructor(readonly view: EditorView) {
      this.observer = new MutationObserver(() => { clearTimeout(this.timer); this.timer = window.setTimeout(() => view.dispatch({ effects: refresh.of(true) }), 0) })
      this.observer.observe(view.dom.closest('[data-app-root]') ?? document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] })
    }
    update(update: { docChanged: boolean }): void {
      if (!update.docChanged) return
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => this.view.dispatch({ effects: refresh.of(false) }), 90)
    }
    destroy(): void { clearTimeout(this.timer); this.observer.disconnect() }
  }), EditorView.domEventHandlers({
    focus(_event, view) { view.dispatch({ effects: focusChanged.of(true) }) },
    blur(_event, view) { view.dispatch({ effects: focusChanged.of(false) }) },
  }), ViewPlugin.fromClass(class {
    decorations: DecorationSet = Decoration.none
    constructor(view: EditorView) { this.build(view) }
    update(update: { view: EditorView }): void { this.build(update.view) }
    build(view: EditorView): void {
      queueMicrotask(() => { if (view.state.field(field, false)) services.onHeadings?.(view.state.field(field).headings) })
      const ranges: Range<Decoration>[] = []
      for (const { from, to } of view.visibleRanges) syntaxTree(view.state).iterate({ from, to, enter(node) {
        const cls = node.name === 'StrongEmphasis' ? 'cm-live-strong' : node.name === 'Emphasis' ? 'cm-live-em' : /^ATXHeading/.test(node.name) ? 'cm-live-heading' : ''
        if (cls) ranges.push(Decoration.mark({ class: cls }).range(node.from, node.to))
      } })
      this.decorations = Decoration.set(ranges, true)
    }
  }, { decorations: plugin => plugin.decorations }), EditorView.baseTheme({
    '.cm-live-strong': { fontWeight: '700' }, '.cm-live-em': { fontStyle: 'italic' }, '.cm-live-heading': { fontSize: '1.35em', fontWeight: '650' },
  })]
}
