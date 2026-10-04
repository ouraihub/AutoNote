import { expect, test } from 'vitest'
import { LogsState } from './logs.svelte'
import type { LogEntry } from '../ipc/types'

test('closing the log view ignores an in-flight read and stops polling', async () => {
  const pending = Promise.withResolvers<LogEntry[]>()
  let reads = 0
  const logs = new LogsState({ readLogs: () => { reads++; return pending.promise } })
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
