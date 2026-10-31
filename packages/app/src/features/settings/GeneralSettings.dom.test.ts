import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import type { AttachmentWithUsage } from '@shared/types'
import type { Backend } from '@app/backend'
import { BackendError } from '@app/backend/errors'
import type { I18nState } from '@app/i18n/runtime.svelte'
import type { NotesState } from '@app/state/notes.svelte'
import type { SessionState } from '@app/state/session.svelte'
import type { SettingsState } from '@app/state/settings.svelte'
import type { Notifier } from '@app/platform/notifier'
import GeneralSettingsHarness from './GeneralSettingsHarness.svelte'

const settings = {
  current: {
    appearance: {
      language: 'en-US',
      theme: 'light',
      accent: 'cinnabar',
      background: 'paper',
      density: 'comfortable',
      proseFont: 'sans',
      proseWidth: 'normal',
      proseSize: 16,
      proseLineHeight: 1.7,
    },
    editor: {
      fontSize: 15,
      fontFamily: 'mono',
      lineNumbers: true,
      showToolbar: true,
      spellcheck: true,
      typewriter: false,
      focusMode: false,
      tabSize: 2,
      autoSaveDelay: 500,
    },
    preview: {
      syncScroll: true,
      math: true,
      mermaid: true,
      codeBlockCollapse: false,
      codeBlockCollapseLines: 20,
      showToc: true,
    },
    sync: { realtime: false, pollIntervalMs: 30000 },
  },
  update: vi.fn(),
  error: null,
} as unknown as SettingsState
const i18n = {
  t: (
    key: keyof typeof EN_US_MESSAGES,
    params?: Record<string, string | number>,
  ) =>
    EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
      String(params?.[name] ?? placeholder),
    ),
  formatNumber: (value: number) => String(value),
} as I18nState
const notes = { applySync: vi.fn() } as unknown as NotesState
const session = {
  canSignIn: false,
  user: null,
  site: { version: '1.0' },
} as unknown as SessionState
const notifier = {
  confirm: vi.fn(async () => true),
  toast: vi.fn(),
} as Notifier
const exportTo = vi.fn<Backend['transfer']['exportTo']>(async () => ({
  saved: true,
}))
const importFrom = vi.fn<Backend['transfer']['importFrom']>(async () => null)
const list = vi.fn<Backend['files']['list']>(async () => ({
  files: [] as AttachmentWithUsage[],
  nextCursor: null as string | null,
}))
const remove = vi.fn(async () => ({ ok: true as const }))
const prune = vi.fn(async () => ({ removed: 0, freedBytes: 0 }))
const backend = {
  kind: 'desktop',
  capabilities: { accounts: false, realtime: false },
  transfer: { sources: ['files', 'folder'], exportTo, importFrom },
  files: { list, remove, prune },
  settings: { stats: vi.fn(async () => ({ notes: 2 })) },
  notes: { snapshot: vi.fn(async () => ({})) },
} as unknown as Backend
const renderSection = (
  section: 'appearance' | 'editor' | 'sync' | 'data' | 'about' | 'attachments',
) =>
  render(GeneralSettingsHarness, {
    props: { section, settings, i18n, notes, session, notifier, backend },
  })
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('appearance and editor controls update shared settings immediately', async () => {
  renderSection('appearance')
  await fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
  expect(settings.update).toHaveBeenCalledWith({
    appearance: { theme: 'dark' },
  })
  cleanup()
  renderSection('editor')
  await fireEvent.click(screen.getByRole('switch', { name: 'Focus mode' }))
  expect(settings.update).toHaveBeenCalledWith({ editor: { focusMode: true } })
})

test('cancelled transfer never reports completion; successful export reports success', async () => {
  exportTo.mockImplementationOnce(async (_format, options) => {
    options?.onProgress?.({
      jobId: '1',
      phase: 'reading',
      completed: 2,
      total: 4,
      terminal: false,
    })
    return null
  })
  renderSection('data')
  await fireEvent.click(screen.getByRole('button', { name: 'Download ZIP' }))
  await waitFor(() => expect(exportTo).toHaveBeenCalledTimes(1))
  expect(screen.queryByText('Export completed')).toBeNull()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Select file' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Select file' }))
  await waitFor(() =>
    expect(importFrom).toHaveBeenCalledWith(
      'files',
      'newer',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ),
  )
  expect(screen.queryByText('Import completed')).toBeNull()
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Download JSON',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  )
  await fireEvent.click(screen.getByRole('button', { name: 'Download JSON' }))
  await waitFor(() => expect(screen.getByText('Export completed')).toBeTruthy())
})

test('attachment pages retain unique ids, prevent referenced deletion and ask before pruning', async () => {
  list.mockResolvedValueOnce({
    files: [
      { id: 'used', filename: 'used.png', references: 1, mime: 'image/png' },
      { id: 'free', filename: 'free.png', references: 0, mime: 'image/png' },
    ] as AttachmentWithUsage[],
    nextCursor: 'next',
  })
  list.mockResolvedValueOnce({
    files: [
      { id: 'free', filename: 'free.png', references: 0, mime: 'image/png' },
      {
        id: 'later',
        filename: 'later.pdf',
        references: 0,
        mime: 'application/pdf',
      },
    ] as AttachmentWithUsage[],
    nextCursor: null,
  })
  renderSection('attachments')
  await screen.findByText(/used.png/)
  expect(
    (
      screen.getByRole('button', {
        name: 'Delete attachment: used.png',
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true)
  await fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByText(/later.pdf/)
  expect(screen.getAllByText(/free.png/)).toHaveLength(1)
  await fireEvent.click(
    screen.getByRole('button', { name: 'Delete attachment: free.png' }),
  )
  await waitFor(() => expect(remove).toHaveBeenCalledWith('free'))
  await waitFor(() =>
    expect(
      (
        screen.getByRole('button', {
          name: 'Clean up unreferenced',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false),
  )
  expect(remove).not.toHaveBeenCalledWith('used')
  await fireEvent.click(
    screen.getByRole('button', { name: 'Clean up unreferenced' }),
  )
  await waitFor(() => expect(prune).toHaveBeenCalledTimes(1))
  expect(notifier.confirm).toHaveBeenCalled()
})

test('failed attachment next page retries the same cursor without losing earlier rows', async () => {
  list.mockResolvedValueOnce({
    files: [
      { id: 'first', filename: 'first.png', references: 0, mime: 'image/png' },
    ] as AttachmentWithUsage[],
    nextCursor: 'page-2',
  })
  list.mockRejectedValueOnce(
    new BackendError('storage_unavailable', 503, 'unavailable'),
  )
  list.mockResolvedValueOnce({
    files: [
      { id: 'first', filename: 'first.png', references: 0, mime: 'image/png' },
      { id: 'last', filename: 'last.png', references: 0, mime: 'image/png' },
    ] as AttachmentWithUsage[],
    nextCursor: null,
  })
  renderSection('attachments')
  await screen.findByText(/first.png/)
  await fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await screen.findByRole('alert')
  expect(screen.queryByText(/last.png/)).toBeNull()
  await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await screen.findByText(/last.png/)
  expect(screen.getAllByText(/first.png/)).toHaveLength(1)
  expect(list.mock.calls.map(([cursor]) => cursor)).toEqual([
    undefined,
    'page-2',
    'page-2',
  ])
})

test('desktop about never offers account logout', () => {
  renderSection('about')
  expect(screen.queryByRole('button', { name: 'Exit' })).toBeNull()
  expect(screen.getByText(/1.0/)).toBeTruthy()
})
