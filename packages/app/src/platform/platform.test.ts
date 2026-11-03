import { describe, expect, test } from 'vitest'
import { systemClock } from './clock'
import { isSafeLogFields } from '../log/logger'
import type { PrefValue, PrefsStore } from './prefs'

class MemoryPrefsStore implements PrefsStore {
  #values = new Map<string, PrefValue>()

  async load(key: string): Promise<unknown> {
    return this.#values.get(key)
  }

  async save(key: string, value: PrefValue): Promise<void> {
    this.#values.set(key, value)
  }

  async remove(key: string): Promise<void> {
    this.#values.delete(key)
  }
}

describe('platform seams', () => {
  test('keeps independent preferences stores isolated', async () => {
    const first = new MemoryPrefsStore()
    const second = new MemoryPrefsStore()

    await first.save('layout', 'split')

    expect(await first.load('layout')).toBe('split')
    expect(await second.load('layout')).toBeUndefined()
    expect(systemClock.now()).toBeGreaterThan(0)
  })

  test('rejects sensitive structured logging fields', () => {
    expect(
      isSafeLogFields({ noteId: '01j8v2rz4k4ybx4yy1fcp1mv1w', durationMs: 5 }),
    ).toBe(true)
    expect(isSafeLogFields({ content: 'secret text' })).toBe(false)
    expect(isSafeLogFields({ token: '[redacted]' })).toBe(true)
    expect(isSafeLogFields({ token: 'ink_private' })).toBe(false)
  })
})
