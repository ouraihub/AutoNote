import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addKey, chatModel, createHarness, fixture, frames, streamOf, type Harness } from './support/ai-kit-harness'

const KEY = 'sk-test-abcdefghijklmnop'
const PNG = 'iVBORw0KGgo='
const PROMPT = '{"prompt":"a cat"}'
const fetchMock = vi.fn<typeof fetch>()
type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

const sse = (events: unknown[]) => new TextEncoder().encode(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
const TOOL_ROUND: Record<Protocol, Uint8Array> = {
  'openai-chat': sse([
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'generate_image', arguments: '' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: PROMPT } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]),
  'anthropic-messages': sse([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'generate_image', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: PROMPT } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]),
  'openai-responses': sse([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'generate_image', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: PROMPT },
    { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 3 }, output: [] } },
  ]),
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function setup(protocol: Protocol, { bind = true, supportsTools = null as boolean | null } = {}) {
  const h = await createHarness()
  const { body } = await h.json<{ endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
    name: 'P',
    endpoints: [{ slug: 'main', baseUrl: 'https://api.example.com', protocol, models: [{ ...chatModel('m1'), supportsTools }, { ...chatModel('img1'), modelType: 'image' }] }],
  })
  const endpointId = body[0]!.endpoints[0]!.id
  await addKey(h, 'user-a', endpointId, KEY)
  if (bind) await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'painting', ?1, 'img1')").bind(endpointId).run()
  return { h, model: { endpointId, modelId: 'm1' } }
}

/** The chat model answers with `rounds` (tool calls, then the text fixture); the painting model with `paint`. */
function upstream(protocol: Protocol, toolRounds: number, paint: () => Response = () => Response.json({ data: [{ b64_json: PNG }] })) {
  let chats = 0
  fetchMock.mockImplementation(async (input) => {
    if (String(input).endsWith('/images/generations')) return paint()
    return new Response(streamOf(chats++ < toolRounds ? TOOL_ROUND[protocol] : new Uint8Array(fixture(`sse/${protocol}/text.sse`))))
  })
}

async function run(h: Harness, body: Record<string, unknown>) {
  const response = await h.call('user-a', 'POST', '/runs', { purpose: 'chat', skills: [], input: 'Draw a cat', regenerate: false, language: 'en-US', ...body })
  const text = await response.text()
  await h.settle()
  return { status: response.status, events: frames(text), text }
}

const calls = (suffix: string) => fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))
const bodyOf = (call: Parameters<typeof fetch>) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>
const CHAT_PATH: Record<Protocol, string> = { 'openai-chat': '/chat/completions', 'openai-responses': '/responses', 'anthropic-messages': '/messages' }

describe('generate_image tool loop', () => {
  for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages'] as const) {
    it(`paints, feeds the result back, stores and replays it (${protocol})`, async () => {
      const { h, model } = await setup(protocol)
      upstream(protocol, 1)
      const first = await run(h, { model, generateImage: true })
      expect(first.events.find((e) => e.kind === 'tool_call')).toMatchObject({ callId: 'call_1', name: 'generate_image', source: 'host' })
      expect(first.events.find((e) => e.kind === 'tool_result')).toEqual({
        kind: 'tool_result', callId: 'call_1', outcome: 'ok', summary: 'Generated 1 image; it is already shown to the user.',
        payload: { images: [{ mime: 'image/png', url: `data:image/png;base64,${PNG}` }] },
      })
      expect(first.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })

      const paint = calls('/images/generations')
      expect(paint).toHaveLength(1)
      expect(bodyOf(paint[0]!)).toEqual({ model: 'img1', prompt: 'a cat', size: '1024x1024', n: 1 })
      expect(new Headers(paint[0]![1]?.headers).get('authorization')).toBe(`Bearer ${KEY}`)

      const [round1, round2] = calls(CHAT_PATH[protocol]).map(bodyOf)
      const tool = (round1!.tools as Record<string, unknown>[])[0]!
      expect(protocol === 'openai-chat' ? (tool.function as { name: string }).name : tool.name).toBe('generate_image')
      const echo = JSON.stringify(round2)
      if (protocol === 'openai-chat') expect(echo).toContain('"role":"tool","tool_call_id":"call_1"')
      if (protocol === 'openai-responses') expect(echo).toContain('"type":"function_call_output","call_id":"call_1"')
      if (protocol === 'anthropic-messages') expect(echo).toContain('"type":"tool_result","tool_use_id":"call_1"')

      const conversationId = String(first.events[0]!.conversationId)
      const saved = (await h.json<{ turns: { text: string; images: unknown[]; generated: { mime: string; url: string | null }[] }[] }>('user-a', 'GET', `/conversations/${conversationId}`)).body
      expect(saved.turns[0]!.images).toEqual([])
      expect(saved.turns[0]!.generated).toHaveLength(1)
      expect(saved.turns[0]!.text).toBe(first.events.filter((e) => e.kind === 'text_delta').map((e) => e.text).join(''))
      const image = await h.call('user-a', 'GET', saved.turns[0]!.generated[0]!.url!.replace('/api/ai/kit', ''))
      expect(image.headers.get('content-type')).toBe('image/png')

      // A follow-up without the switch offers no tool, replays the earlier call and result, and never re-uploads the image.
      upstream(protocol, 0)
      await run(h, { model, conversationId, input: 'Thanks' })
      const followUp = bodyOf(calls(CHAT_PATH[protocol]).at(-1)!)
      expect(followUp.tools).toBeUndefined()
      expect(JSON.stringify(followUp)).toContain('call_1')
      expect(JSON.stringify(followUp)).not.toContain(PNG)
    })
  }

  it('refuses without a painting model, for tool-less models and outside chat, before any request', async () => {
    const unbound = await setup('openai-chat', { bind: false })
    expect((await run(unbound.h, { model: unbound.model, generateImage: true })).text).toContain('painting_model')
    const toolless = await setup('openai-chat', { supportsTools: false })
    expect((await run(toolless.h, { model: toolless.model, generateImage: true })).text).toContain('tools_unsupported')
    const writing = await run(toolless.h, { model: toolless.model, purpose: 'writing', generateImage: true })
    expect(writing.text).toContain('chat_only')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports painting errors without the key and caps calls per reply', async () => {
    const failing = await setup('openai-chat')
    upstream('openai-chat', 1, () => Response.json({ error: { message: `bad key ${KEY}` } }, { status: 500 }))
    const failed = await run(failing.h, { model: failing.model, generateImage: true })
    const result = failed.events.find((e) => e.kind === 'tool_result')!
    expect(result.outcome).toBe('error')
    expect(JSON.stringify(failed.events)).not.toContain(KEY)
    expect(failed.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })

    fetchMock.mockReset()
    const looping = await setup('openai-chat')
    upstream('openai-chat', 99)
    const capped = await run(looping.h, { model: looping.model, generateImage: true })
    expect(calls('/images/generations')).toHaveLength(2)
    expect(capped.events.filter((e) => e.kind === 'round_start')).toHaveLength(4)
    expect(capped.events.filter((e) => e.kind === 'tool_result').map((e) => e.outcome)).toEqual(['ok', 'ok', 'error', 'error'])
    expect(capped.events.at(-1)).toEqual({ kind: 'end', status: 'completed', exhausted: true })
  })

  it('paints at the image base URL with custom headers and falls back to the API address when cleared', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 120_000)
    const { h, model } = await setup('openai-chat')
    const providerId = (await h.json<{ id: string }[]>('user-a', 'GET', '/providers')).body[0]!.id
    const save = (imageBaseUrl: string) =>
      h.json('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'P',
        endpoints: [{ id: model.endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', imageBaseUrl, headers: { 'X-Team': 'blue' }, models: [chatModel('m1'), { ...chatModel('img1'), modelType: 'image' }] }],
      })
    await save('https://img.example.com/')
    upstream('openai-chat', 1)
    await run(h, { model, generateImage: true })
    const [paint] = calls('/images/generations')
    expect(String(paint![0])).toBe('https://img.example.com/v1/images/generations')
    const headers = new Headers(paint![1]?.headers)
    expect([headers.get('x-team'), headers.get('authorization')]).toEqual(['blue', `Bearer ${KEY}`])

    fetchMock.mockReset()
    await save('')
    upstream('openai-chat', 1)
    await run(h, { model, generateImage: true })
    expect(calls('/images/generations').map(([url]) => String(url))).toEqual(['https://api.example.com/v1/images/generations'])
  })
})
