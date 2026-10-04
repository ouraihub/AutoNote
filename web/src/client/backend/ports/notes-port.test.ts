import { expect, it } from 'vitest'
import { BackendError } from '@app/backend/errors'
import { HttpNotesPort } from './notes-port'
import { createLocalDb, MemoryKvStore } from '../../local'
import { MemoryTabBus, createMemoryTabBusChannel } from '../tab-bus'
import type { RequestSpec } from '../transport'

it('blocks every destructive route while an offline write is pending, including newly submitted text', async () => {
  const db = createLocalDb({ kv: new MemoryKvStore() })
  await db.bindUser('user')
  const calls: RequestSpec[] = []
  const notes = new HttpNotesPort({
    localDb: db,
    clientId: 'tab',
    transport: {
      json: async <T>(spec: RequestSpec): Promise<T> => {
        calls.push(spec)
        throw new BackendError('offline', 0, 'Offline')
      },
    },
    bus: new MemoryTabBus('user', createMemoryTabBusChannel()),
    lock: {
      run: async (_owner, task) => {
        await task(async () => true)
        return true
      },
    },
    clock: { now: () => Date.now() },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    timers: { setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} },
    emitChange() {},
    getAutoSaveDelay: () => 100,
  })
  try {
    const enrolled = notes.patch('note', { rev: 1, content: '不可丢失' }, { writeId: 'latest' })
    for (const mutate of [
      () => notes.remove('note'),
      () => notes.restore('note'),
      () => notes.purge('note'),
      () => notes.duplicate('note'),
      () => notes.emptyTrash(),
      () => notes.restoreVersion('note', 'version'),
    ]) {
      await expect(mutate()).rejects.toMatchObject({ code: 'conflict' })
    }
    await enrolled
    expect(calls.every((call) => call.method === 'PATCH')).toBe(true)
    expect(await db.getOutbox()).toMatchObject([{ writeId: 'latest', payload: { content: '不可丢失' } }])
  } finally {
    notes.dispose()
  }
})
