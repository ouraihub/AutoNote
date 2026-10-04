import { describe, expect, test } from 'vitest'
import { isBackendError } from '@app/backend'
import type { Folder, NoteSummary, SyncResponse, Tag } from '@shared/types'
import {
  EMPTY_SYNC_SHELL,
  consolidateFullSync,
  mergeSync,
  nextFullSyncPage,
  type LocalNoteStates,
  type NoteTombstones,
  type SyncShell,
} from './merge'

const NO_DIRTY: LocalNoteStates = new Map()
const NO_TOMBSTONES: NoteTombstones = new Map()

function note(id: string, overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    title: `Title ${id}`,
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
    ...overrides,
  }
}

function folder(id: string, overrides: Partial<Folder> = {}): Folder {
  return {
    id,
    parentId: null,
    name: id,
    icon: null,
    color: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function tag(id: string, overrides: Partial<Tag> = {}): Tag {
  return { id, name: id, color: null, count: 0, createdAt: 1, ...overrides }
}

function payload(overrides: Partial<SyncResponse> = {}): SyncResponse {
  return {
    cursor: 1,
    full: false,
    hasMore: false,
    nextKey: null,
    facetsFull: false,
    settingsChanged: false,
    profileChanged: false,
    siteChanged: false,
    notes: [],
    folders: [],
    tags: [],
    deletions: [],
    serverTime: 1,
    ...overrides,
  }
}

function shellOf(notes: NoteSummary[], extra: Partial<SyncShell> = {}): SyncShell {
  return { ...EMPTY_SYNC_SHELL, notes: Object.fromEntries(notes.map((item) => [item.id, item])), ...extra }
}

function expectInvalidResponse(action: () => unknown): void {
  try {
    action()
  } catch (error) {
    expect(isBackendError(error) && error.code).toBe('invalid_response')
    return
  }
  throw new Error('Expected invalid_response')
}

describe('mergeSync summaries', () => {
  test('ignores an incremental response older than the applied cursor', () => {
    const shell = shellOf([note('a', { rev: 3 })], { cursor: 10 })
    const result = mergeSync(shell, payload({ cursor: 7, notes: [note('a', { rev: 5 })] }), NO_DIRTY, NO_TOMBSTONES)

    expect(result.shell).toBe(shell)
    expect(result.refetchIds).toEqual([])
  })

  test('keeps the newer local summary when a response carries a stale rev', () => {
    const current = note('a', { rev: 4, title: 'Newer' })
    const result = mergeSync(
      shellOf([current], { cursor: 2 }),
      payload({ cursor: 3, notes: [note('a', { rev: 2, title: 'Older' })] }),
      NO_DIRTY,
      NO_TOMBSTONES,
    )

    expect(result.shell.notes.a).toBe(current)
    expect(result.shell.cursor).toBe(3)
    expect(result.refetchIds).toEqual([])
  })

  test('is idempotent when the same response is applied twice', () => {
    const response = payload({ cursor: 5, notes: [note('a', { rev: 2 })], folders: [folder('f')], tags: [tag('t')] })
    const first = mergeSync(EMPTY_SYNC_SHELL, response, NO_DIRTY, NO_TOMBSTONES)
    const second = mergeSync(first.shell, response, NO_DIRTY, NO_TOMBSTONES)

    expect(second.shell).toBe(first.shell)
    expect(second.refetchIds).toEqual([])
    expect(second.removedIds).toEqual([])
  })

  test('keeps the highest rev when a note appears twice in one response', () => {
    const result = mergeSync(
      EMPTY_SYNC_SHELL,
      payload({ notes: [note('a', { rev: 3, title: 'Three' }), note('a', { rev: 2, title: 'Two' })] }),
      NO_DIRTY,
      NO_TOMBSTONES,
    )

    expect(result.shell.notes.a?.title).toBe('Three')
  })

  test('adopts metadata changes that do not advance the rev', () => {
    const result = mergeSync(
      shellOf([note('a', { rev: 2, folderId: 'old' })]),
      payload({ cursor: 2, notes: [note('a', { rev: 2, folderId: 'new' })] }),
      NO_DIRTY,
      NO_TOMBSTONES,
    )

    expect(result.shell.notes.a?.folderId).toBe('new')
    expect(result.refetchIds).toEqual([])
  })

  test('requests content only for known notes whose remote rev advanced', () => {
    const result = mergeSync(
      shellOf([note('a', { rev: 1 }), note('b', { rev: 1 })]),
      payload({ cursor: 2, notes: [note('a', { rev: 2 }), note('b', { rev: 1, isStarred: true }), note('c')] }),
      NO_DIRTY,
      NO_TOMBSTONES,
    )

    expect(result.refetchIds).toEqual(['a'])
  })

  test('preserves dirty content-derived fields while adopting remote metadata and keeping the write base', () => {
    const local = note('a', { rev: 2, title: 'Local', excerpt: 'local body', wordCount: 9, updatedAt: 50 })
    const dirty: LocalNoteStates = new Map([['a', { kind: 'content', baseRev: 2 }]])
    const result = mergeSync(
      shellOf([local]),
      payload({ cursor: 2, notes: [note('a', { rev: 3, title: 'Remote', isPinned: true, updatedAt: 40 })] }),
      dirty,
      NO_TOMBSTONES,
    )

    expect(result.shell.notes.a).toMatchObject({
      title: 'Local',
      excerpt: 'local body',
      wordCount: 9,
      isPinned: true,
      rev: 2,
      updatedAt: 50,
    })
    expect(result.refetchIds).toEqual([])
  })

  test('applies note deletions except for notes with local changes', () => {
    const dirty: LocalNoteStates = new Map([['b', { kind: 'pending' }]])
    const result = mergeSync(
      shellOf([note('a'), note('b')]),
      payload({
        cursor: 2,
        deletions: [
          { entity: 'note', id: 'a' },
          { entity: 'note', id: 'b' },
        ],
      }),
      dirty,
      NO_TOMBSTONES,
    )

    expect(Object.keys(result.shell.notes)).toEqual(['b'])
    expect(result.removedIds).toEqual(['a'])
  })
})

describe('mergeSync full snapshots', () => {
  test('rejects a full page that still has more pages', () => {
    expectInvalidResponse(() =>
      mergeSync(shellOf([note('a')]), payload({ full: true, hasMore: true, nextKey: 'a' }), NO_DIRTY, NO_TOMBSTONES),
    )
  })

  test('replaces notes but keeps locally changed notes missing from the snapshot', () => {
    const dirty: LocalNoteStates = new Map([
      ['created', { kind: 'pending' }],
      ['edited', { kind: 'content', baseRev: 1 }],
    ])
    const result = mergeSync(
      shellOf([note('gone'), note('created'), note('edited'), note('kept')]),
      payload({ cursor: 9, full: true, facetsFull: true, notes: [note('kept')] }),
      dirty,
      NO_TOMBSTONES,
    )

    expect(Object.keys(result.shell.notes).sort()).toEqual(['created', 'edited', 'kept'])
    expect(result.removedIds).toEqual(['gone'])
  })

  test('applies a completed full snapshot even when its cursor is lower after a server reset', () => {
    const result = mergeSync(
      shellOf([note('old')], { cursor: 50 }),
      payload({ cursor: 3, full: true, facetsFull: true, notes: [note('fresh')] }),
      NO_DIRTY,
      NO_TOMBSTONES,
    )

    expect(Object.keys(result.shell.notes)).toEqual(['fresh'])
    expect(result.shell.cursor).toBe(3)
  })
})

describe('mergeSync tombstones', () => {
  test('an older response cannot resurrect a purged note', () => {
    const tombstones: NoteTombstones = new Map([['a', 20]])
    const stale = payload({ cursor: 20, full: true, facetsFull: true, notes: [note('a', { rev: 9 })] })
    const result = mergeSync(EMPTY_SYNC_SHELL, stale, NO_DIRTY, tombstones)

    expect(result.shell.notes).toEqual({})
    expect(result.tombstones.get('a')).toBe(20)
  })

  test('a purged note stays hidden even while it has local changes', () => {
    const dirty: LocalNoteStates = new Map([['a', { kind: 'pending' }]])
    const tombstones: NoteTombstones = new Map([['a', 20]])
    const result = mergeSync(shellOf([note('a')], { cursor: 10 }), payload({ cursor: 12 }), dirty, tombstones)

    expect(result.shell.notes).toEqual({})
    expect(result.removedIds).toEqual(['a'])
  })

  test('expires once a later cursor proves the deletion was observed', () => {
    const tombstones: NoteTombstones = new Map([['a', 20]])
    const result = mergeSync(
      EMPTY_SYNC_SHELL,
      payload({ cursor: 21, notes: [note('a', { rev: 1 })] }),
      NO_DIRTY,
      tombstones,
    )

    expect(result.tombstones.has('a')).toBe(false)
    expect(result.shell.notes.a).toBeDefined()
  })

  test('a purge without a known cursor is anchored by the first response that confirms it', () => {
    const tombstones: NoteTombstones = new Map([['a', null]])
    const unconfirmed = mergeSync(EMPTY_SYNC_SHELL, payload({ cursor: 30, notes: [note('a')] }), NO_DIRTY, tombstones)
    expect(unconfirmed.shell.notes).toEqual({})
    expect(unconfirmed.tombstones.get('a')).toBeNull()

    const confirmed = mergeSync(
      unconfirmed.shell,
      payload({ cursor: 31, deletions: [{ entity: 'note', id: 'a' }] }),
      NO_DIRTY,
      unconfirmed.tombstones,
    )
    expect(confirmed.tombstones.get('a')).toBe(31)

    const later = mergeSync(confirmed.shell, payload({ cursor: 32 }), NO_DIRTY, confirmed.tombstones)
    expect(later.tombstones.has('a')).toBe(false)
  })
})

describe('mergeSync folders and tags', () => {
  test('incremental facets merge by id and apply their deletions', () => {
    const shell: SyncShell = { ...EMPTY_SYNC_SHELL, folders: [folder('a'), folder('b')], tags: [tag('x'), tag('y')] }
    const result = mergeSync(
      shell,
      payload({
        folders: [folder('a', { name: 'Renamed' })],
        tags: [tag('z')],
        deletions: [
          { entity: 'folder', id: 'b' },
          { entity: 'tag', id: 'x' },
        ],
      }),
      NO_DIRTY,
      NO_TOMBSTONES,
    )

    expect(result.shell.folders.map((item) => [item.id, item.name])).toEqual([['a', 'Renamed']])
    expect(result.shell.tags.map((item) => item.id)).toEqual(['y', 'z'])
  })

  test('facetsFull replaces both collections with the complete server set', () => {
    const shell: SyncShell = { ...EMPTY_SYNC_SHELL, folders: [folder('a'), folder('b')], tags: [tag('x')] }
    const result = mergeSync(
      shell,
      payload({ facetsFull: true, folders: [folder('b')], tags: [] }),
      NO_DIRTY,
      NO_TOMBSTONES,
    )

    expect(result.shell.folders.map((item) => item.id)).toEqual(['b'])
    expect(result.shell.folders[0]).toBe(shell.folders[1])
    expect(result.shell.tags).toEqual([])
  })
})

describe('full sync staging', () => {
  const first = payload({
    cursor: 8,
    full: true,
    hasMore: true,
    nextKey: 'b',
    facetsFull: true,
    notes: [note('a'), note('b')],
    folders: [folder('f')],
    tags: [tag('t')],
  })
  const last = payload({ cursor: 8, full: true, facetsFull: true, notes: [note('c')], serverTime: 9 })

  test('requests the next page with a fixed snapshot cursor', () => {
    expect(nextFullSyncPage([first])).toEqual({ after: 'b', snapshot: 8 })
    expect(nextFullSyncPage([first, last])).toBeNull()
  })

  test('keeps first-page facets when later pages carry empty folders and tags', () => {
    const consolidated = consolidateFullSync([first, last], [])

    expect(consolidated.notes.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(consolidated.folders.map((item) => item.id)).toEqual(['f'])
    expect(consolidated.tags.map((item) => item.id)).toEqual(['t'])
    expect(consolidated).toMatchObject({ full: true, hasMore: false, nextKey: null, cursor: 8, serverTime: 9 })
  })

  test('applies catch-up increments in order, including deletions and facet replacement', () => {
    const consolidated = consolidateFullSync(
      [first, last],
      [
        payload({ cursor: 9, notes: [note('d')], deletions: [{ entity: 'note', id: 'a' }], settingsChanged: true }),
        payload({ cursor: 10, facetsFull: true, folders: [folder('g')], tags: [], serverTime: 12 }),
      ],
    )

    expect(consolidated.notes.map((item) => item.id).sort()).toEqual(['b', 'c', 'd'])
    expect(consolidated.folders.map((item) => item.id)).toEqual(['g'])
    expect(consolidated.tags).toEqual([])
    expect(consolidated).toMatchObject({ cursor: 10, serverTime: 12, settingsChanged: true })
  })

  test('rejects an unfinished, expired or repeating page chain', () => {
    expectInvalidResponse(() => consolidateFullSync([first], []))
    expectInvalidResponse(() => consolidateFullSync([first, { ...last, cursor: 9 }], []))
    expectInvalidResponse(() => nextFullSyncPage([first, { ...last, hasMore: true, nextKey: 'b' }]))
    expectInvalidResponse(() => nextFullSyncPage([{ ...first, nextKey: null }]))
    expectInvalidResponse(() => consolidateFullSync([], []))
  })

  test('rejects catch-up increments that go backwards or switch to full', () => {
    expectInvalidResponse(() => consolidateFullSync([first, last], [payload({ cursor: 7 })]))
    expectInvalidResponse(() => consolidateFullSync([first, last], [payload({ cursor: 9, full: true })]))
  })
})
