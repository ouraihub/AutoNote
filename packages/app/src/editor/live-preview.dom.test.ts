import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, test, vi } from 'vitest'
import { livePreview } from './live-preview'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  vi.useRealTimers()
  document.body.replaceChildren()
})

test('defers preview refresh until IME composition ends', async () => {
  vi.useFakeTimers()
  const parent = document.createElement('div')
  document.body.append(parent)
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc: 'hello',
      extensions: [
        livePreview({ title: () => 'Test', prepare: () => () => {} }),
      ],
    }),
  })
  const editor = view
  const updates = vi.spyOn(editor, 'dispatch')
  editor.contentDOM.dispatchEvent(
    new CompositionEvent('compositionstart', { bubbles: true }),
  )
  editor.dispatch({ changes: { from: editor.state.doc.length, insert: 'x' } })
  updates.mockClear()
  await vi.advanceTimersByTimeAsync(200)
  expect(updates).not.toHaveBeenCalled()
  editor.contentDOM.dispatchEvent(
    new CompositionEvent('compositionend', { bubbles: true }),
  )
  await vi.advanceTimersByTimeAsync(300)
  expect(updates).toHaveBeenCalled()
  expect(editor.state.doc.toString()).toBe('hellox')
})
