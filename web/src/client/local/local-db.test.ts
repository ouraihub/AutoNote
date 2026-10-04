import { describe, expect, it } from 'vitest'
import { BackendError } from '@app/backend'
import { MemoryKvStore, type KvEntry, type KvStore } from './kv-store'
import { createLocalDb } from './local-db'
import type { OutboxItem, ShellData } from './types'

const shell: ShellData = { notes: [], folders: [], tags: [], cursor: 4 }

const outboxItem = (writeId = 'w-1'): OutboxItem => ({
  id: 'patch:client:note-1',
  clientId: 'client',
  writeId,
  noteId: 'note-1',
  payload: {
    rev: 1,
    content: 'offline text',
    contentDirty: true,
    title: 'Offline',
    futureField: { keep: true },
  },
  attempts: 0,
  createdAt: 10,
})

class SpyKvStore implements KvStore {
  readonly inner: MemoryKvStore
  setManyCalls = 0
  failSetKeys = new Set<string>()

  constructor(initial?: Iterable<KvEntry>) {
    this.inner = new MemoryKvStore(initial)
  }

  get<T = unknown>(key: string): Promise<T | undefined> {
    return this.inner.get<T>(key)
  }
  getMany<T = unknown>(keys: readonly string[]): Promise<(T | undefined)[]> {
    return this.inner.getMany<T>(keys)
  }
  set<T = unknown>(key: string, value: T): Promise<void> {
    if (this.failSetKeys.has(key)) return Promise.reject(new Error('injected write failure'))
    return this.inner.set(key, value)
  }
  async setMany(entries: readonly KvEntry[]): Promise<void> {
    this.setManyCalls += 1
    for (const [key] of entries) {
      if (this.failSetKeys.has(key)) throw new Error('injected batch failure')
    }
    await this.inner.setMany(entries)
  }
  update<T = unknown>(key: string, updater: (current: T | undefined) => T): Promise<void> {
    return this.inner.update(key, updater)
  }
  del(key: string): Promise<void> {
    return this.inner.del(key)
  }
  delMany(keys: readonly string[]): Promise<void> {
    return this.inner.delMany(keys)
  }
  entries(): Promise<[string, unknown][]> {
    return this.inner.entries()
  }
  clear(): Promise<void> {
    return this.inner.clear()
  }
}

describe('LocalDb', () => {
  it('isolates users without clearing another user namespace', async () => {
    const kv = new MemoryKvStore()
    const db = createLocalDb({ kv })

    await db.bindUser('user-a')
    await db.saveShell(shell)
    await db.enqueueOutbox(outboxItem())

    await db.bindUser('user-b')
    expect(await db.loadShell()).toBeNull()
    expect(await db.getOutbox()).toEqual([])

    await db.bindUser('user-a')
    expect(await db.loadShell()).toEqual(shell)
    expect(await db.getOutbox()).toHaveLength(1)
  })

  it('migrates legacy data only when the stored user owns it', async () => {
    const kv = new MemoryKvStore([
      ['userId', 'user-a'],
      ['notes', []],
      ['folders', []],
      ['tags', []],
      ['cursor', 9],
      ['outbox', [outboxItem()]],
    ])
    const db = createLocalDb({ kv })

    await db.bindUser('user-a')
    expect(await db.loadShell()).toEqual({ ...shell, cursor: 9 })
    expect(await db.getOutbox()).toEqual([outboxItem()])
    expect(await kv.get('outbox')).toBeUndefined()
    expect(await kv.get('user:user-a:outbox')).toEqual([outboxItem()])

    await db.bindUser('user-b')
    expect(await db.getOutbox()).toEqual([])
    expect(await kv.get('user:user-b:outbox')).toBeUndefined()
  })

  it('keeps old key when migration write is interrupted', async () => {
    const kv = new SpyKvStore([
      ['userId', 'user-a'],
      ['outbox', [outboxItem()]],
    ])
    kv.failSetKeys.add('user:user-a:outbox')
    const db = createLocalDb({ kv })

    await expect(db.bindUser('user-a')).rejects.toBeInstanceOf(BackendError)
    expect(await kv.get('outbox')).toEqual([outboxItem()])
    expect(await kv.get('user:user-a:outbox')).toBeUndefined()
  })

  it('commits shell as one atomic checkpoint batch', async () => {
    const kv = new SpyKvStore()
    const db = createLocalDb({ kv })
    await db.bindUser('user-a')

    await db.saveShell(shell)
    expect(kv.setManyCalls).toBe(1)
    expect(await db.loadShell()).toEqual(shell)
  })

  it('rejects a corrupt outbox instead of treating it as empty', async () => {
    const kv = new MemoryKvStore([['user:user-a:outbox', [{ id: 'broken', payload: null }]]])
    const db = createLocalDb({ kv })
    await db.bindUser('user-a')

    await expect(db.getOutbox()).rejects.toMatchObject({ code: 'internal', status: 0 })
    await expect(db.completeOutboxItem('broken', 'w-1')).rejects.toMatchObject({ code: 'internal', status: 0 })
    expect(await kv.get('user:user-a:outbox')).toEqual([{ id: 'broken', payload: null }])
  })

  it('retains unknown outbox payload fields through atomic updates', async () => {
    const kv = new MemoryKvStore()
    const db = createLocalDb({ kv })
    await db.bindUser('user-a')
    await db.enqueueOutbox(outboxItem())
    await db.updateOutboxRevision(outboxItem().id, 'w-1', 2, true)

    const [updated] = await db.getOutbox()
    expect(updated?.payload).toMatchObject({ futureField: { keep: true }, rev: 2, preserveVersion: true })
  })
})
