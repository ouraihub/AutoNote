import { describe, expect, test } from 'vitest'
import type { Folder, NoteSummary } from '@shared/types'
import {
  RECENT_NOTES_LIMIT,
  buildFolderTree,
  folderDescendantIds,
  folderPath,
  selectNavigation,
  selectVisibleNotes,
  type NoteListQuery,
} from './selectors'

function note(id: string, overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    title: id,
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

function folder(id: string, parentId: string | null, position = 0): Folder {
  return { id, parentId, name: id, icon: null, color: null, position, createdAt: 1, updatedAt: 1 }
}

function byId(notes: NoteSummary[]): Record<string, NoteSummary> {
  return Object.fromEntries(notes.map((item) => [item.id, item]))
}

const QUERY: NoteListQuery = {
  view: 'all',
  folderId: null,
  tag: null,
  sort: 'updated',
  order: 'desc',
  locale: 'en-US',
}

describe('selectVisibleNotes', () => {
  const notes = byId([
    note('live', { updatedAt: 5, folderId: 'child', tags: ['work'], isStarred: true }),
    note('pinned', { updatedAt: 1, isPinned: true }),
    note('archived', { isArchived: true, isStarred: true }),
    note('trashed-old', { deletedAt: 10, folderId: 'root' }),
    note('trashed-new', { deletedAt: 20 }),
  ])
  const folders = [folder('root', null), folder('child', 'root')]

  test('keeps trash and archive out of normal views', () => {
    expect(selectVisibleNotes(notes, folders, QUERY).map((item) => item.id)).toEqual(['pinned', 'live'])
    expect(selectVisibleNotes(notes, folders, { ...QUERY, view: 'starred' }).map((item) => item.id)).toEqual(['live'])
    expect(selectVisibleNotes(notes, folders, { ...QUERY, view: 'archived' }).map((item) => item.id)).toEqual([
      'archived',
    ])
  })

  test('orders trash by deletion time, newest first', () => {
    expect(selectVisibleNotes(notes, folders, { ...QUERY, view: 'trash' }).map((item) => item.id)).toEqual([
      'trashed-new',
      'trashed-old',
    ])
  })

  test('includes descendant folders and matches tags exactly', () => {
    const inRoot = selectVisibleNotes(notes, folders, { ...QUERY, view: 'folder', folderId: 'root' })
    expect(inRoot.map((item) => item.id)).toEqual(['live'])
    expect(selectVisibleNotes(notes, folders, { ...QUERY, view: 'tag', tag: 'wor' })).toEqual([])
  })

  test('sorts titles numerically with id as a stable tie-breaker', () => {
    const titled = byId([
      note('b', { title: 'Note 10' }),
      note('a', { title: 'note 2' }),
      note('c', { title: 'Note 2' }),
    ])
    const sorted = selectVisibleNotes(titled, [], { ...QUERY, sort: 'title', order: 'asc' })

    expect(sorted.map((item) => item.id)).toEqual(['a', 'c', 'b'])
  })

  test('limits the recent view', () => {
    const many = byId(
      Array.from({ length: RECENT_NOTES_LIMIT + 5 }, (_, index) => note(`n${index}`, { updatedAt: index })),
    )
    const recent = selectVisibleNotes(many, [], { ...QUERY, view: 'recent' })

    expect(recent).toHaveLength(RECENT_NOTES_LIMIT)
    expect(recent[0]?.id).toBe(`n${RECENT_NOTES_LIMIT + 4}`)
  })
})

describe('selectNavigation', () => {
  test('counts each note in exactly one primary bucket', () => {
    const projection = selectNavigation(
      byId([
        note('a', { folderId: 'f', isStarred: true }),
        note('b'),
        note('c', { isArchived: true, folderId: 'f' }),
        note('d', { deletedAt: 1, isArchived: true }),
      ]),
    )

    expect(projection.counts).toEqual({ all: 2, starred: 1, unfiled: 1, archived: 1, trash: 1 })
    expect([...projection.folderCounts]).toEqual([['f', 1]])
  })
})

describe('folder helpers', () => {
  test('cycles do not loop and orphans become roots', () => {
    const folders = [folder('a', 'b'), folder('b', 'a'), folder('orphan', 'missing', 1), folder('root', null, 0)]

    expect([...folderDescendantIds(folders, 'a')].sort()).toEqual(['a', 'b'])
    expect(folderPath(folders, 'a').map((item) => item.id)).toEqual(['b', 'a'])
    expect(buildFolderTree(folders, new Map()).map((node) => node.id)).toEqual(['a', 'root', 'orphan'])
  })

  test('aggregates note totals through descendants', () => {
    const tree = buildFolderTree(
      [folder('root', null), folder('child', 'root'), folder('leaf', 'child')],
      new Map([
        ['root', 1],
        ['leaf', 2],
      ]),
    )

    expect(tree[0]).toMatchObject({ id: 'root', directNotes: 1, totalNotes: 3, depth: 0 })
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({ id: 'leaf', depth: 2, parentId: 'child' })
  })
})
