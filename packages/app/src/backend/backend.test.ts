import { describe, expect, test } from 'vitest'
import { ChangeFeedEmitter } from './change-feed'
import { backendErrorFromPayload } from './errors'

describe('ChangeFeedEmitter', () => {
  test('handles self-unsubscribe without skipping other subscribers', () => {
    const changes = new ChangeFeedEmitter()
    const received: string[] = []
    const unsubscribe = changes.subscribe(() => {
      received.push('first')
      unsubscribe()
    })
    changes.subscribe(() => received.push('second'))

    changes.emit({ kind: 'settings' })
    changes.emit({ kind: 'connectivity', online: true })

    expect(received).toEqual(['first', 'second', 'second'])
  })

  test('does not notify after disposal', () => {
    const changes = new ChangeFeedEmitter()
    let count = 0
    changes.subscribe(() => {
      count += 1
    })

    changes.dispose()
    changes.emit({ kind: 'settings' })
    changes.dispose()

    expect(count).toBe(0)
  })
})

describe('backendErrorFromPayload', () => {
  test('keeps cancellation distinct from offline and removes unknown details', () => {
    const cancelled = backendErrorFromPayload(
      {
        error: {
          code: 'cancelled',
          message: 'Request cancelled',
          details: { diskPath: 'C:\\private', retryAfter: 2 },
        },
      },
      { code: 'offline', status: 0, message: 'Offline' },
    )

    expect(cancelled.code).toBe('cancelled')
    expect(cancelled.status).toBe(0)
    expect(cancelled.details).toEqual({ retryAfter: 2 })
  })
})
