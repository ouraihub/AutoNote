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

let clock = Date.now()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  // Run and key routes are rate-limited per user per minute; each test gets its own window.
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 120_000
  vi.setSystemTime(clock)
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

  it('fill-first paints with the next key when the first one breaks while reading the response', async () => {
    const { h, model } = await setup('openai-chat')
    const { body } = await h.json<{ id: string; endpoints: { id: string }[] }[]>('user-a', 'GET', '/providers')
    await addKey(h, 'user-a', model.endpointId, 'sk-second-0123456789')
    await h.json('user-a', 'PUT', '/providers', {
      id: body[0]!.id,
      name: 'P',
      endpoints: [{ id: model.endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', keyStrategy: 'fill_first', models: [chatModel('m1'), { ...chatModel('img1'), modelType: 'image' }] }],
    })
    const broken = () => new Response(new ReadableStream({ pull: (controller) => controller.error(new TypeError('socket hang up')) }))
    let paints = 0
    upstream('openai-chat', 1, () => (paints++ === 0 ? broken() : Response.json({ data: [{ b64_json: PNG }] })))
    const result = await run(h, { model, generateImage: true })
    expect(result.events.find((e) => e.kind === 'tool_result'), JSON.stringify(result.events)).toMatchObject({ outcome: 'ok' })
    expect(calls('/images/generations').map(([, init]) => (init!.headers as Record<string, string>).authorization)).toEqual([`Bearer ${KEY}`, 'Bearer sk-second-0123456789'])
  })

  it('a fully paused fill-first painting line fails the tool call, not the chat', async () => {
    const { h, model } = await setup('openai-chat', { bind: false })
    const { body } = await h.json<{ name: string; endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
      name: 'Img',
      endpoints: [{ slug: 'img', baseUrl: 'https://img.example.com', protocol: 'openai-chat', keyStrategy: 'fill_first', models: [{ ...chatModel('img2'), modelType: 'image' }] }],
    })
    const imgEndpoint = body.find((provider) => provider.name === 'Img')!.endpoints[0]!.id
    await addKey(h, 'user-a', imgEndpoint, 'sk-img-0123456789')
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'painting', ?1, 'img2')").bind(imgEndpoint).run()
    const resumeAt = Date.now() + 60_000
    await h.env.DB.prepare('UPDATE ai_endpoint_keys SET exhausted_until = ?1 WHERE endpoint_id = ?2').bind(resumeAt, imgEndpoint).run()
    upstream('openai-chat', 1)
    const result = await run(h, { model, generateImage: true })
    expect(result.status, result.text).toBe(200)
    expect(result.events.find((e) => e.kind === 'tool_result')).toMatchObject({ outcome: 'error', summary: expect.stringContaining('rate_limited') })
    expect(result.events.find((e) => e.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining('Img · img') })
    expect(result.events.find((e) => e.kind === 'tool_result')).toMatchObject({ summary: expect.stringContaining(new Date(resumeAt).toISOString()) })
    expect(result.events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
    expect(calls('/images/generations')).toEqual([])
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

describe('generate_image edits (docs/37)', () => {
  const GIF = 'R0lGODlh'
  async function editSetup({ edit = true, imageEditBaseUrl = null as string | null } = {}) {
    // The run limiter (20/min per user) is module-global; start each setup in a fresh window.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 120_000)
    const h = await createHarness()
    const save = async (url: string | null, id?: { providerId: string; endpointId: string }) => (await h.json<{ id: string; endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
      ...(id ? { id: id.providerId } : {}),
      name: 'P',
      endpoints: [{
        ...(id ? { id: id.endpointId } : {}), slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', imageEditBaseUrl: url, headers: { 'X-Team': 'blue' },
        models: [{ ...chatModel('m1'), canVision: true }, { ...chatModel('img1'), modelType: 'image', canVision: edit }],
      }],
    })).body[0]!
    const saved = await save(imageEditBaseUrl)
    const ids = { providerId: saved.id, endpointId: saved.endpoints[0]!.id }
    await addKey(h, 'user-a', ids.endpointId, KEY)
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'painting', ?1, 'img1')").bind(ids.endpointId).run()
    return { h, model: { endpointId: ids.endpointId, modelId: 'm1' }, resave: (url: string | null) => save(url, ids) }
  }
  function editUpstream(args: Record<string, unknown>) {
    let chats = 0
    fetchMock.mockImplementation(async (input) => {
      if (String(input).includes('/images/')) return Response.json({ data: [{ b64_json: GIF }] })
      if (chats++ >= 1) return new Response(streamOf(new Uint8Array(fixture('sse/openai-chat/text.sse'))))
      return new Response(streamOf(sse([
        { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'generate_image', arguments: JSON.stringify(args) } }] } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        '[DONE]',
      ])))
    })
  }
  const imageIds = (call: Parameters<typeof fetch>) => {
    const tool = ((bodyOf(call).tools as { function: { description: string; parameters: { properties: Record<string, unknown> } } }[])[0]!).function
    return { description: tool.description, schema: tool.parameters.properties.image_ids }
  }
  const attached = [{ mime: 'image/png', data: PNG }]
  const toolSummary = (events: Record<string, unknown>[]) => events.find((e) => e.kind === 'tool_result')!.summary

  it('edits an attached image via multipart /images/edits, then edits the generated one next turn', async () => {
    const { h, model } = await editSetup()
    editUpstream({ prompt: 'make the background blue', image_ids: ['image-1'] })
    const first = await run(h, { model, generateImage: true, images: attached })
    expect(toolSummary(first.events)).toBe('Generated 1 image; it is already shown to the user.')
    const offered = imageIds(calls('/chat/completions')[0]!)
    expect(offered.schema).toEqual({ type: 'array', items: { type: 'string', enum: ['image-1'] }, minItems: 1, maxItems: 4 })
    expect(offered.description).toContain('Images you can pass in image_ids (newest first):\nimage-1: attached by the user in this message')
    const [edit] = calls('/images/edits')
    expect(String(edit![0])).toBe('https://api.example.com/v1/images/edits')
    const headers = new Headers(edit![1]?.headers)
    expect([headers.get('x-team'), headers.get('authorization'), headers.get('content-type')]).toEqual(['blue', `Bearer ${KEY}`, null])
    const form = edit![1]!.body as FormData
    expect([form.get('model'), form.get('prompt'), form.get('size'), form.get('n')]).toEqual(['img1', 'make the background blue', '1024x1024', '1'])
    const files = form.getAll('image') as File[]
    expect(files.map((file) => [file.name, file.type])).toEqual([['image-1.png', 'image/png']])
    expect(form.getAll('image[]')).toEqual([])
    expect(calls('/images/generations')).toEqual([])

    fetchMock.mockReset()
    editUpstream({ prompt: 'now red', image_ids: ['image-1', 'image-2'] })
    const second = await run(h, { model, generateImage: true, conversationId: String(first.events[0]!.conversationId), input: 'Now red' })
    expect(toolSummary(second.events)).toBe('Generated 1 image; it is already shown to the user.')
    expect(imageIds(calls('/chat/completions')[0]!).description).toContain('image-1: generated in an earlier reply\nimage-2: attached in an earlier message')
    const many = calls('/images/edits')[0]![1]!.body as FormData
    expect(many.getAll('image')).toEqual([])
    const parts = many.getAll('image[]') as File[]
    expect(parts.map((file) => file.name)).toEqual(['image-1.png', 'image-2.png'])
    expect(await Promise.all(parts.map(async (file) => btoa(String.fromCharCode(...new Uint8Array(await file.arrayBuffer())))))).toEqual([GIF, PNG])
  })

  it('offers no image_ids when the painting model cannot edit or no image is available', async () => {
    const plain = await editSetup({ edit: false })
    editUpstream({ prompt: 'a cat' })
    await run(plain.h, { model: plain.model, generateImage: true, images: attached })
    expect(imageIds(calls('/chat/completions')[0]!).schema).toBeUndefined()
    fetchMock.mockReset()
    const empty = await editSetup()
    editUpstream({ prompt: 'a cat' })
    await run(empty.h, { model: empty.model, generateImage: true })
    expect(imageIds(calls('/chat/completions')[0]!)).toMatchObject({ schema: undefined, description: expect.not.stringContaining('image-1') })
    expect(calls('/images/generations')).toHaveLength(1)
  })

  it('feeds unknown, expired, unsupported and too_many image_ids back to the model', async () => {
    const reason = async ({ h, model }: { h: Harness; model: Record<string, string> }, ids: unknown, body: Record<string, unknown> = { images: attached }) => {
      fetchMock.mockReset()
      editUpstream({ prompt: 'x', image_ids: ids })
      const result = await run(h, { model, generateImage: true, ...body })
      expect(calls('/images/')).toEqual([])
      return { summary: toolSummary(result.events), conversationId: String(result.events[0]!.conversationId) }
    }
    const ok = await editSetup()
    const unknown = await reason(ok, ['image-2'])
    expect(unknown.summary).toBe('error bad_request: invalid image_ids: unknown')
    expect((await reason(ok, ['image-1', 'image-1', 'image-1', 'image-1', 'image-1'])).summary).toBe('error bad_request: invalid image_ids: too_many')
    ok.h.objects.clear()
    expect((await reason(ok, ['image-1'], { conversationId: unknown.conversationId, input: 'again' })).summary).toBe('error bad_request: invalid image_ids: expired')
    expect((await reason(await editSetup({ edit: false }), ['image-1'])).summary).toBe('error bad_request: invalid image_ids: unsupported')
  })

  it('numbers the last attached image as image-1', async () => {
    const { h, model } = await editSetup()
    editUpstream({ prompt: 'x', image_ids: ['image-1'] })
    await run(h, { model, generateImage: true, images: [...attached, { mime: 'image/gif', data: GIF }] })
    const file = (calls('/images/edits')[0]![1]!.body as FormData).get('image') as File
    expect([file.name, file.type]).toEqual(['image-1.gif', 'image/gif'])
  })

  it('edits at the image edit base URL and falls back to the API address when cleared', async () => {
    const { h, model, resave } = await editSetup({ imageEditBaseUrl: 'https://edit.example.com/' })
    editUpstream({ prompt: 'x', image_ids: ['image-1'] })
    await run(h, { model, generateImage: true, images: attached })
    expect(calls('/images/edits').map(([url]) => String(url))).toEqual(['https://edit.example.com/v1/images/edits'])
    await resave('')
    fetchMock.mockReset()
    editUpstream({ prompt: 'x', image_ids: ['image-1'] })
    await run(h, { model, generateImage: true, images: attached })
    expect(calls('/images/edits').map(([url]) => String(url))).toEqual(['https://api.example.com/v1/images/edits'])
  })
})

describe('unknown tool support', () => {
  it('retries once without tools when the upstream rejects them, but not when tools are declared', async () => {
    const reject = () => new Response('{"error":{"message":"tools are not supported"}}', { status: 400 })
    const { h, model } = await setup('openai-chat')
    fetchMock.mockResolvedValueOnce(reject()).mockResolvedValueOnce(new Response(streamOf(new Uint8Array(fixture('sse/openai-chat/text.sse')))))
    const result = await run(h, { model, generateImage: true })
    expect(result.events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
    const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init!.body)) as { tools?: unknown })
    expect(bodies.map((body) => body.tools === undefined)).toEqual([false, true])

    fetchMock.mockReset()
    const declared = await setup('openai-chat', { supportsTools: true })
    fetchMock.mockResolvedValue(reject())
    const failed = await run(declared.h, { model: declared.model, generateImage: true })
    expect(failed.events.at(-1)).toMatchObject({ kind: 'end', status: 'failed' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
