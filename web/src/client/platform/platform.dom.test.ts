import { describe, expect, test } from 'vitest'
import { WebPrefsStore, type StorageLike } from './prefs'
import { browserPageSignals } from './page-signals'
import { ConsoleRingLogger, type ConsoleLike } from '../log/console-ring-logger'
import { isBackendError } from '@app/backend/errors.ts'

class MemoryStorage implements StorageLike {
  #entries = new Map<string, string>()

  getItem(key: string): string | null {
    return this.#entries.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.#entries.set(key, value)
  }

  removeItem(key: string): void {
    this.#entries.delete(key)
  }
}

class FailingStorage implements StorageLike {
  getItem(): string | null {
    throw new Error('Blocked')
  }

  setItem(): void {
    throw new Error('Blocked')
  }

  removeItem(): void {
    throw new Error('Blocked')
  }
}

describe('Web platform boundaries', () => {
  test('persists preferences under a dedicated non-content namespace', async () => {
    const storage = new MemoryStorage()
    const prefs = new WebPrefsStore(storage)

    await prefs.save('layout', 'split')

    expect(await prefs.load('layout')).toBe('split')
    await prefs.remove('layout')
    expect(await prefs.load('layout')).toBeUndefined()
  })

  test('turns blocked browser storage into a structured safe error', async () => {
    const prefs = new WebPrefsStore(new FailingStorage())

    await expect(prefs.load('layout')).rejects.toSatisfy((error: unknown) => {
      if (!isBackendError(error)) return false
      return error.code === 'internal' && !error.message.includes('Blocked')
    })
  })

  test('removes page listeners after unsubscribe', () => {
    let online = 0
    const unsubscribe = browserPageSignals.on('online', () => {
      online += 1
    })

    window.dispatchEvent(new Event('online'))
    unsubscribe()
    window.dispatchEvent(new Event('online'))

    expect(online).toBe(1)
  })

  test('keeps the latest 200 safe log entries and excludes secrets', () => {
    const entries: unknown[] = []
    const logger = new ConsoleRingLogger({ console: fakeConsole(entries), clock: () => 42 })

    for (let index = 0; index < 201; index += 1) logger.info('host.lifecycle.started', { index })
    logger.error('host.lifecycle.failed', { token: 'not-safe' })

    expect(logger.entries()).toHaveLength(200)
    expect(logger.entries()[0]?.fields).toEqual({ index: 1 })
    expect(logger.entries().some((entry) => entry.event === 'host.lifecycle.failed')).toBe(false)
  })
})

function fakeConsole(entries: unknown[]): ConsoleLike {
  return {
    debug: (...values) => entries.push(values),
    info: (...values) => entries.push(values),
    warn: (...values) => entries.push(values),
    error: (...values) => entries.push(values),
  }
}
