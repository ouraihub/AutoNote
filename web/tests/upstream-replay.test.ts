import { describe, expect, it } from 'vitest'

import { createHarness, fixture, streamOf } from './support/ai-kit-harness'
import {
  KEY,
  PROTOCOLS,
  expected,
  fetchMock,
  saveProvider,
  run,
} from './support/ai-kit-test-setup'

describe('runs replay upstream fixtures', () => {
  for (const protocol of PROTOCOLS) {
    for (const [name, want] of Object.entries(expected[protocol]!)) {
      it(`${protocol}/${name}`, async () => {
        const h = await createHarness()
        const { endpointId } = await saveProvider(h, 'user-a', protocol)
        const bytes = fixture(`sse/${protocol}/${name}.sse`)
        fetchMock.mockResolvedValue(
          new Response(
            streamOf(
              new Uint8Array(bytes),
              name === 'chinese' ? 1 : bytes.length,
            ),
          ),
        )
        const { events } = await run(h, {
          model: { endpointId, modelId: 'm1' },
        })
        expect(events[0]).toMatchObject({
          kind: 'accepted',
          conversationId: expect.any(String),
        })
        const deltas = events
          .filter((event) => event.kind === 'text_delta')
          .map((event) => event.text)
          .join('')
        expect(deltas).toBe(want.text)
        const end = events.at(-1)!
        expect(events.filter((event) => event.kind === 'end')).toHaveLength(1)
        expect(end.status).toBe(want.status)
        if (want.status === 'completed') {
          expect(events.find((event) => event.kind === 'usage')).toMatchObject({
            inputTokens: want.inputTokens,
            outputTokens: want.outputTokens,
          })
        } else {
          expect(end.error).toMatchObject({
            code: want.errorCode,
            details: { reason: 'stream_error' },
          })
        }
        const [, init] = fetchMock.mock.calls[0]!
        expect(init).toMatchObject({
          headers: { authorization: `Bearer ${KEY}` },
          redirect: 'manual',
        })
        expect(JSON.parse(String(init?.body))).toMatchObject({
          stream: true,
          model: 'm1',
        })
      })
    }
  }

  for (const protocol of PROTOCOLS) {
    it(
      '' +
        `${protocol}` +
        ('/missing terminal fails without replaying the pa' + 'rtial stream'),
      async () => {
        const h = await createHarness()
        const { endpointId } = await saveProvider(h, 'user-a', protocol)
        const partial =
          protocol === 'anthropic-messages'
            ? {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Partial' },
              }
            : protocol === 'openai-responses'
              ? { type: 'response.output_text.delta', delta: 'Partial' }
              : { choices: [{ delta: { content: 'Partial' } }] }
        fetchMock.mockImplementation(
          async () => new Response(`data: ${JSON.stringify(partial)}\n\n`),
        )
        const { events } = await run(h, {
          model: { endpointId, modelId: 'm1' },
        })
        expect(
          events
            .filter((event) => event.kind === 'text_delta')
            .map((event) => event.text)
            .join(''),
        ).toBe('Partial')
        expect(events.at(-1)).toMatchObject({
          kind: 'end',
          status: 'failed',
          error: { code: 'network', details: { reason: 'incomplete_stream' } },
        })
        expect(fetchMock).toHaveBeenCalledTimes(1)
      },
    )
  }
})
