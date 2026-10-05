import { expect, test } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { appendPage, runNoteBatch } from './actions'
import { selectVisibleNotes } from '@app/state/selectors'

const note = (id: string): NoteSummary => ({ id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null })

test('cursor append deduplicates while batch cancellation and unsafe flush never mutate', async () => {
  const first = appendPage([], { notes: [note('a'), note('b')], nextCursor: 'page-2', total: 3 }, null)
  expect(appendPage(first, { notes: [note('b'), note('c')], nextCursor: null, total: 3 }, 'page-2').map((item) => item.id)).toEqual(['a', 'b', 'c'])
  expect(() => appendPage(first, { notes: [], nextCursor: 'page-2', total: 3 }, 'page-2')).toThrow('advance')
  const calls: string[] = []
  expect(await runNoteBatch(['a'], async () => false, async () => { calls.push('flush'); return { pending: 0, failed: 0 } }, async () => { calls.push('mutate') }, 'unsafe flush')).toEqual([])
  expect(calls).toEqual([])
  const results = await runNoteBatch(['a', 'b', 'c', 'c'], async () => true, async (id) => { calls.push(`flush:${id}`); return { pending: id === 'a' ? 1 : 0, failed: 0 } }, async (id) => { calls.push(`mutate:${id}`); if (id === 'b') throw new Error('conflict') }, 'unsafe flush')
  expect(results.map((result) => [result.id, result.error === null])).toEqual([['a', false], ['b', false], ['c', true]])
  expect(results.find((result) => result.id === 'a')?.error).toEqual(new Error('unsafe flush'))
  expect(calls).toEqual(['flush:a', 'flush:b', 'mutate:b', 'flush:c', 'mutate:c'])
})

test('equal timestamps retain deterministic ID order across deduplicated pages and filtering', () => {
  const page = appendPage([note('c'), note('a')], { notes: [note('a'), note('b')], nextCursor: null, total: 3 }, 'page-2')
  const summaries = Object.fromEntries(page.map((item) => [item.id, item]))
  const query = { view: 'all', folderId: null, tag: null, sort: 'updated', order: 'desc', locale: 'en-US' } as const
  expect(selectVisibleNotes(summaries, [], query).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  expect(selectVisibleNotes(summaries, [], { ...query, view: 'recent' }).map((item) => item.id)).toEqual(['a', 'b', 'c'])
})

test('failed local persistence is reported per entity with a localized message', async () => {
  const changed: string[] = []
  const results = await runNoteBatch(['unsafe', 'safe'], async () => true, async (id) => ({ pending: 0, failed: id === 'unsafe' ? 1 : 0 }), async (id) => { changed.push(id) }, '正文尚未安全保存')
  expect(changed).toEqual(['safe'])
  expect(results.map((result) => [result.id, result.error instanceof Error ? result.error.message : result.error])).toEqual([['unsafe', '正文尚未安全保存'], ['safe', null]])
})
