import { fireEvent, render, screen } from '@testing-library/svelte'
import { expect, test } from 'vitest'
import PrimitiveHarness from './PrimitiveHarness.svelte'

test('supports keyboard controls and blocks disabled submission', async () => {
  render(PrimitiveHarness)

  const action = screen.getByRole('button', { name: 'Save changes' })
  const disabled = screen.getByRole('button', { name: 'Disabled action' })
  const checkbox = screen.getByRole('checkbox', { name: 'Enable notes' })
  const autosave = screen.getByRole('switch', { name: 'Autosave notes' })
  const split = screen.getByRole('radio', { name: 'Split' })
  const preview = screen.getByRole('radio', { name: 'Preview' })

  await fireEvent.click(action)
  await fireEvent.click(disabled)
  await fireEvent.keyDown(checkbox, { key: ' ' })
  await fireEvent.click(autosave)
  await fireEvent.click(preview)

  expect(screen.getByText('Saved 1 time')).toBeTruthy()
  expect((disabled as HTMLButtonElement).disabled).toBe(true)
  expect(checkbox.getAttribute('data-state')).toBe('checked')
  expect(autosave.getAttribute('data-state')).toBe('checked')
  expect(split.getAttribute('aria-checked')).toBe('false')
  expect(preview.getAttribute('aria-checked')).toBe('true')
})
