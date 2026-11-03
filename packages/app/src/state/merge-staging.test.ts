import { describe, expect, test } from 'vitest'
import { consolidateFullSync, nextFullSyncPage } from './merge'
import {
  expectInvalidResponse,
  folder,
  note,
  payload,
  tag,
} from './merge-test-fixtures'
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
  const last = payload({
    cursor: 8,
    full: true,
    facetsFull: true,
    notes: [note('c')],
    serverTime: 9,
  })

  test('requests the next page with a fixed snapshot cursor', () => {
    expect(nextFullSyncPage([first])).toEqual({ after: 'b', snapshot: 8 })
    expect(nextFullSyncPage([first, last])).toBeNull()
  })

  test('keeps first-page facets when later\
 pages carry empty folders and tags', () => {
    const consolidated = consolidateFullSync([first, last], [])

    expect(consolidated.notes.map((item) => item.id)).toEqual(['a', 'b', 'c'])
    expect(consolidated.folders.map((item) => item.id)).toEqual(['f'])
    expect(consolidated.tags.map((item) => item.id)).toEqual(['t'])
    expect(consolidated).toMatchObject({
      full: true,
      hasMore: false,
      nextKey: null,
      cursor: 8,
      serverTime: 9,
    })
  })

  test('applies catch-up increments in order, i\
ncluding deletions and facet replacement', () => {
    const consolidated = consolidateFullSync(
      [first, last],
      [
        payload({
          cursor: 9,
          notes: [note('d')],
          deletions: [{ entity: 'note', id: 'a' }],
          settingsChanged: true,
        }),
        payload({
          cursor: 10,
          facetsFull: true,
          folders: [folder('g')],
          tags: [],
          serverTime: 12,
        }),
      ],
    )

    expect(consolidated.notes.map((item) => item.id).sort()).toEqual([
      'b',
      'c',
      'd',
    ])
    expect(consolidated.folders.map((item) => item.id)).toEqual(['g'])
    expect(consolidated.tags).toEqual([])
    expect(consolidated).toMatchObject({
      cursor: 10,
      serverTime: 12,
      settingsChanged: true,
    })
  })

  test('rejects an unfinished, expired or repeating page chain', () => {
    expectInvalidResponse(() => consolidateFullSync([first], []))
    expectInvalidResponse(() =>
      consolidateFullSync([first, { ...last, cursor: 9 }], []),
    )
    expectInvalidResponse(() =>
      nextFullSyncPage([first, { ...last, hasMore: true, nextKey: 'b' }]),
    )
    expectInvalidResponse(() => nextFullSyncPage([{ ...first, nextKey: null }]))
    expectInvalidResponse(() => consolidateFullSync([], []))
  })

  test('rejects catch-up increments tha\
t go backwards or switch to full', () => {
    expectInvalidResponse(() =>
      consolidateFullSync([first, last], [payload({ cursor: 7 })]),
    )
    expectInvalidResponse(() =>
      consolidateFullSync([first, last], [payload({ cursor: 9, full: true })]),
    )
  })
})
