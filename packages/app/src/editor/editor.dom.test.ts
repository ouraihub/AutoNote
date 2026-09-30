import { fireEvent, render, screen } from '@testing-library/svelte'
import { expect, test } from 'vitest'
import EditorHarness from './EditorHarness.svelte'

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
