import { completionStatus, currentCompletions } from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { render } from '@testing-library/svelte'
import type { EditorSettings } from '@shared/types'
import { expect, test, vi } from 'vitest'
import CodeEditor from './CodeEditor.svelte'
import { insertWikiLink } from './actions'
import type { CompletionNote, CompletionSources } from './completion'
import { createEditorServices } from './testing'

// jsdom has no layout; CodeMirror needs a measurable range to position completion tooltips.
Range.prototype.getClientRects = () => {
  const rects = [new DOMRect(0, 0, 1, 16)]
  return Object.assign(rects, { item: (index: number) => rects[index] ?? null }) as unknown as DOMRectList
}
Range.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 1, 16)

const settings: EditorSettings = {
  fontSize: 14,
  fontFamily: 'mono',
  lineNumbers: false,
  typewriter: false,
  focusMode: false,
  spellcheck: false,
  showToolbar: true,
  tabSize: 2,
  autoSaveDelay: 1000,
}

function mountEditor(completion: Partial<CompletionSources>, value = ''): EditorView {
  let view: EditorView | null = null
  render(CodeEditor, {
    props: {
      noteId: 'note-a',
      value,
      settings,
      services: createEditorServices({ completion }),
      onChange: () => {},
      onViewReady: (next: EditorView | null) => (view = next),
    },
  })
  if (!view) throw new Error('editor view was not created')
  return view
}

function type(view: EditorView, text: string): void {
  const at = view.state.selection.main.head
  view.dispatch({
    changes: { from: at, insert: text },
    selection: { anchor: at + text.length },
    userEvent: 'input.type',
  })
}

/**
 * CodeMirror ignores completion keys for 75 ms after the list opens (measured with
 * `Date.now`); advancing that clock models a human keystroke without a real wait.
 */
let clockOffset = 0
const realNow = Date.now.bind(Date)
vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset)

function press(view: EditorView, key: string): void {
  clockOffset += 100
  view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

test('opens wiki completion from the toolbar and accepts a title with the keyboard', async () => {
  const view = mountEditor({
    notes: () => [
      { id: '1', title: 'Alpha', excerpt: '' },
      { id: '2', title: 'Beta', excerpt: '' },
    ],
  })

  insertWikiLink(view)
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  expect(currentCompletions(view.state).map((option) => option.label)).toEqual(['Alpha', 'Beta'])

  press(view, 'ArrowDown')
  press(view, 'Enter')

  expect(view.state.doc.toString()).toBe('[[Beta]]')
  expect(view.state.selection.main.head).toBe('[[Beta]]'.length)
  expect(completionStatus(view.state)).toBeNull()
})

test('typing a wiki link opens completion and Enter accepts it', async () => {
  const view = mountEditor({ notes: () => [{ id: '1', title: 'Alpha', excerpt: '' }] })
  type(view, '[[Al')
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  press(view, 'Enter')
  expect(view.state.doc.toString()).toBe('[[Alpha]]')
})

test('accepts tag and code fence completions with Tab', async () => {
  const view = mountEditor({ tags: () => [{ name: 'research', count: 2 }] }, 'Topic ')
  view.dispatch({ selection: { anchor: view.state.doc.length } })

  type(view, '#res')
  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  press(view, 'Tab')
  expect(view.state.doc.toString()).toBe('Topic #research')

  type(view, '\n```py')
  await vi.waitFor(() => expect(currentCompletions(view.state)[0]?.label).toBe('python'))
  press(view, 'Tab')
  expect(view.state.doc.toString()).toBe('Topic #research\n```python')
})

test('aborts a slow note query once the user keeps typing and shows only the latest answer', async () => {
  const calls: { query: string; signal: AbortSignal; resolve: (notes: CompletionNote[]) => void }[] = []
  const view = mountEditor({
    notes: (query, signal) => {
      const { promise, resolve } = Promise.withResolvers<CompletionNote[]>()
      calls.push({ query, signal, resolve })
      return promise
    },
  })

  type(view, '[[Al')
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  type(view, 'p')
  await vi.waitFor(() => expect(calls).toHaveLength(2))

  const [stale, latest] = calls
  expect(stale?.signal.aborted).toBe(true)
  expect(latest?.query).toBe('Alp')
  stale?.resolve([{ id: 'old', title: 'Almanac', excerpt: '' }])
  latest?.resolve([{ id: '1', title: 'Alpha', excerpt: '' }])

  await vi.waitFor(() => expect(completionStatus(view.state)).toBe('active'))
  expect(currentCompletions(view.state).map((option) => option.label)).toEqual(['Alpha', 'Alp'])
})
