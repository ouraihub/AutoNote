// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { IpcChangeFeed } from './change-feed'
import type { IpcTransport } from './transport'
import type { SyncResponse } from '@shared/types'

const payload = (cursor: number, hasMore = false): SyncResponse => ({
  notes: [],
  folders: [],
  tags: [],
  deletions: [],
  cursor,
  full: false,
  facetsFull: true,
  hasMore,
  nextKey: null,
  settingsChanged: false,
  profileChanged: false,
  siteChanged: false,
  serverTime: 1,
})

test('snapshot is installed before concurrent notification reconciliation and late listeners are released', async () => {
  let notify: (() => void) | undefined
  let cursor = 1
  const events: number[] = []
  let released = 0
  const transport = {
    async listenLibrary(listener: () => void) {
      notify = listener
      return () => {
        released++
      }
    },
    async invoke() {
      const snapshot = payload(cursor)
      cursor++
      notify?.()
      return snapshot
    },
    async changesSince() {
      return payload(cursor)
    },
  } as unknown as IpcTransport
  const feed = new IpcChangeFeed(transport)
  feed.subscribe((event) => {
    if (event.kind === 'library') events.push(event.payload.cursor)
  })
  const snapshot = await feed.snapshot()
  expect(snapshot.cursor).toBe(1)
  expect(events).toEqual([])
  await feed.reconcile()
  expect(events).toEqual([2])
  feed.dispose()
  expect(released).toBe(1)

  const delayed = Promise.withResolvers<() => void>()
  const late = new IpcChangeFeed({ listenLibrary: () => delayed.promise } as unknown as IpcTransport)
  const start = late.start()
  late.dispose()
  delayed.resolve(() => {
    released++
  })
  await expect(start).rejects.toMatchObject({ code: 'cancelled' })
  expect(released).toBe(2)
})

test('incremental pagination rejects a non-advancing cursor instead of looping', async () => {
  const feed = new IpcChangeFeed({
    async listenLibrary() {
      return () => undefined
    },
    async invoke() {
      return payload(1)
    },
    async changesSince() {
      return payload(1, true)
    },
  } as unknown as IpcTransport)
  await feed.snapshot()
  await expect(feed.reconcile()).rejects.toMatchObject({ code: 'invalid_response' })
  feed.dispose()
})
