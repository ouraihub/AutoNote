import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { Note, NoteVersion, NoteVersionMeta } from '@shared/types'
import type { Backend } from '../../backend'
import type { Logger } from '../../log/logger'
import { NotesState } from '../../state/notes.svelte'
import VersionsPanel from './VersionsPanel.svelte'

const i18n = {
  t(key: keyof typeof EN_US_MESSAGES, params?: Readonly<Record<string, boolean | number | string | null | undefined>>) {
    return EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (whole, name: string) => String(params?.[name] ?? whole))
  },
}
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function note(id: string, content: string, rev = 1): Note {
  return {
    id, content, rev, title: id, excerpt: content, folderId: null, tags: [], isPinned: false,
    isStarred: false, isArchived: false, wordCount: content.length, charCount: content.length,
    position: 1, createdAt: 1, updatedAt: rev, deletedAt: null,
  }
}
function version(noteId: string, id: string, content: string): NoteVersion {
  return { noteId, id, content, title: id, size: content.length, createdAt: 1 }
}
function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>()
  return { promise, resolve }
}

afterEach(() => { cleanup(); vi.restoreAllMocks() })

test('switching notes and versions aborts stale reads and never displays their history or previews', async () => {
  const firstList = deferred<NoteVersionMeta[]>()
  const firstPreview = deferred<NoteVersion>()
  const secondPreview = deferred<NoteVersion>()
  const firstVersions = [version('first', 'old-one', 'first old body'), version('first', 'old-two', 'first other body')]
  const secondVersions = [version('second', 'new-one', 'second old body')]
  const backend = {
    notes: {
      versions: vi.fn((id: string, options?: { signal?: AbortSignal }) => {
        void options
        return id === 'first' ? firstList.promise : Promise.resolve(secondVersions)
      }),
      version: vi.fn((id: string, selected: string, options?: { signal?: AbortSignal }) => {
        void options
        return id === 'first' ? (selected === 'old-one' ? firstPreview.promise : secondPreview.promise) : Promise.resolve(secondVersions.find((v) => v.id === selected)!)
      }),
      restoreVersion: vi.fn(),
    },
  }
  const notes = {
    panes: { primary: 'first', secondary: null }, summaries: { first: note('first', 'new'), second: note('second', 'new') },
    contents: {}, dirtyById: {}, loadErrors: {}, flush: vi.fn(), open: vi.fn(),
  }
  const props = { noteId: 'first', pane: 'primary' as const, backend, notes, i18n, notifier: { confirm: vi.fn(async () => true) }, onClose: vi.fn() }
  const view = render(VersionsPanel, { props })
  await waitFor(() => expect(backend.notes.versions).toHaveBeenCalledTimes(1))
  const firstSignal = backend.notes.versions.mock.calls[0]![1]!.signal!
  await view.rerender({ ...props, noteId: 'second' })
  await screen.findByText('new-one', { exact: false })
  expect(firstSignal.aborted).toBe(true)
  firstList.resolve(firstVersions)
  await waitFor(() => expect(screen.queryByText('old-one', { exact: false })).toBeNull())
  await screen.findByText('second old body')
  await view.rerender(props)
  await screen.findByText('old-one', { exact: false })
  await waitFor(() => expect(backend.notes.version).toHaveBeenCalledWith('first', 'old-one', expect.anything()))
  const previewSignal = backend.notes.version.mock.calls.find((call) => call[0] === 'first')![2]!.signal!
  await fireEvent.click(screen.getByRole('button', { name: /old-two/ }))
  await waitFor(() => expect(backend.notes.version).toHaveBeenCalledWith('first', 'old-two', expect.anything()))
  expect(previewSignal.aborted).toBe(true)
  firstPreview.resolve(firstVersions[0]!)
  await waitFor(() => expect(screen.queryByText('first old body')).toBeNull())
  expect(screen.getByRole('button', { name: /old-two/ }).getAttribute('aria-pressed')).toBe('true')
})

test('restores through backend, advances current rev and retains overwritten body as a readable version', async () => {
  let stored = note('current', 'current body', 4)
  const history = [version('current', 'older', 'previous body')]
  const notesPort = {
    get: vi.fn(async () => ({ ...stored })),
    versions: vi.fn(async () => history.map((item) => ({ noteId: item.noteId, id: item.id, title: item.title, size: item.size, createdAt: item.createdAt }))),
    version: vi.fn(async (_id: string, versionId: string) => history.find((item) => item.id === versionId)!),
    restoreVersion: vi.fn(async (_id: string, versionId: string) => {
      history.unshift(version('current', 'overwritten', stored.content))
      stored = note('current', history.find((item) => item.id === versionId)!.content, stored.rev + 1)
      return { ...stored }
    }),
    flush: vi.fn(async () => ({ pending: 0, failed: 0 })),
  }
  const backend = { kind: 'desktop', notes: notesPort } as unknown as Backend
  const notes = new NotesState({ backend, logger })
  await notes.open('current', 'secondary')
  const notifier = { confirm: vi.fn(async () => true) }
  render(VersionsPanel, { props: {
    noteId: 'current', pane: 'secondary', backend: { notes: notesPort }, notes, i18n, notifier, onClose: vi.fn(),
  } })
  await screen.findByText('previous body')
  await fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
  await waitFor(() => expect(notes.summaries.current?.rev).toBe(5))
  expect(notes.contents.current).toBe('previous body')
  expect(notes.panes.secondary).toBe('current')
  expect(await notesPort.version('current', 'overwritten')).toMatchObject({ content: 'current body' })
  expect(notesPort.restoreVersion).toHaveBeenCalledWith('current', 'older')
  expect(notesPort.flush).toHaveBeenCalledWith('current')
  notes.dispose()
})

test('refuses restore when local writes cannot flush or the note changes during confirmation', async () => {
  let stored = note('current', 'current body', 4)
  let unsafe: 'pending' | 'failed' | null = 'failed'
  const notesPort = {
    get: vi.fn(async () => stored),
    versions: vi.fn(async () => [version('current', 'older', 'previous body')]),
    version: vi.fn(async () => version('current', 'older', 'previous body')),
    restoreVersion: vi.fn(async () => { stored = note('current', 'previous body', 5); return stored }),
    flush: vi.fn(async () => ({ pending: unsafe === 'pending' ? 1 : 0, failed: unsafe === 'failed' ? 1 : 0 })),
  }
  const notes = new NotesState({ backend: { kind: 'desktop', notes: notesPort } as unknown as Backend, logger, debounceMs: 60_000 })
  await notes.open('current')
  const notifier = { confirm: vi.fn(async () => {
    notes.editContent('current', 'unsaved edit')
    return true
  }) }
  render(VersionsPanel, { props: { noteId: 'current', pane: 'primary', backend: { notes: notesPort }, notes, i18n, notifier, onClose: vi.fn() } })
  await screen.findByText('previous body')
  await fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
  await screen.findByText(/Unsaved changes/i)
  expect(notifier.confirm).not.toHaveBeenCalled()
  expect(notesPort.restoreVersion).not.toHaveBeenCalled()
  unsafe = 'pending'
  await fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
  await waitFor(() => expect(notesPort.flush).toHaveBeenCalledTimes(2))
  expect(notifier.confirm).not.toHaveBeenCalled()
  unsafe = null
  await fireEvent.click(screen.getByRole('button', { name: 'Restore this version' }))
  await screen.findByText(/Unsaved changes/i)
  expect(notesPort.restoreVersion).not.toHaveBeenCalled()
  expect(notes.contents.current).toBe('unsaved edit')
  notes.dispose()
})
