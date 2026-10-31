import { describe, expect, it } from 'vitest'
import type { Logger } from '@app/log/logger'
import { HttpTransport } from '../transport'
import type { BackendSession } from '@shared/backend-types'
import { MemoryKvStore, createLocalDb } from '../../local'
import { HttpSessionPort } from './session'

const session: BackendSession = {
  user: {
    id: 'u1',
    login: 'u1',
    username: 'u1',
    name: 'U',
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
    attachmentStorage: 'local',
    realtimeEnabled: false,
    version: '1',
  },
  settings: null,
}
const bus = {
  post() {},
  subscribe() {
    return () => undefined
  },
  close() {},
}
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }

function transport(response: unknown, requests: unknown[]): HttpTransport {
  return new HttpTransport({
    fetch: async (request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.headers.has('content-type')
          ? await request.json()
          : undefined,
      })
      return Response.json(response)
    },
    clientId: 'test',
    getLocale: () => 'en-US',
    bus,
    logger,
    timers: {
      setTimeout: () => 1,
      clearTimeout() {},
      setInterval: () => 1,
      clearInterval() {},
    },
  })
}

function port(
  response: unknown,
  pending?: () => Promise<{ pending: number; failed: number }>,
) {
  const requests: unknown[] = []
  const client = transport(response, requests)
  return {
    port: new HttpSessionPort({
      transport: client,
      localDb: createLocalDb({ kv: new MemoryKvStore() }),
      bus,
      clientId: 'test',
      ...(pending ? { pending } : {}),
    }),
    requests,
  }
}

describe('HttpSessionPort', () => {
  it('maps account requests and persists authenticated session', async () => {
    const { port: sessionPort, requests } = port(session)
    await expect(
      sessionPort.account?.register('u1', 'password-password', 'en-US'),
    ).resolves.toEqual(session)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/auth/register',
      body: { username: 'u1', locale: 'en-US' },
    })
  })

  it('does not call logout when any queue remains', async () => {
    const { port: sessionPort, requests } = port({ ok: true }, async () => ({
      pending: 1,
      failed: 0,
    }))
    await expect(sessionPort.logout()).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(requests).toHaveLength(0)
  })

  it('keeps session cache and queues when logout succeeds', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const requests: unknown[] = []
    const sessionPort = new HttpSessionPort({
      transport: transport({ ok: true }, requests),
      localDb: db,
      bus,
      clientId: 'test',
      pending: async () => ({ pending: 0, failed: 0 }),
    })
    await db.saveSession(session)
    await sessionPort.logout()
    expect(requests).toHaveLength(1)
    await expect(db.loadSession()).resolves.toBeNull()
    await expect(db.getAllOutbox()).resolves.toEqual([])
  })

  it('blocks pending writes and preserves a late write after successful logout', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const requests: unknown[] = []
    const sessionPort = new HttpSessionPort({
      transport: {
        json: async () => {
          requests.push('logout')
          await db.enqueueOutbox({
            id: 'patch:test:n2',
            clientId: 'test',
            writeId: 'w2',
            noteId: 'n2',
            payload: { rev: 1, content: 'late draft', contentDirty: true },
            attempts: 0,
            createdAt: 2,
          })
          return { ok: true }
        },
      } as unknown as HttpTransport,
      localDb: db,
      bus,
      clientId: 'test',
    })
    await db.saveSession(session)
    await db.enqueueOutbox({
      id: 'patch:test:n1',
      clientId: 'test',
      writeId: 'w1',
      noteId: 'n1',
      payload: { rev: 1, content: 'draft', contentDirty: true },
      attempts: 0,
      createdAt: 1,
    })
    await expect(sessionPort.logout()).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(requests).toHaveLength(0)
    await expect(db.loadSession()).resolves.toEqual(session)
    await db.completeOutboxItem('patch:test:n1', 'w1')
    await sessionPort.logout()
    expect(requests).toHaveLength(1)
    await expect(db.loadSession()).resolves.toBeNull()
    expect((await db.getAllOutbox()).map((item) => item.writeId)).toEqual([
      'w2',
    ])
  })

  it('does not allow stale account response to overwrite a newer login', async () => {
    const db = createLocalDb({ kv: new MemoryKvStore() })
    const waits: Array<(value: BackendSession) => void> = []
    const sessionPort = new HttpSessionPort({
      transport: {
        json: () =>
          new Promise<BackendSession>((resolve) => waits.push(resolve)),
      } as unknown as HttpTransport,
      localDb: db,
      bus,
      clientId: 'test',
    })
    const stale = sessionPort.account!.login('first', 'password')
    const latest = sessionPort.account!.login('second', 'password')
    const second = { ...session, user: { ...session.user!, id: 'u2' } }
    waits[1]!(second)
    await latest
    waits[0]!(session)
    await expect(stale).rejects.toMatchObject({ code: 'cancelled' })
    await expect(db.loadSession()).resolves.toEqual(second)
  })
})
