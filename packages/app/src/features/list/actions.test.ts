import { expect, test } from 'vitest'
import type { NoteSummary } from '@shared/types'
import { appendPage, runNoteBatch } from './actions'
import { AppError, errorMessageKey } from '@app/i18n/errors'
import { BackendError } from '@app/backend'
import { selectVisibleNotes } from '@app/state/selectors'

const note = (id: string): NoteSummary => ({ id, title: id, excerpt: '', folderId: null, tags: [], isPinned: false, isStarred: false, isArchived: false, wordCount: 0, charCount: 0, rev: 1, position: 0, createdAt: 1, updatedAt: 1, deletedAt: null })

test('cursor append deduplicates while batch cancellation and unsafe flush never mutate', async () => {
  const first = appendPage([], { notes: [note('a'), note('b')], nextCursor: 'page-2', total: 3 }, null)
  expect(appendPage(first, { notes: [note('b'), note('c')], nextCursor: null, total: 3 }, 'page-2').map((item) => item.id)).toEqual(['a', 'b', 'c'])
  expect(() => appendPage(first, { notes: [], nextCursor: 'page-2', total: 3 }, 'page-2')).toThrow('advance')
  const calls: string[] = []
  expect(await runNoteBatch(['a'], async () => false, async () => { calls.push('flush'); return { pending: 0, failed: 0 } }, async () => { calls.push('mutate') }, 'common.changes_not_saved')).toEqual([])
  expect(calls).toEqual([])
  const results = await runNoteBatch(['a', 'b', 'c', 'c'], async () => true, async (id) => { calls.push(`flush:${id}`); return { pending: id === 'a' ? 1 : 0, failed: 0 } }, async (id) => { calls.push(`mutate:${id}`); if (id === 'b') throw new Error('conflict') }, 'common.changes_not_saved')
  expect(results.map((result) => [result.id, result.error === null])).toEqual([['a', false], ['b', false], ['c', true]])
  expect(results.find((result) => result.id === 'a')?.error).toEqual(new AppError('common.changes_not_saved'))
  expect(calls).toEqual(['flush:a', 'flush:b', 'mutate:b', 'flush:c', 'mutate:c'])
})

test('equal timestamps retain deterministic ID order across deduplicated pages and filtering', () => {
  const page = appendPage([note('c'), note('a')], { notes: [note('a'), note('b')], nextCursor: null, total: 3 }, 'page-2')
  const summaries = Object.fromEntries(page.map((item) => [item.id, item]))
  const query = { view: 'all', folderId: null, tag: null, sort: 'updated', order: 'desc', locale: 'en-US' } as const
  expect(selectVisibleNotes(summaries, [], query).map((item) => item.id)).toEqual(['a', 'b', 'c'])
  expect(selectVisibleNotes(summaries, [], { ...query, view: 'recent' }).map((item) => item.id)).toEqual(['a', 'b', 'c'])
})

test('failed local persistence is reported per entity by message key', async () => {
  const changed: string[] = []
  const results = await runNoteBatch(['unsafe', 'safe'], async () => true, async (id) => ({ pending: 0, failed: id === 'unsafe' ? 1 : 0 }), async (id) => { changed.push(id) }, 'common.changes_not_saved')
  expect(changed).toEqual(['safe'])
  expect(results.map((result) => [result.id, result.error === null ? null : errorMessageKey(result.error)])).toEqual([['unsafe', 'common.changes_not_saved'], ['safe', null]])
})

test('user-facing error text never leaks a program error message', () => {
  expect(errorMessageKey(new BackendError('not_found', 404, 'raw server text'))).toBe('api.error.not_found')
  expect(errorMessageKey(new AppError('notes.this_note_no_longer_exists'))).toBe('notes.this_note_no_longer_exists')
  expect(errorMessageKey(new TypeError('Cannot read properties of undefined'))).toBe('common.action_failed')
  expect(errorMessageKey('thrown string')).toBe('common.action_failed')
})
