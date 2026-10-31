import { expect, it, vi } from 'vitest'
import { BackendError } from '@app/backend'
import { createWebBackend } from './index'
import { MemoryKvStore } from '../local'
import { MemoryTabBus } from './tab-bus'

it('waits for local journal without network replay and keeps backend alive when persistence fails', async () => {
  const kv = new MemoryKvStore()
  const bus = new MemoryTabBus('user')
  const close = vi.spyOn(bus, 'close')
  const fetch = vi.fn(async (request: Request) => {
    if (new URL(request.url).pathname === '/api/auth/session')
      return Response.json({
        user: {
          id: 'user',
          login: 'user',
          username: 'user',
          name: 'User',
          avatarUrl: '',
          role: 'member',
          createdAt: 1,
        },
        site: {
          name: 'AutoNote',
          initialized: true,
          registrationOpen: true,
          r2Enabled: false,
          kvEnabled: false,
          attachmentStorage: null,
          realtimeEnabled: false,
          version: '1',
        },
        settings: null,
      })
    throw new BackendError('offline', 0, 'Offline')
  })
  const backend = createWebBackend({
    fetch,
    kv,
    bus,
    sockets: null,
    lock: { run: async () => false },
    clientId: 'tab',
    getLocale: () => 'en-US',
    page: { isHidden: false, isOnline: false, on: () => () => undefined },
    timers: {
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
    },
    clock: { now: () => 1 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  })
  await backend.session.load()
  const update = kv.update.bind(kv)
  kv.update = async () => {
    throw new Error('quota')
  }
  await expect(
    backend.notes.patch(
      'note',
      { rev: 1, content: 'retain' },
      { writeId: 'failed' },
    ),
  ).rejects.toMatchObject({ code: 'internal' })
  await expect(backend.dispose()).rejects.toMatchObject({ code: 'internal' })
  expect(close).not.toHaveBeenCalled()
  kv.update = update
  await expect(
    backend.notes.patch(
      'note',
      { rev: 1, content: 'retain' },
      { writeId: 'durable' },
    ),
  ).resolves.toMatchObject({ queued: true })
  await backend.dispose()
  expect(close).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(await kv.get('user:user:outbox')).toMatchObject([
    { writeId: 'durable', payload: { content: 'retain' } },
  ])
  await backend.dispose()
  expect(close).toHaveBeenCalledTimes(1)
})
