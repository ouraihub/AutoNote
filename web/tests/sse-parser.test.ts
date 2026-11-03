import { describe, expect, it } from 'vitest'

import { SseParser } from '@ouraihub/aether-core/sse'

describe('sse parser', () => {
  it(
    'joins data lines, ignores comments and handles C' +
      'RLF across 1-byte chunks',
    () => {
      const bytes = new TextEncoder().encode(
        ': ping\r\nid: 1\r\nevent: delta\r\ndata: 你\r\ndata:好\r\n\r\n' +
          'event: lonely\n\ndata: tail',
      )
      const parser = new SseParser()
      const events = [...bytes].flatMap((byte) =>
        parser.feed(new Uint8Array([byte])),
      )
      events.push(...parser.finish())
      expect(events).toEqual([
        { event: 'delta', data: '你\n好' },
        { event: null, data: 'tail' },
      ])
    },
  )
})
