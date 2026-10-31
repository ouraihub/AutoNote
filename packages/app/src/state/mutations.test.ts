import { describe, expect, test, vi } from 'vitest'
import type { Folder, NoteSummary, Tag } from '@shared/types'
import {
  OrganizeActions,
  type OrganizeActionsOptions,
  type OrganizeSnapshot,
} from './mutations'

const folder = (id: string, parentId: string | null = null): Folder => ({
  id,
  parentId,
  name: id,
  icon: null,
  color: null,
  position: 1,
  createdAt: 1,
  updatedAt: 1,
})
const note = (
  id: string,
  folderId: string | null,
  tags: string[] = [],
): NoteSummary => ({
  id,
  title: id,
  excerpt: '',
  folderId,
  tags,
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 0,
  charCount: 0,
  rev: 1,
  position: 1,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
})

function setup(
  initial: OrganizeSnapshot,
  overrides: Record<string, unknown> = {},
) {
  let snapshot = initial
  const state = {
    read: () => snapshot,
    write: (patch: Partial<OrganizeSnapshot>) => {
      snapshot = { ...snapshot, ...patch }
    },
  }
  const backend = {
    folders: {
      list: vi.fn(async () => snapshot.folders),
      create: vi.fn(),
      patch: vi.fn(),
      remove: vi.fn(),
      ...overrides,
    },
    tags: {
      list: vi.fn(async () => snapshot.tags),
      create: vi.fn(),
      patch: vi.fn(),
      remove: vi.fn(),
      ...overrides,
    },
    notes: {
      flush: vi.fn(async () => ({ pending: 0, failed: 0 })),
      snapshot: vi.fn(async () => ({
        notes: Object.values(snapshot.notes),
        folders: snapshot.folders,
        tags: snapshot.tags,
        deletions: [],
        cursor: 0,
        serverTime: 0,
      })),
      ...overrides,
    },
  } as unknown as OrganizeActionsOptions['backend']
  const actions = new OrganizeActions({
    backend,
    state,
    notifier: { confirm: vi.fn(async () => true) },
    makeId: (() => {
      let n = 0
      return () => `mutation-${++n}`
    })(),
  })
  return { actions, backend, read: () => snapshot }
}

describe('OrganizeActions', () => {
  test('serializes entity writes and preserves a later optimistic patch after an earlier failure', async () => {
    let rejectFirst!: (error: unknown) => void
    let resolveSecond!: (folder: Folder) => void
    const first = new Promise<Folder>((_, reject) => {
      rejectFirst = reject
    })
    const second = new Promise<Folder>((resolve) => {
      resolveSecond = resolve
    })
    const initial = folder('folder-1')
    const { actions, backend, read } = setup(
      { folders: [initial], tags: [], notes: {}, contents: {} },
      { patch: vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second) },
    )
    const firstWrite = actions.patchFolder('folder-1', { name: 'first' })
    const secondWrite = actions.patchFolder('folder-1', { color: 'red' })
    await Promise.resolve()
    expect(backend.folders.patch).toHaveBeenCalledTimes(1)
    rejectFirst(new Error('first failed'))
    await expect(firstWrite).rejects.toThrow('first failed')
    expect(read().folders[0]?.name).toBe('folder-1')
    expect(read().folders[0]?.color).toBe('red')
    expect(backend.folders.patch).toHaveBeenCalledTimes(2)
    resolveSecond({ ...initial, color: 'red' })
    await expect(secondWrite).resolves.toMatchObject({ color: 'red' })
  })

  test('folder move-up flushes notes and promotes direct children', async () => {
    const { actions, backend, read } = setup(
      {
        folders: [
          folder('root'),
          folder('child', 'root'),
          folder('grandchild', 'child'),
        ],
        tags: [],
        notes: { a: note('a', 'root'), b: note('b', 'grandchild') },
        contents: {},
      },
      { remove: vi.fn(async () => ({ ok: true as const })) },
    )
    await expect(actions.removeFolder('root')).resolves.toBe(true)
    expect(backend.notes.flush).toHaveBeenCalledWith('a')
    expect(backend.notes.flush).toHaveBeenCalledWith('b')
    expect(read().folders.find((item) => item.id === 'root')).toBeUndefined()
    expect(
      read().folders.find((item) => item.id === 'child')?.parentId,
    ).toBeNull()
    expect(read().notes.a?.folderId).toBeNull()
    expect(read().notes.b?.folderId).toBe('grandchild')
  })

  test('tag rename rewrites loaded body and derived summary', async () => {
    const body = '#old\n\nBody'
    const tag: Tag = {
      id: 'tag-1',
      name: 'old',
      color: null,
      count: 1,
      createdAt: 1,
    }
    const { actions, backend, read } = setup(
      {
        folders: [],
        tags: [tag],
        notes: { n: { ...note('n', null, ['old']), excerpt: 'old' } },
        contents: { n: body },
      },
      {
        patch: vi.fn(async () => ({
          tag: { ...tag, name: 'new' },
          renamed: 1,
        })),
      },
    )
    await actions.renameTag('tag-1', 'new')
    expect(backend.notes.flush).toHaveBeenCalledWith('n')
    expect(read().contents.n).toContain('#new')
    expect(read().notes.n?.tags).toEqual(['new'])
  })
})
