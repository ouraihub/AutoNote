import { readFileSync } from 'node:fs'
import { createServer, request as httpsRequest } from 'node:https'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inferModel } from '../src/worker/ai/infer'
import { SseParser } from '../src/worker/ai/protocol'
import { chatModel, createHarness, fixture, frames, streamOf } from './support/ai-kit-harness'

type Harness = Awaited<ReturnType<typeof createHarness>>
const KEY = 'sk-test-abcdefghijklmnop'
const PROTOCOLS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const
const expected = JSON.parse(fixture('sse/expect.json').toString()) as Record<
  string,
  Record<string, { status: string; text: string; inputTokens?: number; outputTokens?: number; errorCode?: string; errorMessage?: string }>
>

const fetchMock = vi.fn<typeof fetch>()
let clock = Date.now()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 120_000
  vi.setSystemTime(clock)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function saveProvider(h: Harness, user = 'user-a', protocol: (typeof PROTOCOLS)[number] = 'openai-chat') {
  const { body } = await h.json<{ id: string; endpoints: { id: string }[] }[]>(user, 'PUT', '/providers', {
    name: 'Acme',
    endpoints: [{ slug: 'main', baseUrl: 'https://api.example.com', protocol, apiKey: KEY, models: [chatModel('m1')] }],
  })
  const provider = body.at(-1)!
  return { providerId: provider.id, endpointId: provider.endpoints[0]!.id }
}

async function run(h: Harness, body: Record<string, unknown>, user = 'user-a') {
  const response = await h.call(user, 'POST', '/runs', { purpose: 'chat', skills: [], input: 'Hello there', regenerate: false, language: 'en-US', ...body })
  const text = await response.text()
  await h.settle()
  return { response, events: response.headers.get('content-type')?.startsWith('text/event-stream') ? frames(text) : [], text }
}

describe('model inference', () => {
  it('matches every fixture entry', () => {
    const cases = JSON.parse(fixture('model-classify.json').toString()) as ({ id: string } & Record<string, unknown>)[]
    expect(cases.length).toBeGreaterThanOrEqual(30)
    for (const { id, ...rest } of cases) expect(inferModel(id), id).toEqual(rest)
  })
})

describe('sse parser', () => {
  it('joins data lines, ignores comments and handles CRLF across 1-byte chunks', () => {
    const bytes = new TextEncoder().encode(': ping\r\nid: 1\r\nevent: delta\r\ndata: 你\r\ndata:好\r\n\r\nevent: lonely\n\ndata: tail')
    const parser = new SseParser()
    const events = [...bytes].flatMap((byte) => parser.feed(new Uint8Array([byte])))
    events.push(...parser.finish())
    expect(events).toEqual([
      { event: 'delta', data: '你\n好' },
      { event: null, data: 'tail' },
    ])
  })
})

describe('runs replay upstream fixtures', () => {
  for (const protocol of PROTOCOLS) {
    for (const [name, want] of Object.entries(expected[protocol]!)) {
      it(`${protocol}/${name}`, async () => {
        const h = await createHarness()
        const { endpointId } = await saveProvider(h, 'user-a', protocol)
        const bytes = fixture(`sse/${protocol}/${name}.sse`)
        fetchMock.mockResolvedValue(new Response(streamOf(new Uint8Array(bytes), name === 'chinese' ? 1 : bytes.length)))
        const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
        expect(events[0]).toMatchObject({ kind: 'accepted', conversationId: expect.any(String) })
        const deltas = events.filter((event) => event.kind === 'text_delta').map((event) => event.text).join('')
        expect(deltas).toBe(want.text)
        const end = events.at(-1)!
        expect(events.filter((event) => event.kind === 'end')).toHaveLength(1)
        expect(end.status).toBe(want.status)
        if (want.status === 'completed') {
          expect(events.find((event) => event.kind === 'usage')).toMatchObject({ inputTokens: want.inputTokens, outputTokens: want.outputTokens })
        } else {
          expect(end.error).toMatchObject({
            code: want.errorCode,
            details: { reason: 'stream_error' },
          })
        }
        const [, init] = fetchMock.mock.calls[0]!
        expect(init).toMatchObject({ headers: { authorization: `Bearer ${KEY}` }, redirect: 'manual' })
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, model: 'm1' })
      })
    }
  }
})

type ProviderDto = { id: string; name: string; endpoints: { id: string; slug: string; hasKey: boolean; keyMasked: string | null; keyReadable: boolean; probeUrl: string; models: unknown[] }[] }

describe('provider routes', () => {
  it('saves, keeps, sets and clears keys with masked output', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    let { body } = await h.json<ProviderDto[]>('user-a', 'GET', '/providers')
    expect(body).toMatchObject([
      {
        id: providerId,
        name: 'Acme',
        endpoints: [
          {
            id: endpointId,
            slug: 'main',
            baseUrl: 'https://api.example.com',
            protocol: 'openai-chat',
            hasKey: true,
            keyReadable: true,
            models: [chatModel('m1')],
          },
        ],
      },
    ])
    const endpoint = { id: endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', models: [chatModel('m1')] }
    expect(JSON.stringify(body)).not.toContain(KEY)
    ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [endpoint] }))
    expect(body[0]!.endpoints[0]).toMatchObject({ hasKey: true, keyReadable: true })
    ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [{ ...endpoint, apiKey: 'sk-other-0123456789' }] }))
    expect(body[0]!.endpoints[0]).toMatchObject({ hasKey: true, keyReadable: true })
    ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [{ ...endpoint, apiKey: '' }] }))
    expect(body[0]!.endpoints[0]).toMatchObject({ hasKey: false, keyMasked: null, keyReadable: true })
  })

  it('validates with Aether reasons', async () => {
    const h = await createHarness()
    const bad = (endpoints: unknown[], name = 'Acme') => h.json('user-a', 'PUT', '/providers', { name, endpoints })
    const ep = { slug: 'main', baseUrl: 'https://a.example.com', protocol: 'openai-chat', models: [] }
    expect(await bad([], ' ')).toMatchObject({ status: 400, body: { error: { code: 'bad_request', details: { field: 'name', reason: 'out_of_range', limit: 80 } } } })
    expect(await bad([{ ...ep, slug: 'Main' }])).toMatchObject({ body: { error: { details: { field: 'slug', reason: 'invalid_slug' } } } })
    expect(await bad([ep, ep])).toMatchObject({ body: { error: { details: { field: 'slug', reason: 'duplicate' } } } })
    expect(await bad([{ ...ep, baseUrl: 'ftp://x' }])).toMatchObject({ body: { error: { details: { field: 'baseUrl', reason: 'invalid_url' } } } })
    expect(await bad([{ ...ep, models: [chatModel('a'), chatModel('a')] }])).toMatchObject({ body: { error: { details: { field: 'models', reason: 'duplicate' } } } })
    expect(await bad([{ ...ep, id: 'unknown' }])).toMatchObject({ status: 404, body: { error: { code: 'not_found', details: { entity: 'endpoint' } } } })
  })

  it('deletes providers, returns remaining and clears role bindings', async () => {
    const h = await createHarness()
    const first = await saveProvider(h)
    const second = await saveProvider(h)
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')").bind(first.endpointId).run()
    const { body } = await h.json<ProviderDto[]>('user-a', 'DELETE', `/providers/${first.providerId}`)
    expect(body.map((provider) => provider.id)).toEqual([second.providerId])
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_roles').first('n')).toBe(0)
    expect(await h.json('user-a', 'DELETE', `/providers/${first.providerId}`)).toMatchObject({ status: 404, body: { error: { details: { entity: 'provider' } } } })
  })

  it('filters model options and labels them', async () => {
    const h = await createHarness()
    await h.json('user-a', 'PUT', '/providers', {
      name: 'Acme',
      endpoints: [
        {
          slug: 'main',
          baseUrl: 'https://a.example.com',
          protocol: 'openai-chat',
          models: [{ ...chatModel('m1'), supportsTools: true }, { ...chatModel('e1'), modelType: 'embedding' }, chatModel('m2')],
        },
      ],
    })
    const all = await h.json<{ modelId: string; label: string }[]>('user-a', 'GET', '/model-options')
    expect(all.body.map((option) => option.label)).toEqual(['Acme · main · m1', 'Acme · main · e1', 'Acme · main · m2'])
    const chat = await h.json<{ modelId: string }[]>('user-a', 'GET', '/model-options?modelType=chat&supportsTools=true')
    expect(chat.body.map((option) => option.modelId)).toEqual(['m1'])
    const untooled = await h.json<{ modelId: string }[]>('user-a', 'GET', '/model-options?supportsTools=false')
    expect(untooled.body).toEqual([])
  })

  it('probes drafts with inferred models and reports blocked or missing keys as results', async () => {
    const h = await createHarness()
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'gpt-4o' }, { id: 'claude-x' }, { id: 'gpt-4o' }] }))
    const ok = await h.json<{ models: { id: string; group: string | null }[]; error: unknown }>('user-a', 'POST', '/probe', {
      kind: 'draft',
      baseUrl: 'https://api.example.com/',
      protocol: 'anthropic-messages',
      apiKey: KEY,
    })
    expect(ok.body).toMatchObject({ probeUrl: 'https://api.example.com/v1/models', error: null, models: [{ id: 'claude-x', group: 'claude' }, { id: 'gpt-4o', group: 'gpt' }] })
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'manual', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' } })
    const missing = await h.json('user-a', 'POST', '/probe', { kind: 'draft', baseUrl: 'https://api.example.com', protocol: 'openai-chat' })
    expect(missing.body).toMatchObject({ models: [], error: { kind: 'missing_key' } })
    const blocked = await h.json('user-a', 'POST', '/probe', { kind: 'draft', baseUrl: 'https://10.0.0.1', protocol: 'openai-chat', apiKey: KEY })
    expect(blocked.body).toMatchObject({ error: { kind: 'blocked_address' } })
    fetchMock.mockResolvedValue(new Response('denied sk-test-abcdefghijklmnop', { status: 401 }))
    const denied = await h.json('user-a', 'POST', '/probe', { kind: 'draft', baseUrl: 'https://api.example.com', protocol: 'openai-chat', apiKey: KEY })
    expect(denied.body).toMatchObject({ error: { kind: 'unauthorized', status: 401 } })
    expect(JSON.stringify(denied.body)).not.toContain(KEY)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

const textStream = (text: string) =>
  new Response(
    streamOf(
      new TextEncoder().encode(
        `data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n`,
      ),
    ),
  )

type ConversationDto = { summary: { id: string; title: string; scope: string | null }; turns: { status: string; input: string; text: string; modelId: string | null; errorCode: string | null }[] }

describe('run and history routes', () => {
  it('rejects a run without a model before acceptance and writes no turn', async () => {
    const h = await createHarness()
    const { response, text } = await run(h, {})
    expect(response.status).toBe(409)
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'needs_config', details: { reason: 'model' } } })
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects skills and unknown purposes', async () => {
    const h = await createHarness()
    expect(JSON.parse((await run(h, { skills: [{ id: 's', revision: 1 }] })).text)).toMatchObject({ error: { code: 'unsupported', details: { reason: 'skills' } } })
    expect(JSON.parse((await run(h, { purpose: 'polish' })).text)).toMatchObject({ error: { code: 'bad_request', details: { field: 'purpose', reason: 'unsupported' } } })
  })

  it('creates a conversation, continues it with history, regenerates, renames and deletes', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')").bind(endpointId).run()
    fetchMock.mockImplementation(async () => textStream('Hi!'))
    const first = await run(h, { input: 'Line one\r\nline two that is long enough to be cut at forty chars', scope: 'global' })
    const conversationId = String(first.events[0]!.conversationId)
    const list = await h.json<{ id: string; title: string; scope: string }[]>('user-a', 'GET', '/conversations?scope=global')
    expect(list.body).toMatchObject([{ id: conversationId, title: 'Line oneline two that is long enough to ', scope: 'global' }])
    expect((await h.json<unknown[]>('user-a', 'GET', '/conversations?scope=other')).body).toEqual([])

    await run(h, { input: 'Second', conversationId, scope: 'global' })
    const sent = JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)) as { messages: unknown[] }
    expect(sent.messages.slice(1)).toEqual([
      { role: 'user', content: 'Line one\r\nline two that is long enough to be cut at forty chars' },
      { role: 'assistant', content: 'Hi!' },
      { role: 'user', content: 'Second' },
    ])

    fetchMock.mockImplementation(async () => textStream('Again'))
    const again = await run(h, { input: '', conversationId, scope: 'global', regenerate: true })
    expect(again.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const loaded = await h.json<ConversationDto>('user-a', 'GET', `/conversations/${conversationId}`)
    expect(loaded.body.turns).toMatchObject([
      { id: expect.any(String), status: 'completed', input: 'Line one\r\nline two that is long enough to be cut at forty chars', text: 'Hi!', modelId: 'm1', errorCode: null },
      { id: expect.any(String), status: 'completed', input: 'Second', text: 'Again', modelId: 'm1', errorCode: null },
    ])
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(2)

    expect((await h.json('user-a', 'PATCH', `/conversations/${conversationId}`, { title: '   ' })).body).toMatchObject({ error: { details: { field: 'title', reason: 'empty' } } })
    expect((await h.json('user-a', 'PATCH', `/conversations/${conversationId}`, { title: ' Renamed ' })).body).toMatchObject({ id: conversationId, title: 'Renamed' })
    expect(await h.json('user-b', 'GET', `/conversations/${conversationId}`)).toMatchObject({ status: 404, body: { error: { details: { entity: 'conversation' } } } })
    expect(await h.json('user-b', 'DELETE', `/conversations/${conversationId}`)).toMatchObject({ status: 404 })
    expect(JSON.parse((await run(h, { input: 'x', conversationId, scope: 'global' }, 'user-b')).text)).toMatchObject({ error: { code: 'not_found', details: { entity: 'conversation' } } })
    expect((await h.json('user-a', 'DELETE', `/conversations/${conversationId}`)).body).toEqual({ ok: true })
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(0)
  })

  it('drops note payload on first and continuing chat in actual loopback requests without losing history', async () => {
    const h = await createHarness()
    const marker = 'CURRENT-NOTE-BODY-NOT-IN-DROPPED-REQUEST'
    await h.env.DB.prepare("INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES ('n1', 'user-a', 'Plan', ?1, 0, 0)").bind(marker).run()
    await h.env.DB.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('setting:ai_allow_private', '1')").run()
    const cert = readFileSync(new URL('./support/ai-loopback-cert.pem', import.meta.url))
    const key = readFileSync(new URL('./support/ai-loopback-key.pem', import.meta.url))
    const seen: { messages: { role: string; content: string }[] }[] = []
    const paths: string[] = []
    const server = createServer({ cert, key }, async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      seen.push(JSON.parse(Buffer.concat(chunks).toString()))
      paths.push(req.url ?? '')
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: {"choices":[{"delta":{"content":"Loopback reply"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing loopback address')
      const baseUrl = `https://127.0.0.1:${address.port}`
      // Node's HTTPS client trusts only this test certificate; responses come from real sockets.
      vi.stubGlobal('fetch', (url: string | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
        const outgoing = httpsRequest(String(url), { method: init?.method, headers: Object.fromEntries(new Headers(init?.headers)), signal: init?.signal ?? undefined, ca: cert }, (incoming) => {
          const chunks: Buffer[] = []
          incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
          incoming.on('error', reject)
          incoming.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500 })))
        })
        outgoing.on('error', reject)
        outgoing.end(init?.body)
      }))
      const provider = await h.json<{ endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
        name: 'Loopback', endpoints: [{ slug: 'main', baseUrl, protocol: 'openai-chat', models: [chatModel('m1')] }],
      })
      expect(provider.status).toBe(200)
      const model = { endpointId: provider.body[0]!.endpoints[0]!.id, modelId: 'm1' }
      const first = await run(h, { model, input: 'First without payload', scope: 'note:n1', context: null })
      expect(first.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const conversationId = String(first.events[0]!.conversationId)
      const included = await run(h, { model, conversationId, input: 'With payload', scope: 'note:n1', context: { kind: 'autonote-note', id: 'n1' } })
      expect(included.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const dropped = await run(h, { model, conversationId, input: 'Continue without payload', scope: 'note:n1', context: null })
      expect(dropped.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      expect(paths).toEqual(['/v1/chat/completions', '/v1/chat/completions', '/v1/chat/completions'])
      expect(JSON.stringify(seen[0])).not.toContain(marker)
      expect(JSON.stringify(seen[1])).toContain(marker)
      expect(JSON.stringify(seen[2])).not.toContain(marker)
      expect(seen[2]!.messages.slice(1)).toEqual([
        { role: 'user', content: 'First without payload' }, { role: 'assistant', content: 'Loopback reply' },
        { role: 'user', content: 'With payload' }, { role: 'assistant', content: 'Loopback reply' },
        { role: 'user', content: 'Continue without payload' },
      ])
      const loaded = await h.json<ConversationDto>('user-a', 'GET', `/conversations/${conversationId}`)
      expect(loaded.body.summary.scope).toBe('note:n1')
      expect(loaded.body.turns.map((turn) => turn.input)).toEqual(['First without payload', 'With payload', 'Continue without payload'])
      expect(await h.env.DB.prepare("SELECT content FROM notes WHERE id = 'n1'").first('content')).toBe(marker)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('keeps note ownership and scope checks with null payload on new and existing chats', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    const model = { endpointId, modelId: 'm1' }
    await h.env.DB.prepare("INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES ('n1', 'user-a', 'Plan', 'Body', 0, 0), ('n2', 'user-a', 'Other', 'Other body', 0, 0), ('foreign', 'user-b', 'Private', 'Private body', 0, 0)").run()
    fetchMock.mockImplementation(async () => textStream('ok'))
    const first = await run(h, { model, scope: 'note:n1', context: null })
    expect(first.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const conversationId = String(first.events[0]!.conversationId)
    const base = { model, scope: 'note:n1', context: null }
    for (const conversation of [{}, { conversationId }]) {
      for (const context of [{ kind: 'autonote-note', id: 'n2' }, { kind: 'other', id: 'n1' }]) {
        expect(JSON.parse((await run(h, { ...base, ...conversation, context })).text)).toMatchObject({ error: { code: 'bad_request', details: { field: 'context', reason: 'conversation_mismatch' } } })
      }
    }
    for (const scope of ['global', 'note:n2', null]) {
      expect(JSON.parse((await run(h, { ...base, conversationId, scope })).text)).toMatchObject({ error: { details: { field: 'scope', reason: 'conversation_mismatch' } } })
    }
    expect(JSON.parse((await run(h, { ...base, conversationId }, 'user-b')).text)).toMatchObject({ error: { code: 'not_found', details: { entity: 'conversation' } } })
    for (const scope of ['note:missing', 'note:foreign']) {
      expect(JSON.parse((await run(h, { ...base, scope })).text)).toMatchObject({ error: { code: 'not_found', details: { entity: 'note' } } })
    }
    await h.env.DB.prepare("UPDATE notes SET user_id = 'user-b' WHERE id = 'n1'").run()
    expect(JSON.parse((await run(h, { ...base, conversationId })).text)).toMatchObject({ error: { code: 'not_found', details: { entity: 'note' } } })
    await h.env.DB.prepare("UPDATE notes SET user_id = 'user-a', deleted_at = 1 WHERE id = 'n1'").run()
    for (const conversation of [{}, { conversationId }]) {
      expect(JSON.parse((await run(h, { ...base, ...conversation })).text)).toMatchObject({ error: { code: 'not_found', details: { entity: 'note' } } })
    }
    const writing = { action: 'polish', noteId: 'n2', selectedText: 'x', beforeText: '', afterText: '', cursorOffset: 0, language: 'en-US', title: 'Other' }
    expect(JSON.parse((await run(h, { model, purpose: 'writing', input: JSON.stringify(writing), scope: 'note:n2:writing', context: null })).text)).toMatchObject({ error: { code: 'bad_request', details: { field: 'context', reason: 'required' } } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(1)
  })

  it('rejects regenerate while the last turn is running and reads stale running turns as interrupted', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    fetchMock.mockImplementation(async () => textStream('ok'))
    const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
    const conversationId = String(events[0]!.conversationId)
    await h.env.DB.prepare("UPDATE ai_chat_turns SET status = 'running'").run()
    const busy = await run(h, { model: { endpointId, modelId: 'm1' }, conversationId, regenerate: true, input: '' })
    expect(JSON.parse(busy.text)).toMatchObject({ error: { code: 'conflict', details: { reason: 'turn_running' } } })
    await h.env.DB.prepare('UPDATE ai_chat_turns SET created_at = 0').run()
    const loaded = await h.json<ConversationDto>('user-a', 'GET', `/conversations/${conversationId}`)
    expect(loaded.body.turns[0]).toMatchObject({ status: 'failed', errorCode: 'interrupted' })
  })

  it('finishes the turn as cancelled when the client disconnects', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    fetchMock.mockImplementation(async (_url, init) => {
      const signal = init?.signal
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'))
            signal?.addEventListener('abort', () => controller.error(new Error('aborted')))
          },
        }),
      )
    })
    const response = await h.call('user-a', 'POST', '/runs', { purpose: 'chat', model: { endpointId, modelId: 'm1' }, skills: [], input: 'Hi', regenerate: false, language: 'en-US' })
    const reader = response.body!.getReader()
    const seen: string[] = []
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      seen.push(new TextDecoder().decode(chunk.value))
      if (seen.join('').includes('partial')) break
    }
    expect(seen.join('')).toContain('partial')
    await reader.cancel()
    await h.settle()
    const turn = await h.env.DB.prepare('SELECT status, messages FROM ai_chat_turns').first<{ status: string; messages: string }>()
    expect(turn).toEqual({ status: 'cancelled', messages: JSON.stringify([{ assistant: { text: 'partial', tool_calls: [] } }]) })
  })

  it('fails before model request when explicit search fails', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')").bind(endpointId).run()
    fetchMock.mockResolvedValue(new Response('search failed', { status: 503 }))
    const { events } = await run(h, { model: { endpointId, modelId: 'm1' }, webSearch: true })
    expect(events.at(-1)).toMatchObject({ kind: 'end', status: 'failed', error: { code: 'upstream', details: { status: 503 } } })
    expect(events.some((event) => event.kind === 'search_start')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await h.env.DB.prepare("SELECT status, error_code AS errorCode FROM ai_chat_turns").first()).toMatchObject({ status: 'failed', errorCode: 'upstream' })
  })

  it('searches the original input on regeneration and sends one model request per run', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')").bind(endpointId).run()
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes('mcp.exa.ai')) {
        const body = JSON.parse(String(init?.body)) as { params: { arguments: { query: string } } }
        return Response.json({ result: { content: [{ text: `Title: ${body.params.arguments.query}\nURL: https://example.com/source\nText: source` }] } })
      }
      return textStream('ok')
    })
    const first = await run(h, { model: { endpointId, modelId: 'm1' }, input: 'original question', webSearch: true })
    const conversationId = String(first.events[0]!.conversationId)
    const regenerated = await run(h, { model: { endpointId, modelId: 'm1' }, input: '', conversationId, regenerate: true, webSearch: true })
    expect(regenerated.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('mcp.exa.ai'))
    expect(searchCalls).toHaveLength(2)
    expect(searchCalls.map(([, init]) => JSON.parse(String(init?.body)).params.arguments.query)).toEqual(['original question', 'original question'])
    expect(fetchMock.mock.calls.filter(([url]) => !String(url).includes('mcp.exa.ai'))).toHaveLength(2)
  })

  it('cancels during pre-search without requesting the model', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')").bind(endpointId).run()
    fetchMock.mockImplementation(async (_url, init) => await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })))
    const response = await h.call('user-a', 'POST', '/runs', { purpose: 'chat', model: { endpointId, modelId: 'm1' }, skills: [], input: 'cancel me', regenerate: false, language: 'en-US', webSearch: true })
    const reader = response.body!.getReader()
    const accepted = await reader.read()
    expect(new TextDecoder().decode(accepted.value)).toContain('accepted')
    await reader.cancel()
    await h.settle()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps upstream HTTP errors to failed end events', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }))
    const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
    expect(events.at(-1)).toEqual({ kind: 'end', status: 'failed', error: { code: 'rate_limited', message: '429: slow down', details: { status: 429 } } })
    expect(events.filter(event => event.kind === 'end')).toHaveLength(1)
    expect(events.filter(event => event.kind === 'context').at(-1)).toMatchObject({ usage: { source: 'unknown', tokens: null } })
    const turn = await h.env.DB.prepare('SELECT status, error_code AS errorCode FROM ai_chat_turns').first()
    expect(turn).toEqual({ status: 'failed', errorCode: 'rate_limited' })
  })

  it('runs writing with note context through the writing role fallback and stores nothing', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare("INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')").bind(endpointId).run()
    await h.env.DB.prepare("INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES ('n1', 'user-a', ' Plan ', 'Body', 0, 0)").run()
    fetchMock.mockImplementation(async () => textStream('Done'))
    const writing = { action: 'polish', noteId: 'n1', selectedText: 'x', beforeText: '', afterText: '', cursorOffset: 0, language: 'en-US', title: 'Plan' }
    const base = { purpose: 'writing', input: JSON.stringify(writing), context: { kind: 'autonote-note', id: 'n1' }, scope: 'note:n1:writing' }
    const { events } = await run(h, base)
    expect(events[0]).toMatchObject({ kind: 'accepted', conversationId: null })
    expect(events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: { content: string }[] }
    expect(sent.messages[0]!.content).toContain(`<context source="AutoNote note n1">\n笔记《Plan》\n\nBody\n</context>`)
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(0)
    expect(JSON.parse((await run(h, { ...base, scope: null })).text)).toMatchObject({ error: { details: { field: 'scope', reason: 'invalid_writing_scope' } } })
    expect(JSON.parse((await run(h, { ...base, context: { kind: 'autonote-note', id: 'n2' } })).text)).toMatchObject({ error: { code: 'not_found', details: { entity: 'note' } } })
  })
})
