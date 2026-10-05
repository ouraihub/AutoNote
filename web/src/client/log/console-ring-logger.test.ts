import { describe, expect, it } from 'vitest'
import { ConsoleRingLogger } from './console-ring-logger'

describe('diagnostic log privacy', () => {
  it('keeps latest 200 safe records and never exports raw secret fields', () => {
    const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }
    const logger = new ConsoleRingLogger({ console: silent, clock: () => 1 })
    for (let index = 0; index < 201; ++index) logger.info('host.lifecycle.started', { index })
    logger.error('share.read.failed', {
      password: 'private',
      title: 'private',
      authorization: 'private',
      url: 'https://site/api?token=private',
      error: 'private',
      code: 'offline',
      status: 401,
    })
    const entries = logger.entries()
    expect(entries).toHaveLength(200)
    expect(entries[0]?.fields).toEqual({ index: 2 })
    expect(entries.at(-1)?.fields).toEqual({ code: 'offline', status: 401 })
    expect(JSON.stringify(entries)).not.toContain('private')
    ;(entries[0]?.fields as Record<string, unknown>).index = 999
    expect(logger.entries()[0]?.fields).toEqual({ index: 2 })
  })
})
