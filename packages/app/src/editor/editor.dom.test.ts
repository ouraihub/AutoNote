import { fireEvent, render, screen } from '@testing-library/svelte'
import type { EditorView } from '@codemirror/view'
import { tick } from 'svelte'
import { expect, test } from 'vitest'
import EditorHarness from './EditorHarness.svelte'
import LiveEditorHarness from './LiveEditorHarness.svelte'

test('keeps editor panes and undo histories independent', async () => {
  render(EditorHarness)

  await fireEvent.click(screen.getByRole('button', { name: 'Edit first' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Edit second' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Undo first' }))

  expect(screen.getByTestId('first-editor').textContent).toContain('first')
  expect(screen.getByTestId('first-editor').textContent).not.toContain(' A')
  expect(screen.getByTestId('second-editor').textContent).toContain('second B')
})

test('reports exactly one local write and ignores its external value echo', async () => {
  render(EditorHarness)

  await fireEvent.click(screen.getByRole('button', { name: 'Edit first' }))

  expect(screen.getByTestId('first-changes').textContent).toBe('1')
  expect(screen.getByTestId('second-changes').textContent).toBe('0')
})

test('keeps the focused live-preview line editable when settings re-run with identical values', async () => {
  let view: EditorView | null = null
  const { container } = render(LiveEditorHarness, {
    onView: (next: EditorView | null) => (view = next),
  })
  await tick()
  view!.contentDOM.dispatchEvent(new FocusEvent('focus'))
  view!.dispatch({ selection: { anchor: 5 } })
  expect(container.querySelector('.cm-live-block')).toBeNull()

  await fireEvent.click(screen.getByRole('button', { name: 'Touch settings' }))

  expect(container.querySelector('.cm-live-block')).toBeNull()
  expect(container.querySelector('.cm-line')?.textContent).toBe('hello')
})
