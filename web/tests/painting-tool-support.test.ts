import { describe, expect, it } from 'vitest'
import { fixture, streamOf } from './support/ai-kit-harness'
import { fetchMock, setup, run } from './support/painting-test-setup'

describe('unknown tool support', () => {
  it(
    'retries once without tools when the upstream rej' +
      'ects them, but not when tools are declared',
    async () => {
      const reject = () =>
        new Response('{"error":{"message":"tools are not supported"}}', {
          status: 400,
        })
      const { h, model } = await setup('openai-chat')
      fetchMock
        .mockResolvedValueOnce(reject())
        .mockResolvedValueOnce(
          new Response(
            streamOf(new Uint8Array(fixture('sse/openai-chat/text.sse'))),
          ),
        )
      const result = await run(h, { model, generateImage: true })
      expect(result.events.at(-1)).toMatchObject({
        kind: 'end',
        status: 'completed',
      })
      const bodies = fetchMock.mock.calls.map(
        ([, init]) =>
          JSON.parse(String(init!.body)) as {
            tools?: unknown
          },
      )
      expect(bodies.map((body) => body.tools === undefined)).toEqual([
        false,
        true,
      ])
      fetchMock.mockReset()
      const declared = await setup('openai-chat', { supportsTools: true })
      fetchMock.mockResolvedValue(reject())
      const failed = await run(declared.h, {
        model: declared.model,
        generateImage: true,
      })
      expect(failed.events.at(-1)).toMatchObject({
        kind: 'end',
        status: 'failed',
      })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )
})
