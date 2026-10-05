import { expect, test } from 'vitest'
import { LogsState } from './logs.svelte'
import type { LogEntry } from '../host/desktop-types'
import { IpcLogger } from './ipc-logger'
import type { IpcTransport } from '../ipc/transport'
import type { CommandArgs } from '../ipc/commands'

test('closing the log view ignores an in-flight read and stops polling', async () => {
  const pending = Promise.withResolvers<LogEntry[]>()
  let reads = 0
  const logs = new LogsState({
    readLogs: () => {
      reads++
      return pending.promise
    },
    readAvailability: async () => true,
  })
  logs.start()
  logs.start()
  await logs.refresh()
  expect(reads).toBe(1)
  logs.stop()
  pending.resolve([{ seq: 1, time: '', level: 'WARN', target: 'app', message: 'late' }])
  await pending.promise
  await Promise.resolve()
  expect(logs.entries).toEqual([])
  expect(logs.loading).toBe(false)
  await logs.refresh()
  expect(reads).toBe(1)
})

test('IPC logging removes free text and reports failed batches without recursive logging', async () => {
  const batches: CommandArgs['app_log'][] = []
  let fail = true
  const transport = {
    invoke: async (_command: string, args: CommandArgs['app_log']) => {
      batches.push(args)
      if (fail) throw new Error('token-secret')
      return { ok: true, available: true }
    },
  } as unknown as IpcTransport
  const logger = new IpcLogger(transport)
  logger.error('notes.save.failed', {
    code: 'conflict',
    count: 1,
    name: 'token-secret',
    title: 'private',
    reason: 'password',
    noteId: '01arz3ndektsv4rrffq69g5fav',
  })
  await logger.flush()
  expect(batches).toHaveLength(1)
  expect(batches[0]?.entries[0]?.fields).toEqual({ code: 'conflict', count: 1, noteId: '01arz3ndektsv4rrffq69g5fav' })
  expect(logger.available).toBe(false)
  expect(logger.diagnostic).toEqual({ event: 'app.log.unavailable', droppedCount: 1 })
  fail = false
  await logger.flush()
  expect(batches[1]).toEqual({ entries: [], droppedCount: 1 })
  expect(logger.available).toBe(true)
  expect(logger.diagnostic).toBe(null)
  await logger.dispose()
})

test('saturated IPC log queue prioritizes warnings and remains capped at 200', async () => {
  const waiting = Promise.withResolvers<{ ok: true; available: boolean }>()
  const batches: CommandArgs['app_log'][] = []
  const transport = {
    invoke: async (_command: string, args: CommandArgs['app_log']) => {
      batches.push(args)
      return batches.length === 1 ? waiting.promise : { ok: true, available: true }
    },
  } as unknown as IpcTransport
  const logger = new IpcLogger(transport)
  for (let count = 0; count < 240; count++) logger.info('app.lifecycle.started', { count })
  logger.warn('notes.save.failed', { code: 'conflict' })
  waiting.resolve({ ok: true, available: true })
  await logger.flush()
  expect(batches.every((batch) => batch.entries.length <= 20)).toBe(true)
  expect(batches.slice(1).flatMap((batch) => batch.entries)).toHaveLength(200)
  expect(batches.flatMap((batch) => batch.entries).some((entry) => entry.level === 'warn')).toBe(true)
  expect(batches.reduce((count, batch) => count + batch.droppedCount, 0)).toBe(21)
  await logger.dispose()
})
