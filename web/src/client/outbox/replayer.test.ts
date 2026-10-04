import { describe, expect, it } from 'vitest'
import { BackendError } from '@app/backend/errors'
import type { Note } from '@shared/types'
import { createLocalDb } from '../local/local-db'
import { MemoryKvStore } from '../local/kv-store'
import { createMemoryTabBusChannel, MemoryTabBus } from '../backend/tab-bus'
import { HttpNotesTextWriter } from '../backend/ports/notes'
import { LocalOutboxStore } from './outbox-store'
import { LeaseReplayLock, type ReplayLock } from './replay-lock'
import { OutboxReplayer } from './replayer'
import type { RequestSpec } from '../backend/transport'

const note: Note = {
  id: 'note',
  title: 'title',
  content: 'remote',
  rev: 1,
  excerpt: '',
  folderId: null,
  tags: [],
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 0,
  charCount: 0,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}
const clock = { now: () => Date.now() }
const logger = { debug() {}, info() {}, warn() {}, error() {} }

async function setup(
  handler: (method: string, path: string, body: Record<string, unknown>, signal?: AbortSignal) => Promise<Note>,
  lock?: ReplayLock,
) {
  const kv = new MemoryKvStore()
  const db = createLocalDb({ kv })
  await db.bindUser('user')
  const busChannel = createMemoryTabBusChannel()
  const busA = new MemoryTabBus('user', busChannel)
  const busB = new MemoryTabBus('user', busChannel)
  const eventsA: unknown[] = []
  const eventsB: unknown[] = []
  const transport = {
    json: async <T>(spec: RequestSpec): Promise<T> =>
      handler(spec.method ?? 'GET', spec.path, (spec.body ?? {}) as Record<string, unknown>, spec.signal) as Promise<T>,
  }
  const writerA = new HttpNotesTextWriter({
    transport,
    localDb: db,
    clientId: 'A',
    onWriteEvent: (event) => eventsA.push(event),
  })
  const writerB = new HttpNotesTextWriter({
    transport,
    localDb: db,
    clientId: 'B',
    onWriteEvent: (event) => eventsB.push(event),
  })
  const replayLock = lock ?? new LeaseReplayLock(kv, db, clock)
  const makeReplayer = (writer: HttpNotesTextWriter, bus: MemoryTabBus, clientId: string) =>
    new OutboxReplayer({
      outbox: new LocalOutboxStore(db),
      lock: replayLock,
      transport,
      bus,
      pending: writer,
      content: db,
      clock,
      logger,
      clientId,
      emitChange: (event) => {
        if (event.kind === 'write') (clientId === 'A' ? eventsA : eventsB).push(event.payload)
      },
      requestPull() {},
    })
  const replayerA = makeReplayer(writerA, busA, 'A')
  const replayerB = makeReplayer(writerB, busB, 'B')
  const unsubscribeA = replayerA.consumeBus()
  const unsubscribeB = replayerB.consumeBus()
  return {
    db,
    kv,
    busA,
    busB,
    writerA,
    writerB,
    replayerA,
    replayerB,
    eventsA,
    eventsB,
    close: () => {
      unsubscribeA()
      unsubscribeB()
      busA.close()
      busB.close()
    },
  }
}

describe('outbox replay', () => {
  it('serializes two tabs and leaves the later write intact after a late ACK', async () => {
    const gate = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const sent: string[] = []
    const ctx = await setup(async (method, _path, body) => {
      if (method === 'PATCH') {
        sent.push(body.content as string)
        if (body.content === 'first') {
          entered.resolve()
          await gate.promise
        }
        return { ...note, content: body.content as string, rev: (body.rev as number) + 1 }
      }
      return note
    })
    try {
      await ctx.writerA.patch('note', { rev: 1, content: 'first' }, { writeId: 'w1' })
      const first = ctx.replayerB.replay()
      await entered.promise
      await ctx.writerA.patch('note', { rev: 1, content: 'second' }, { writeId: 'w2' })
      const second = ctx.replayerA.replay()
      expect(await ctx.db.getOutbox()).toMatchObject([{ writeId: 'w2', payload: { content: 'second' } }])
      gate.resolve()
      await Promise.all([first, second])
      expect(sent).toEqual(['first', 'second'])
      expect(await ctx.db.getOutbox()).toEqual([])
      expect(ctx.eventsA).not.toContainEqual(expect.objectContaining({ kind: 'settled', writeId: 'w1' }))
      expect(ctx.eventsA).toContainEqual(expect.objectContaining({ kind: 'settled', writeId: 'w2' }))
    } finally {
      gate.resolve()
      ctx.close()
    }
  })

  it('keeps both server version and offline edit on an unconfirmed 409', async () => {
    const sent: Record<string, unknown>[] = []
    const ctx = await setup(async (method, _path, body) => {
      if (method !== 'PATCH') return note
      sent.push(body)
      if (body.rev === 1)
        throw new BackendError('conflict', 409, 'conflict', { server: { ...note, rev: 2, content: 'remote v2' } })
      return { ...note, rev: 3, content: body.content as string }
    })
    try {
      await ctx.writerA.patch('note', { rev: 1, content: 'local v2' }, { writeId: 'w' })
      await ctx.replayerB.replay()
      expect(sent).toEqual([
        { rev: 1, content: 'local v2' },
        { rev: 2, content: 'local v2', preserveVersion: true },
      ])
      expect(await ctx.db.getOutbox()).toEqual([])
      expect(ctx.eventsA).toContainEqual(expect.objectContaining({ kind: 'settled', writeId: 'w' }))
    } finally {
      ctx.close()
    }
  })

  it('persists recovery ID before POST and retries the same ID after interrupted completion', async () => {
    const ids: string[] = []
    const ctx = await setup(async (method, _path, body) => {
      if (method === 'PATCH') throw new BackendError('not_found', 404, 'deleted')
      if (method !== 'POST') return note
      ids.push(body.id as string)
      const journal = await ctx.db.getOutbox()
      expect(journal[0]?.payload.recoveryId).toBe(body.id)
      return { ...note, id: body.id as string, title: body.title as string, content: body.content as string }
    })
    try {
      await ctx.writerA.patch('note', { rev: 1, content: 'survives' }, { writeId: 'w' })
      const store = new LocalOutboxStore(ctx.db)
      const failing = {
        list: () => store.list(),
        complete: async () => {
          throw new Error('disk unavailable')
        },
        enqueue: (item: Parameters<typeof store.enqueue>[0]) => store.enqueue(item),
        updateRevision: (id: string, writeId: string, rev: number, preserve?: boolean) =>
          store.updateRevision(id, writeId, rev, preserve),
        setRecoveryId: (id: string, writeId: string, recoveryId: string) =>
          store.setRecoveryId(id, writeId, recoveryId),
        advanceDependents: (id: string, writeId: string, rev: number, next: number) =>
          store.advanceDependents(id, writeId, rev, next),
        markFailure: (id: string, writeId: string, message: string) => store.markFailure(id, writeId, message),
      }
      const replay = new OutboxReplayer({
        outbox: failing,
        lock: new LeaseReplayLock(ctx.kv, ctx.db, clock),
        transport: {
          json: async <T>(spec: { method?: string; path: string; body?: unknown }): Promise<T> => {
            if (spec.method === 'PATCH') throw new BackendError('not_found', 404, 'deleted')
            if (spec.method !== 'POST') return note as T
            const body = spec.body as { id: string; content: string; title: string }
            ids.push(body.id)
            expect((await ctx.db.getOutbox())[0]?.payload.recoveryId).toBe(body.id)
            return { ...note, id: body.id, content: body.content, title: body.title } as T
          },
        },
        bus: ctx.busB,
        pending: ctx.writerB,
        content: ctx.db,
        clock,
        logger,
        clientId: 'B',
        emitChange() {},
        requestPull() {},
      })
      await replay.replay()
      expect((await ctx.db.getOutbox())[0]?.payload.recoveryId).toBe(ids[0])
      await ctx.replayerB.replay()
      expect(ids).toEqual([ids[0], ids[0]])
      expect(await ctx.db.getOutbox()).toEqual([])
    } finally {
      ctx.close()
    }
  })

  it('retains the journal when a lease expires during an in-flight PATCH', async () => {
    const response = Promise.withResolvers<Note>()
    const entered = Promise.withResolvers<void>()
    let leaseValid = true
    const lock: ReplayLock = {
      run: async (_owner, task) => {
        await task(async () => leaseValid)
        return true
      },
    }
    const ctx = await setup(async (method) => {
      if (method !== 'PATCH') return note
      entered.resolve()
      return response.promise
    }, lock)
    try {
      await ctx.writerA.patch('note', { rev: 1, content: 'local text' }, { writeId: 'w' })
      const pending = ctx.replayerA.replay()
      await entered.promise
      leaseValid = false
      response.resolve({ ...note, content: 'local text', rev: 2 })
      await pending
      expect((await ctx.db.getOutbox()).map(({ writeId }) => writeId)).toEqual(['w'])
      expect(ctx.eventsA).not.toContainEqual(expect.objectContaining({ kind: 'settled', writeId: 'w' }))
    } finally {
      response.resolve(note)
      ctx.close()
    }
  })

  it.each(['switch', 'dispose'])(
    'retains both accounts journals after %s during an in-flight PATCH',
    async (action) => {
      const response = Promise.withResolvers<Note>()
      const entered = Promise.withResolvers<void>()
      let signal: AbortSignal | undefined
      let sends = 0
      const ctx = await setup(async (method, _path, _body, requestSignal) => {
        if (method !== 'PATCH') return note
        sends++
        signal = requestSignal
        entered.resolve()
        return response.promise
      })
      try {
        await ctx.writerA.patch('note', { rev: 1, content: 'old account text' }, { writeId: 'old' })
        const pending = ctx.replayerA.replay()
        await entered.promise
        await ctx.db.bindUser('other')
        await ctx.writerA.patch('note', { rev: 1, content: 'new account text' }, { writeId: 'new' })
        if (action === 'dispose') ctx.replayerA.dispose()
        response.resolve({ ...note, rev: 2, content: 'old account text' })
        await pending
        expect(signal?.aborted).toBe(action === 'dispose')
        expect(await ctx.db.getOutbox()).toMatchObject([
          { writeId: 'new', payload: { rev: 1, content: 'new account text' } },
        ])
        await ctx.db.bindUser('user')
        expect(await ctx.db.getOutbox()).toMatchObject([
          { writeId: 'old', payload: { rev: 1, content: 'old account text' } },
        ])
        expect(ctx.eventsA).not.toContainEqual(expect.objectContaining({ kind: 'settled' }))
        if (action === 'dispose') {
          await ctx.replayerA.replay()
          expect(sends).toBe(1)
        }
      } finally {
        response.resolve(note)
        ctx.replayerA.dispose()
        ctx.close()
      }
    },
  )

  it('retains an offline write and refuses to send after losing a lease', async () => {
    const sent: string[] = []
    const ctx = await setup(async (method, _path, body) => {
      if (method !== 'PATCH') return note
      sent.push(body.content as string)
      throw new BackendError('offline', 0, 'disconnected')
    })
    try {
      await ctx.writerA.patch('note', { rev: 1, content: 'retain' }, { writeId: 'w' })
      await ctx.replayerB.replay()
      expect(sent).toEqual(['retain'])
      expect((await ctx.db.getOutbox())[0]?.writeId).toBe('w')
      expect(ctx.eventsB).toContainEqual(expect.objectContaining({ kind: 'failed', code: 'offline', retained: true }))
      const noLock = new OutboxReplayer({
        outbox: new LocalOutboxStore(ctx.db),
        lock: {
          run: async (_owner, task) => {
            await task(async () => false)
            return true
          },
        },
        transport: {
          json: async <T>(): Promise<T> => {
            throw new Error('sent despite lost lock')
          },
        },
        bus: ctx.busB,
        pending: ctx.writerB,
        content: ctx.db,
        clock,
        logger,
        clientId: 'B',
        emitChange() {},
        requestPull() {},
      })
      await noLock.replay()
      expect((await ctx.db.getOutbox())[0]?.writeId).toBe('w')
    } finally {
      ctx.close()
    }
  })
})
