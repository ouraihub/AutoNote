import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import type { Backlink } from '@shared/types'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { NotesState } from '../../state/notes.svelte'
import BacklinksPanel from './BacklinksPanel.svelte'

const a = '0'.repeat(26)
const b = '1'.repeat(26)
const target = '2'.repeat(26)
const link: Backlink = { id: target, title: 'Target note', context: 'A link to the current note' }
const i18n = {
  t(key: keyof typeof EN_US_MESSAGES) {
    return EN_US_MESSAGES[key]
  },
}

afterEach(() => cleanup())

test('switching notes aborts the old read and never shows its late response; retry reloads failed backlinks', async () => {
  const first = Promise.withResolvers<Backlink[]>()
  const second = Promise.withResolvers<Backlink[]>()
  const backlinks = vi.fn()
    .mockImplementationOnce(() => first.promise)
    .mockImplementationOnce(() => second.promise)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([link])
  const summaries = { [a]: { rev: 1 }, [b]: { rev: 1 } } as unknown as NotesState['summaries']
  const notes = { summaries, cursor: 2, open: vi.fn(), loadErrors: {} }
  const props = { noteId: a, backend: { notes: { backlinks } }, notes, ui: { activePane: 'primary' as const, openNote: vi.fn() }, i18n, extensions: {} }
  const view = render(BacklinksPanel, { props })
  await waitFor(() => expect(backlinks).toHaveBeenCalledTimes(1))
  const oldSignal = backlinks.mock.calls[0]?.[1]?.signal as AbortSignal
  await view.rerender({ ...props, noteId: b })
  await waitFor(() => expect(backlinks).toHaveBeenCalledTimes(2))
  expect(oldSignal.aborted).toBe(true)
  second.resolve([link])
  await screen.findByRole('button', { name: /Target note/ })
  first.resolve([{ id: a, title: 'Stale result', context: 'must not appear' }])
  await first.promise
  expect(screen.getByRole('button', { name: /Target note/ })).toBeTruthy()
  expect(screen.queryByText('Stale result')).toBeNull()
  await view.rerender({ ...props, noteId: b, notes: { ...notes, cursor: 3 } })
  await screen.findByRole('alert')
  expect(screen.getByText('Could not load backlinks')).toBeTruthy()
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(backlinks).toHaveBeenCalledTimes(4))
  expect(screen.getByText(/No notes link here yet/)).toBeTruthy()
  await view.rerender({ ...props, noteId: b, notes: { ...notes, summaries: { ...summaries, [b]: { ...summaries[b]!, rev: 2 } }, cursor: 3 } })
  await waitFor(() => expect(backlinks).toHaveBeenCalledTimes(5))
  expect(screen.getByRole('button', { name: /Target note/ })).toBeTruthy()
  view.unmount()
  expect((backlinks.mock.calls[4]?.[1]?.signal as AbortSignal).aborted).toBe(true)
})

test('opening a backlink uses the active pane and notifies extensions; a failed navigation is visible', async () => {
  const backlinks = vi.fn(async () => [link])
  const loadErrors: Record<string, string> = {}
  const open = vi.fn(async () => {})
  const ui = { activePane: 'secondary' as const, openNote: vi.fn() }
  const extensions = { onNoteOpened: vi.fn() }
  render(BacklinksPanel, {
    props: { noteId: a, backend: { notes: { backlinks } }, notes: { summaries: {}, cursor: 0, open, loadErrors }, ui, i18n, extensions },
  })
  await fireEvent.click(await screen.findByRole('button', { name: /Target note/ }))
  await waitFor(() => expect(extensions.onNoteOpened).toHaveBeenCalledWith(target))
  expect(ui.openNote).toHaveBeenCalledWith(target)
  expect(open).toHaveBeenCalledWith(target, 'secondary')
  expect(screen.queryByRole('alert')).toBeNull()

  open.mockImplementationOnce(async () => { loadErrors[target] = 'not-found' })
  await fireEvent.click(screen.getByRole('button', { name: /Target note/ }))
  expect((await screen.findByRole('alert')).textContent).toBe('Action failed')
  expect(extensions.onNoteOpened).toHaveBeenCalledTimes(1)
})
