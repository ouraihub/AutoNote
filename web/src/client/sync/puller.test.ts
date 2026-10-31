import { describe, expect, it } from 'vitest'
import { SyncPuller } from './puller'
import { createLocalDb, MemoryKvStore } from '../local'
import type { SyncResponse } from '@shared/types'
import type { RequestSpec } from '../backend/transport'

const page: SyncResponse = {
  cursor: 4,
  full: true,
  hasMore: false,
  nextKey: null,
  facetsFull: true,
  notes: [],
  folders: [],
  tags: [],
  deletions: [],
  settingsChanged: false,
  serverTime: 1,
}

describe('SyncPuller checkpoint', () => {
  it('keeps the old checkpoint on failed catch-up, then publishes complete pages with initial facets', async () => {
    const kv = new MemoryKvStore()
    const db = createLocalDb({ kv })
    await db.bindUser('user')
    await db.saveShell({ notes: [], folders: [], tags: [], cursor: 1 })
    const tag = { id: 'tag', name: 'one', color: null, count: 0, createdAt: 1 }
    let fail = true
    const queries: RequestSpec['query'][] = []
    const events: unknown[] = []
    const puller = new SyncPuller({
      localDb: db,
      emitChange: (event) => events.push(event),
      transport: {
        json: async <T>(spec: RequestSpec): Promise<T> => {
          queries.push(spec.query)
          if (spec.query?.since === 4) {
            if (fail) throw new Error('connection lost')
            return { ...page, full: false, facetsFull: false } as T
          }
          return spec.query?.after
            ? (page as T)
            : ({ ...page, tags: [tag], hasMore: true, nextKey: 'next' } as T)
        },
      },
    })
    await expect(puller.pull(true)).rejects.toThrow('connection lost')
    expect((await db.loadShell())?.cursor).toBe(1)
    expect(events).toEqual([])
    fail = false
    expect(await puller.pull(true)).toMatchObject({
      full: true,
      hasMore: false,
      cursor: 4,
      tags: [tag],
    })
    expect(queries).toContainEqual({ since: 0, after: 'next', snapshot: 4 })
    expect((await db.loadShell())?.tags).toEqual([tag])
  })

  it('preserves a force request arriving during an incremental pull and rejects non-advancing cursors', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    await db.bindUser('user')
    await db.saveShell({ notes: [], folders: [], tags: [], cursor: 4 })
    const { promise: gate, resolve: release } = Promise.withResolvers<void>()
    const since: unknown[] = []
    const puller = new SyncPuller({
      localDb: db,
      emitChange() {},
      transport: {
        json: async <T>(spec: RequestSpec): Promise<T> => {
          since.push(spec.query?.since)
          if (since.length === 1) await gate
          return { ...page, full: spec.query?.since === 0 } as T
        },
      },
    })
    const ordinary = puller.pull()
    const forced = puller.pull(true)
    release()
    await Promise.all([ordinary, forced])
    expect(since).toEqual([4, 0, 4])
    const bad = new SyncPuller({
      localDb: db,
      emitChange() {},
      transport: {
        json: async <T>(): Promise<T> =>
          ({ ...page, full: false, hasMore: true }) as T,
      },
    })
    await expect(bad.pull()).rejects.toMatchObject({ code: 'invalid_response' })
    expect((await db.loadShell())?.cursor).toBe(4)
    puller.dispose()
    await expect(puller.snapshot()).rejects.toMatchObject({ code: 'cancelled' })
    await expect(puller.pull()).rejects.toMatchObject({ code: 'cancelled' })
  })
})
