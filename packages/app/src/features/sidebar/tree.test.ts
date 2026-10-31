import { expect, test } from 'vitest'
import { LIMITS } from '@shared/constants'
import type { Folder } from '@shared/types'
import { buildFolderTree, selectNavigation } from '@app/state/selectors'
import { folderDropTarget, folderMoveError } from './tree'

const folder = (id: string, parentId: string | null): Folder => ({
  id,
  parentId,
  name: id,
  icon: null,
  color: null,
  position: 0,
  createdAt: 0,
  updatedAt: 0,
})

test('folder moves reject descendants and over-depth subtrees, preserving active subtree counts', () => {
  const folders = [
    folder('root', null),
    folder('child', 'root'),
    folder('other', null),
  ]
  expect(folderMoveError(folders, 'root', 'child')).toBe('cycle')
  expect(folderMoveError(folders, 'root', 'root')).toBe('cycle')
  expect(folderMoveError(folders, 'child', 'other')).toBeNull()
  expect(folderMoveError(folders, 'root', 'missing')).toBe('missing')
  const chain = Array.from({ length: LIMITS.folderDepthMax }, (_, index) =>
    folder(`level-${index}`, index ? `level-${index - 1}` : null),
  )
  expect(
    folderMoveError(
      [...folders, ...chain],
      'root',
      `level-${LIMITS.folderDepthMax - 1}`,
    ),
  ).toBe('depth')
  const note = {
    id: 'n',
    title: '',
    excerpt: '',
    folderId: 'child',
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 0,
    updatedAt: 0,
    deletedAt: null,
  }
  const counts = selectNavigation({
    n: note,
    archived: { ...note, id: 'archived', isArchived: true },
    trash: { ...note, id: 'trash', deletedAt: 1 },
  })
  const tree = buildFolderTree(folders, counts.folderCounts)
  expect(tree.find((item) => item.id === 'root')?.totalNotes).toBe(1)
  expect(counts.counts).toEqual({
    all: 1,
    starred: 0,
    unfiled: 0,
    archived: 1,
    trash: 1,
  })
})

test('native drop targets support nesting, sibling order and promotion without allowing descendant cycles', () => {
  const root = folder('root', null),
    child = folder('child', 'root'),
    first = folder('first', null),
    last = folder('last', null)
  const roots = [first, root, last]
  expect(folderDropTarget(root, roots, 'inside')).toEqual({
    parentId: 'root',
    beforeId: null,
  })
  expect(folderDropTarget(root, roots, 'before')).toEqual({
    parentId: null,
    beforeId: 'root',
  })
  expect(folderDropTarget(root, roots, 'after')).toEqual({
    parentId: null,
    beforeId: 'last',
  })
  expect(folderDropTarget(last, roots, 'after')).toEqual({
    parentId: null,
    beforeId: null,
  })
  expect(folderDropTarget(null, roots, 'inside')).toEqual({
    parentId: null,
    beforeId: null,
  })
  for (const position of ['inside', 'before', 'after'] as const) {
    const target = folderDropTarget(child, [child], position)
    expect(folderMoveError([...roots, child], root.id, target.parentId)).toBe(
      'cycle',
    )
  }
})
