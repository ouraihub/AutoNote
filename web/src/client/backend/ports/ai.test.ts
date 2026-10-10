import { expect, it } from 'vitest'
import { HttpAiPort } from './ai'

function streamed(chunks: readonly string[]): Response {
  const encoder = new TextEncoder()
  let index = 0
  return new Response(
    new ReadableStream({
      pull(controller) {
        const value = chunks[index++]
        if (value === undefined) controller.close()
        else controller.enqueue(encoder.encode(value))
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  )
}

it('streams split UTF-8 SSE events and refuses a truncated result', async () => {
  const request = { action: 'polish' as const, text: '汉字' }
  const meta = 'data: {"kind":"meta","model":{"endpointId":"ep","modelId":"gpt"},"isFallback":true}\n\n'
  const delta = 'data: {"kind":"delta","text":"汉字"}\n\n'
  const done = 'data: {"kind":"done","inputTokens":1,"outputTokens":2}\n\n'
  const bytes = new TextEncoder().encode(meta + delta + done)
  const split = bytes.indexOf(0xe6) + 1
  const port = new HttpAiPort({
    transport: {
      json: async () => {
        throw new Error('Unexpected JSON request')
      },
      raw: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(bytes.slice(0, split))
              controller.enqueue(bytes.slice(split))
              controller.close()
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    },
  })
  const events: unknown[] = []
  await expect(port.write(request, (event) => events.push(event))).resolves.toEqual({
    model: { endpointId: 'ep', modelId: 'gpt' },
    isFallback: true,
  })
  expect(events).toEqual([
    { kind: 'delta', text: '汉字' },
    { kind: 'done', inputTokens: 1, outputTokens: 2 },
  ])
  const truncated = new HttpAiPort({
    transport: { json: async <T>() => null as T, raw: async () => streamed([meta, delta]) },
  })
  await expect(truncated.write(request, () => undefined)).rejects.toMatchObject({ code: 'invalid_response' })
})
