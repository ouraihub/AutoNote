import { describe, expect, it } from 'vitest'
import { BackendError } from '@app/backend/errors'
import { MemoryKvStore } from '../../local/kv-store'
import { createLocalDb } from '../../local/local-db'
import type { LocalDb } from '../../local/types'
import { HttpNotesTextWriter } from './notes'
function transport() {
  return {
    json: async <T>(): Promise<T> => {
      throw new BackendError('offline', 0, 'Network unavailable')
    },
  }
}

async function writer(db: LocalDb, clientId = 'client') {
  await db.bindUser('user')
  return new HttpNotesTextWriter({ transport: transport(), localDb: db, clientId })
}

const remote = {
  id: 'note',
  title: 'Server title',
  excerpt: 'not the body',
  content: 'Server body',
  folderId: null,
  tags: [],
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 2,
  charCount: 11,
  rev: 1,
  position: 0,
  createdAt: 1,
  updatedAt: 1,
  deletedAt: null,
}

async function shell(db: LocalDb) {
  await db.saveShell({ notes: [{ ...remote }], folders: [], tags: [], cursor: 1 })
}

describe('HttpNotesTextWriter', () => {
  it('persists each writeId in one slot and preserves the latest body', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const notes = await writer(db)
    const first = notes.patch('note', { rev: 1, content: 'first' }, { writeId: 'w1' })
    const second = notes.patch('note', { rev: 1, content: 'second' }, { writeId: 'w2' })
    await Promise.all([first, second])
    await expect(db.getOutbox()).resolves.toMatchObject([
      { id: 'patch:client:note', writeId: 'w2', payload: { content: 'second', contentDirty: true } },
    ])
  })

  it('queues title-only edits without inventing正文', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const notes = await writer(db)
    await notes.patch('note', { rev: 1, title: '' }, { writeId: 'title' })
    await expect(db.getOutbox()).resolves.toMatchObject([{ payload: { content: '', contentDirty: false, title: '' } }])
    await expect(db.getContent('note')).resolves.toBeUndefined()
  })

  it('returns queued after the authoritative log even when cache write fails', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    await db.bindUser('user')
    const failingDb = new Proxy(db, {
      get(target, key) {
        if (key === 'setContent')
          return async () => {
            throw new Error('cache unavailable')
          }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const notes = new HttpNotesTextWriter({ transport: transport(), localDb: failingDb, clientId: 'client' })
    await expect(notes.patch('note', { rev: 1, content: 'safe' }, { writeId: 'w1' })).resolves.toMatchObject({
      queued: true,
      writeId: 'w1',
    })
    await expect(db.getOutbox()).resolves.toHaveLength(1)
  })

  it('restores text and title after restart while offline; never uses an excerpt as body', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const original = await writer(db)
    await shell(db)
    await original.patch('note', { rev: 1, content: 'offline body', title: 'Offline title' }, { writeId: 'edit' })
    const reopened = await writer(db, 'another-tab')
    await expect(reopened.get('note')).resolves.toMatchObject({ content: 'offline body', title: 'Offline title' })
    await db.completeOutboxItem('patch:client:note', 'edit')
    await db.dropContent('note')
    await expect(reopened.get('note')).rejects.toMatchObject({ code: 'offline' })
  })

  it('does not synthesize missing summary metadata while offline', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const notes = await writer(db)
    await notes.patch('note', { rev: 1, content: 'journal body' }, { writeId: 'body' })
    await expect(notes.get('note')).rejects.toMatchObject({ code: 'offline' })
  })

  it('overlays two tabs without discarding an older dirty body or overwriting remote body with title-only edits', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const first = await writer(db, 'first')
    const second = await writer(db, 'second')
    const getRemote = { json: async <T>() => remote as T }
    const reader = new HttpNotesTextWriter({ transport: getRemote, localDb: db, clientId: 'reader' })
    await first.patch('note', { rev: 1, content: 'body from tab one' }, { writeId: 'one' })
    await second.patch('note', { rev: 1, title: 'title from tab two' }, { writeId: 'two' })
    await expect(reader.get('note')).resolves.toMatchObject({
      content: 'body from tab one',
      title: 'title from tab two',
    })
    await db.completeOutboxItem('patch:first:note', 'one')
    await db.dropContent('note')
    await expect(reader.get('note')).resolves.toMatchObject({ content: 'Server body', title: 'title from tab two' })
    expect((await db.getOutbox())[0]?.payload).toMatchObject({ contentDirty: false, title: 'title from tab two' })
  })

  it('recovers each tab’s distinct title and body journal entries offline', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    await db.bindUser('user')
    await shell(db)
    await (await writer(db, 'first')).patch('note', { rev: 1, content: 'text from tab one' }, { writeId: 'body' })
    await (await writer(db, 'second')).patch('note', { rev: 1, title: 'title from tab two' }, { writeId: 'title' })
    await db.dropContent('note')
    await expect((await writer(db, 'restarted')).get('note')).resolves.toMatchObject({
      content: 'text from tab one',
      title: 'title from tab two',
    })
    await expect((await writer(db, 'restarted')).flush()).resolves.toEqual({ pending: 1, failed: 0 })
  })

  it('keeps the journal body when a restarted tab changes only the title', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const first = await writer(db)
    await first.patch('note', { rev: 1, content: 'saved locally' }, { writeId: 'body' })
    await db.dropContent('note')
    const second = await writer(db)
    await second.patch('note', { rev: 1, title: 'renamed' }, { writeId: 'title' })
    expect((await db.getOutbox())[0]).toMatchObject({
      writeId: 'title',
      payload: {
        content: 'saved locally',
        contentDirty: true,
        title: 'renamed',
      },
    })
  })

  it('reads title-only edits offline after a successful baseline GET', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    await db.bindUser('user')
    await shell(db)
    const online = new HttpNotesTextWriter({
      transport: { json: async <T>() => remote as T },
      localDb: db,
      clientId: 'client',
    })
    await online.patch('note', { rev: 1, title: 'renamed' }, { writeId: 'title' })
    await expect(online.get('note')).resolves.toMatchObject({ content: 'Server body', title: 'renamed' })
    await expect((await writer(db, 'restarted')).get('note')).resolves.toMatchObject({
      content: 'Server body',
      title: 'renamed',
    })
  })

  it('keeps the newer write if an older writeId completes and counts scoped durable failures', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const notes = await writer(db)
    await notes.patch('note', { rev: 1, content: 'first' }, { writeId: 'one' })
    await notes.patch('note', { rev: 1, content: 'second' }, { writeId: 'two' })
    await db.completeOutboxItem('patch:client:note', 'one')
    await db.markOutboxFailure('patch:client:note', 'two', 'failed to replay')
    await expect(notes.flush('note')).resolves.toEqual({ pending: 1, failed: 1 })
    await expect(notes.flush('other')).resolves.toEqual({ pending: 0, failed: 0 })
    expect((await db.getOutbox())[0]?.writeId).toBe('two')
  })

  it('flush waits for local enrollment and calls an injected replay trigger without claiming remote success', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    await db.bindUser('user')
    const calls: Array<string | undefined> = []
    const notes = new HttpNotesTextWriter({
      transport: transport(),
      localDb: db,
      clientId: 'client',
      replay: async (id) => {
        calls.push(id)
      },
    })
    const enrollment = notes.patch('note', { rev: 1, content: 'durable' }, { writeId: 'first' })
    await expect(notes.flush('note')).resolves.toEqual({ pending: 1, failed: 0 })
    await enrollment
    expect(calls).toEqual(['note'])
    expect((await db.getOutbox())[0]?.payload.content).toBe('durable')
  })

  it('rejects bad journals and failed quota writes instead of reporting an empty or saved queue', async () => {
    const kv = new MemoryKvStore()
    const db = createLocalDb({ kv })
    const notes = await writer(db)
    await kv.set('user:user:outbox', [{ id: 'invalid', payload: null }])
    await expect(notes.flush()).rejects.toMatchObject({ code: 'internal' })
    await expect(notes.get('note')).rejects.toMatchObject({ code: 'internal' })
    await expect(notes.patch('note', { rev: 1, content: 'not saved' }, { writeId: 'bad' })).rejects.toMatchObject({
      code: 'internal',
    })
    await kv.del('user:user:outbox')
    const quotaKv = new Proxy(kv, {
      get(target, key) {
        if (key === 'update')
          return async () => {
            throw new DOMException('Disk full', 'QuotaExceededError')
          }
        const value: unknown = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const quotaDb = createLocalDb({ kv: quotaKv })
    await quotaDb.bindUser('user')
    const quotaWriter = new HttpNotesTextWriter({ transport: transport(), localDb: quotaDb, clientId: 'client' })
    await expect(
      quotaWriter.patch('note', { rev: 1, content: 'not saved' }, { writeId: 'quota' }),
    ).rejects.toMatchObject({ code: 'internal' })
    await expect(quotaWriter.flush('note')).resolves.toEqual({ pending: 1, failed: 1 })
  })

  it('rejects a previous account GET instead of caching its private body in the new account', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    await db.bindUser('old')
    const response = Promise.withResolvers<typeof remote>()
    const started = Promise.withResolvers<void>()
    const notes = new HttpNotesTextWriter({
      transport: {
        json: async <T>() => {
          started.resolve()
          return (await response.promise) as T
        },
      },
      localDb: db,
      clientId: 'tab',
    })
    const read = notes.get('note')
    await started.promise
    await db.bindUser('new')
    response.resolve(remote)
    await expect(read).rejects.toMatchObject({ code: 'cancelled' })
    expect(await db.getContent('note')).toBeUndefined()
  })
})

it('refuses local disposal after a failed journal and allows it after the edit is persisted', async () => {
  const kv = new MemoryKvStore()
  const db = createLocalDb({ kv })
  const notes = await writer(db)
  const update = kv.update.bind(kv)
  kv.update = async () => {
    throw new Error('quota')
  }
  await expect(notes.patch('note', { rev: 1, content: 'retain' }, { writeId: 'failed' })).rejects.toMatchObject({
    code: 'internal',
  })
  await expect(notes.waitForLocalCommit()).rejects.toMatchObject({ code: 'internal' })
  kv.update = update
  await notes.patch('note', { rev: 1, content: 'retain' }, { writeId: 'persisted' })
  await notes.waitForLocalCommit()
  expect(await db.getOutbox()).toMatchObject([{ writeId: 'persisted', payload: { content: 'retain' } }])
})
