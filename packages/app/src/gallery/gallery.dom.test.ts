import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte'
import { afterEach, expect, test } from 'vitest'
import Gallery from './Gallery.svelte'

afterEach(cleanup)

test('shows interactive control states without a backend', async () => {
  render(Gallery)

  expect(screen.getByTestId('gallery')).toBeTruthy()
  const disabled = screen.getByRole('button', { name: 'Disabled action' })
  expect((disabled as HTMLButtonElement).disabled).toBe(true)

  await fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }))
  expect(
    await screen.findByRole('dialog', { name: 'Gallery dialog' }),
  ).toBeTruthy()
  await fireEvent.keyDown(
    screen.getByRole('dialog', { name: 'Gallery dialog' }),
    { key: 'Escape' },
  )
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Gallery dialog' })).toBeNull(),
  )

  await fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }))
  expect(
    await screen.findByRole('dialog', { name: 'Gallery drawer' }),
  ).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }))
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Gallery drawer' })).toBeNull(),
  )
})
