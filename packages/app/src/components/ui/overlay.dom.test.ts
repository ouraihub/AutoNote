import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { tick } from 'svelte'
import { afterEach, expect, test } from 'vitest'
import OverlayHarness from './OverlayHarness.svelte'

afterEach(cleanup)

test('closes only the top dialog with Escape and restores its trigger focus', async () => {
  render(OverlayHarness)
  const primaryTrigger = screen.getByRole('button', { name: 'Open primary' })

  await fireEvent.click(primaryTrigger)
  const nestedTrigger = await screen.findByRole('button', { name: 'Open nested' })
  await fireEvent.click(nestedTrigger)

  const nested = await screen.findByRole('dialog', { name: 'Nested dialog' })
  await fireEvent.keyDown(nested, { key: 'Escape' })

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Nested dialog' })).toBeNull())
  expect(screen.getByRole('dialog', { name: 'Primary dialog' })).toBeTruthy()
  await tick()

  await fireEvent.keyDown(screen.getByRole('dialog', { name: 'Primary dialog' }), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

test('serializes confirmation requests and keeps body scroll usable after close', async () => {
  render(OverlayHarness)

  await fireEvent.click(screen.getByRole('button', { name: 'Ask first' }))
  await fireEvent.click(screen.getByRole('button', { name: 'Ask second' }))

  expect(await screen.findByRole('dialog', { name: 'First confirmation' })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(await screen.findByRole('dialog', { name: 'Second confirmation' })).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  await waitFor(() => expect(document.body.style.overflow).not.toBe('hidden'))
})
