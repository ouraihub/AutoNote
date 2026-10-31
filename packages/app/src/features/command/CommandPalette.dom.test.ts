import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/svelte'
import { afterEach, expect, test, vi } from 'vitest'
import type { Backend } from '@app/backend'
import type { NotesState } from '@app/state/notes.svelte'
import type { UiState } from '@app/state/ui.svelte'
import type { NoteSummary, SearchResponse } from '@shared/types'
import { EN_US_MESSAGES } from '@shared/locales/en-US'
import CommandPalette from './CommandPalette.svelte'

const i18n = {
  t(
    key: keyof typeof EN_US_MESSAGES,
    params?: Readonly<
      Record<string, boolean | number | string | null | undefined>
    >,
  ) {
    return EN_US_MESSAGES[key].replace(/\{(\w+)\}/g, (whole, name: string) =>
      String(params?.[name] ?? whole),
    )
  },
}

function note(id: string, title: string): NoteSummary {
  return {
    id,
    title,
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
  }
}

function response(value: NoteSummary | null): SearchResponse {
  return {
    results: value ? [{ note: value, snippet: '', score: 1 }] : [],
    mode: 'fts',
    took: 0,
    query: { text: '', tags: [], folder: null, starred: null, archived: null },
  }
}

function mount(
  summaries: NoteSummary[] = [],
  query: (text: string) => Promise<SearchResponse> = async () => response(null),
) {
  const ui = {
    recent: [],
    activePane: 'primary',
    openPanel: vi.fn(),
    openView: vi.fn(),
    openNote: vi.fn(),
  }
  const notes = {
    summaries: Object.fromEntries(summaries.map((item) => [item.id, item])),
    readOrganizeSnapshot: () => ({ tags: [], folders: [] }),
    open: vi.fn(async () => {}),
    create: vi.fn(),
  }
  const onOpenChange = vi.fn()
  render(CommandPalette, {
    props: {
      notes: notes as unknown as NotesState,
      ui: ui as unknown as UiState,
      backend: { search: { query } } as unknown as Backend,
      i18n,
      onOpenChange,
    },
  })
  return { ui, notes, onOpenChange, query }
}

afterEach(cleanup)

test('a superseded slow search cannot show old content matches or overwrite the new query', async () => {
  const old = Promise.withResolvers<SearchResponse>()
  const newer = Promise.withResolvers<SearchResponse>()
  const search = vi.fn((text: string) =>
    text === 'first' ? old.promise : newer.promise,
  )
  mount([], search)
  const input = await screen.findByRole('combobox')
  await fireEvent.input(input, { target: { value: 'first' } })
  await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
  await fireEvent.input(input, { target: { value: 'second' } })
  expect(screen.queryByRole('option', { name: /First content/ })).toBeNull()
  await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
  newer.resolve(response(note('2'.repeat(26), 'Second content')))
  await screen.findByRole('option', { name: /Second content/ })
  old.resolve(response(note('1'.repeat(26), 'First content')))
  await waitFor(() =>
    expect(screen.queryByRole('option', { name: /First content/ })).toBeNull(),
  )
  expect(screen.getByRole('option', { name: /Second content/ })).toBeTruthy()
})

test('arrows and Enter navigate a note; Enter executes a command; Escape closes the palette', async () => {
  const item = note('3'.repeat(26), 'Reading list')
  const secondItem = note('4'.repeat(26), 'Reading diary')
  const { ui, notes, onOpenChange } = mount([item, secondItem])
  const input = await screen.findByRole('combobox')
  await fireEvent.input(input, { target: { value: 'reading' } })
  await screen.findByRole('option', { name: /Reading list/ })
  const options = screen.getAllByRole('option')
  expect(options).toHaveLength(2)
  expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  await fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(options[1]?.getAttribute('aria-selected')).toBe('true')
  await fireEvent.keyDown(input, { key: 'ArrowUp' })
  expect(options[0]?.getAttribute('aria-selected')).toBe('true')
  await fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() =>
    expect(notes.open).toHaveBeenCalledWith(item.id, 'primary'),
  )
  expect(ui.openNote).toHaveBeenCalledWith(item.id)
  expect(onOpenChange).toHaveBeenCalledWith(false)

  await fireEvent.input(input, { target: { value: 'settings' } })
  await screen.findByRole('option', { name: /Open settings/ })
  await fireEvent.keyDown(input, { key: 'Enter' })
  expect(ui.openPanel).toHaveBeenCalledWith('settings')
  await fireEvent.keyDown(input, { key: 'Escape' })
  expect(onOpenChange).toHaveBeenCalledWith(false)
})
