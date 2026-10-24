import { readFileSync } from 'node:fs'
import { createServer, request as httpsRequest } from 'node:https'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@ouraihub/aether-ui/ports'
import { initializeDatabase } from '../src/worker/db/schema'
import { beginAction, loadConversation } from '../src/worker/ai/history'
import { executeRun, prepareRun, RunRequestSchema } from '../src/worker/ai/runs'
import { inferModel } from '../src/worker/ai/infer'
import { upstreamFailure } from '../src/worker/ai/kit'
import { resolveModel, withKeys } from '../src/worker/ai/providers'
import { SseParser } from '../src/worker/ai/protocol'
import { hashPassword } from '../src/worker/lib/password'
import { encryptAiKey } from '../src/worker/lib/crypto'
import { addKey, chatModel, createHarness, fixture, frames, streamOf, type Harness } from './support/ai-kit-harness'

const KEY = 'sk-test-abcdefghijklmnop'
const PROTOCOLS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const
const expected = JSON.parse(fixture('sse/expect.json').toString()) as Record<
  string,
  Record<
    string,
    {
      status: string
      text: string
      inputTokens?: number
      outputTokens?: number
      errorCode?: string
      errorMessage?: string
    }
  >
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
    endpoints: [{ slug: 'main', baseUrl: 'https://api.example.com', protocol, models: [chatModel('m1')] }],
  })
  const provider = body.at(-1)!
  const endpointId = provider.endpoints[0]!.id
  await addKey(h, user, endpointId, KEY)
  return { providerId: provider.id, endpointId }
}

async function run(h: Harness, body: Record<string, unknown>, user = 'user-a') {
  const response = await h.call(user, 'POST', '/runs', {
    purpose: 'chat',
    skills: [],
    input: 'Hello there',
    regenerate: false,
    language: 'en-US',
    ...body,
  })
  const text = await response.text()
  await h.settle()
  return {
    response,
    events: response.headers.get('content-type')?.startsWith('text/event-stream') ? frames(text) : [],
    text,
  }
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
    const bytes = new TextEncoder().encode(
      ': ping\r\nid: 1\r\nevent: delta\r\ndata: 你\r\ndata:好\r\n\r\nevent: lonely\n\ndata: tail',
    )
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
        fetchMock.mockResolvedValue(
          new Response(streamOf(new Uint8Array(bytes), name === 'chinese' ? 1 : bytes.length)),
        )
        const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
        expect(events[0]).toMatchObject({ kind: 'accepted', conversationId: expect.any(String) })
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
        expect(init).toMatchObject({ headers: { authorization: `Bearer ${KEY}` }, redirect: 'manual' })
        expect(JSON.parse(String(init?.body))).toMatchObject({ stream: true, model: 'm1' })
      })
    }
  }
})

type ProviderDto = {
  id: string
  name: string
  enabled: boolean
  endpoints: {
    id: string
    slug: string
    keyStrategy?: string
    keys: { id: string; label: string; enabled: boolean; masked: string | null; readable: boolean; exhaustedUntil?: number | null; exhaustedReason?: string | null }[]
    probeUrl: string
    models: unknown[]
  }[]
}

describe('provider routes', () => {
  it('adds, edits, toggles and removes endpoint keys with masked output', async () => {
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
            keys: [{ label: '', enabled: true, masked: 'sk-t****************mnop', readable: true }],
            models: [chatModel('m1')],
          },
        ],
      },
    ])
    expect(JSON.stringify(body)).not.toContain(KEY)
    const firstId = body[0]!.endpoints[0]!.keys[0]!.id
    // Provider saves never touch keys.
    const endpoint = { id: endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', models: [chatModel('m1')] }
    ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [endpoint] }))
    expect(body[0]!.endpoints[0]!.keys).toHaveLength(1)
    expect((await h.json('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [{ ...endpoint, apiKey: 'x' }] })).status).toBe(400)

    ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/endpoint-keys', { endpointId, key: '  sk-other-0123456789 ', label: ' backup ' }))
    expect(body[0]!.endpoints[0]!.keys).toMatchObject([{ id: firstId }, { label: 'backup', enabled: true, masked: 'sk-o***********6789' }])
    const secondId = body[0]!.endpoints[0]!.keys[1]!.id
    ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/endpoint-keys', { endpointId, id: secondId, label: 'spare' }))
    expect(body[0]!.endpoints[0]!.keys[1]).toMatchObject({ label: 'spare', masked: 'sk-o***********6789' })
    ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/endpoint-keys', { endpointId, id: firstId, enabled: false }))
    expect(body[0]!.endpoints[0]!.keys[0]).toMatchObject({ enabled: false, masked: 'sk-t****************mnop' })

    const error = async (input: unknown) => (await h.json<{ error: { code: string; details: unknown } }>('user-a', 'PUT', '/endpoint-keys', input)).body.error
    expect(await error({ endpointId, key: KEY })).toMatchObject({ code: 'bad_request', details: { field: 'apiKey', reason: 'duplicate' } })
    expect(await error({ endpointId, id: secondId, key: ` ${KEY}` })).toMatchObject({ details: { field: 'apiKey', reason: 'duplicate' } })
    expect(await error({ endpointId, key: '   ' })).toMatchObject({ details: { field: 'apiKey', reason: 'empty' } })
    expect(await error({ endpointId })).toMatchObject({ details: { field: 'apiKey', reason: 'empty' } })
    expect(await error({ endpointId, key: 'x'.repeat(4097) })).toMatchObject({ details: { field: 'apiKey', reason: 'too_long' } })
    expect(await error({ endpointId, key: 'sk-label', label: 'x'.repeat(41) })).toMatchObject({ details: { field: 'label', reason: 'too_long' } })
    expect(await error({ endpointId, id: 'missing', label: 'a' })).toMatchObject({ code: 'not_found', details: { entity: 'key' } })
    expect(await error({ endpointId: 'missing', key: 'sk-x' })).toMatchObject({ code: 'not_found', details: { entity: 'endpoint' } })
    // Each key route takes a slot (20 per minute); move the faked clock past the window.
    vi.setSystemTime((clock += 60_000))
    for (let index = 2; index < 16; index++) await addKey(h, 'user-a', endpointId, `sk-many-${index}`)
    vi.setSystemTime((clock += 60_000))
    expect(await error({ endpointId, key: 'sk-many-16' })).toMatchObject({ details: { field: 'keys', reason: 'too_many' } })
    expect((await h.json('user-b', 'PUT', '/endpoint-keys', { endpointId, key: 'sk-b' })).status).toBe(404)

    expect((await h.json('user-b', 'DELETE', `/endpoint-keys/${firstId}`, { endpointId })).status).toBe(404)
    ;({ body } = await h.json<ProviderDto[]>('user-a', 'DELETE', `/endpoint-keys/${firstId}`, { endpointId }))
    expect(body[0]!.endpoints[0]!.keys.map((key) => key.id)).not.toContain(firstId)
    expect((await h.json('user-a', 'DELETE', `/endpoint-keys/${firstId}`, { endpointId })).status).toBe(404)
  })
  it('reveals a key only with the current password', async () => {
    const h = await createHarness()
    await h.env.DB.prepare(
      "INSERT INTO users (id, username, password_hash, login, created_at, last_seen_at) VALUES ('user-a', 'user-a', ?1, 'user-a', 0, 0)",
    )
      .bind(await hashPassword('correct-password'))
      .run()
    await saveProvider(h)
    const { body } = await h.json<ProviderDto[]>('user-a', 'GET', '/providers')
    const keyId = body[0]!.endpoints[0]!.keys[0]!.id
    expect((await h.json('user-a', 'POST', `/endpoint-keys/${keyId}/reveal`, { currentPassword: 'wrong' })).status).toBe(401)
    expect((await h.json('user-a', 'POST', `/endpoint-keys/${keyId}/reveal`, {})).status).toBe(401)
    expect((await h.json('user-b', 'POST', `/endpoint-keys/${keyId}/reveal`, { currentPassword: 'correct-password' })).status).toBe(404)
    expect(await h.json('user-a', 'POST', `/endpoint-keys/${keyId}/reveal`, { currentPassword: 'correct-password' })).toEqual({ status: 200, body: { key: KEY } })
  })
  it('deletes keys with their provider and with dropped endpoints', async () => {
    const h = await createHarness()
    const { providerId } = await saveProvider(h)
    const count = async () => (await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_endpoint_keys').first<{ n: number }>())!.n
    expect(await count()).toBe(1)
    await h.json('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [] })
    expect(await count()).toBe(0)
    const other = await saveProvider(h)
    expect(await count()).toBe(1)
    expect((await h.json('user-a', 'DELETE', `/providers/${other.providerId}`)).status).toBe(200)
    expect(await count()).toBe(0)
  })
  it('saves an endpoint with an empty address and reports missing_url on use', async () => {
    const h = await createHarness()
    const { body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/providers', {
      name: 'Blank',
      endpoints: [{ slug: 'main', baseUrl: '', protocol: 'openai-chat', models: [chatModel('m1')] }],
    })
    const endpointId = body[0]!.endpoints[0]!.id
    await addKey(h, 'user-a', endpointId, KEY)
    const { text } = await run(h, { model: { endpointId, modelId: 'm1' } })
    expect(text).toContain('missing_url')
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('toggles enabled without replacing the provider draft', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    const response = await h.json<ProviderDto[]>('user-a', 'PATCH', `/providers/${providerId}/enabled`, {
      enabled: false,
    })
    expect(response.body[0]).toMatchObject({ id: providerId, enabled: false, name: 'Acme' })
    expect(response.body[0]!.endpoints[0]).toMatchObject({ id: endpointId, slug: 'main', models: [chatModel('m1')] })
    expect((await h.json<ProviderDto[]>('user-a', 'GET', '/providers')).body[0]!.enabled).toBe(false)
    const invalid = await h.json('user-a', 'PATCH', `/providers/${providerId}/enabled`, { enabled: 'false' })
    expect(invalid).toMatchObject({ status: 400, body: { error: { code: 'bad_request' } } })
  })

  it('validates with Aether reasons', async () => {
    const h = await createHarness()
    const bad = (endpoints: unknown[], name = 'Acme') => h.json('user-a', 'PUT', '/providers', { name, endpoints })
    const ep = { slug: 'main', baseUrl: 'https://a.example.com', protocol: 'openai-chat', models: [] }
    expect(await bad([], ' ')).toMatchObject({
      status: 400,
      body: { error: { code: 'bad_request', details: { field: 'name', reason: 'out_of_range', limit: 80 } } },
    })
    expect(await bad([{ ...ep, slug: 'Main' }])).toMatchObject({
      body: { error: { details: { field: 'slug', reason: 'invalid_slug' } } },
    })
    expect(await bad([ep, ep])).toMatchObject({ body: { error: { details: { field: 'slug', reason: 'duplicate' } } } })
    expect(await bad([{ ...ep, baseUrl: 'ftp://x' }])).toMatchObject({
      body: { error: { details: { field: 'baseUrl', reason: 'invalid_url' } } },
    })
    expect(await bad([{ ...ep, models: [chatModel('a'), chatModel('a')] }])).toMatchObject({
      body: { error: { details: { field: 'models', reason: 'duplicate' } } },
    })
    expect(await bad([{ ...ep, id: 'unknown' }])).toMatchObject({
      status: 404,
      body: { error: { code: 'not_found', details: { entity: 'endpoint' } } },
    })
  })

  it('deletes providers, returns remaining and clears role bindings', async () => {
    const h = await createHarness()
    const first = await saveProvider(h)
    const second = await saveProvider(h)
    await h.env.DB.prepare(
      "INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(first.endpointId)
      .run()
    const { body } = await h.json<ProviderDto[]>('user-a', 'DELETE', `/providers/${first.providerId}`)
    expect(body.map((provider) => provider.id)).toEqual([second.providerId])
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_roles').first('n')).toBe(0)
    expect(await h.json('user-a', 'DELETE', `/providers/${first.providerId}`)).toMatchObject({
      status: 404,
      body: { error: { details: { entity: 'provider' } } },
    })
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
          models: [
            { ...chatModel('m1'), supportsTools: true },
            { ...chatModel('e1'), modelType: 'embedding' },
            chatModel('m2'),
          ],
        },
      ],
    })
    const all = await h.json<{ modelId: string; label: string }[]>('user-a', 'GET', '/model-options')
    expect(all.body.map((option) => option.label)).toEqual(['Acme · main · m1', 'Acme · main · e1', 'Acme · main · m2'])
    const chat = await h.json<{ modelId: string }[]>(
      'user-a',
      'GET',
      '/model-options?modelType=chat&supportsTools=true',
    )
    expect(chat.body.map((option) => option.modelId)).toEqual(['m1'])
    const untooled = await h.json<{ modelId: string }[]>('user-a', 'GET', '/model-options?supportsTools=false')
    expect(untooled.body).toEqual([])
  })

  it('probes drafts with inferred models and reports blocked or missing keys as results', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    fetchMock.mockResolvedValue(Response.json({ data: [{ id: 'gpt-4o' }, { id: 'claude-x' }, { id: 'gpt-4o' }] }))
    const ok = await h.json<{ models: { id: string; group: string | null }[]; error: unknown }>(
      'user-a',
      'POST',
      '/probe',
      {
        kind: 'draft',
        baseUrl: 'https://api.example.com/',
        protocol: 'anthropic-messages',
        endpointId,
      },
    )
    expect(ok.body).toMatchObject({
      probeUrl: 'https://api.example.com/v1/models',
      error: null,
      models: [
        { id: 'claude-x', group: 'claude' },
        { id: 'gpt-4o', group: 'gpt' },
      ],
    })
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      redirect: 'manual',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    })
    const missing = await h.json('user-a', 'POST', '/probe', {
      kind: 'draft',
      baseUrl: 'https://api.example.com',
      protocol: 'openai-chat',
    })
    expect(missing.body).toMatchObject({ models: [], error: { kind: 'missing_key' } })
    const blocked = await h.json('user-a', 'POST', '/probe', {
      kind: 'draft',
      baseUrl: 'https://10.0.0.1',
      protocol: 'openai-chat',
      endpointId,
    })
    expect(blocked.body).toMatchObject({ error: { kind: 'blocked_address' } })
    fetchMock.mockResolvedValue(new Response('denied sk-test-abcdefghijklmnop', { status: 401 }))
    const denied = await h.json('user-a', 'POST', '/probe', {
      kind: 'draft',
      baseUrl: 'https://api.example.com',
      protocol: 'openai-chat',
      endpointId,
    })
    expect(denied.body).toMatchObject({ error: { kind: 'unauthorized', status: 401 } })
    expect(JSON.stringify(denied.body)).not.toContain(KEY)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('probes with failover across keys, or with one chosen key', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    const second = await addKey(h, 'user-a', endpointId, 'sk-second-0123456789')
    const sent = (index: number) => (fetchMock.mock.calls[index]![1]!.headers as Record<string, string>).authorization
    fetchMock.mockImplementation(async (_url, init) =>
      (init!.headers as Record<string, string>).authorization === `Bearer ${KEY}` ? new Response('no', { status: 429 }) : Response.json({ data: [{ id: 'gpt-4o' }] }),
    )
    const ok = await h.json('user-a', 'POST', '/probe', { kind: 'saved', endpointId })
    expect(ok.body).toMatchObject({ error: null, models: [{ id: 'gpt-4o' }] })
    expect(fetchMock.mock.calls.map((_, index) => sent(index))).toEqual([`Bearer ${KEY}`, 'Bearer sk-second-0123456789'])
    fetchMock.mockClear()
    const only = await h.json('user-a', 'POST', '/probe', { kind: 'draft', baseUrl: 'https://api.example.com', protocol: 'openai-chat', endpointId, keyId: second })
    expect(only.body).toMatchObject({ error: null })
    expect(fetchMock.mock.calls.map((_, index) => sent(index))).toEqual(['Bearer sk-second-0123456789'])
    const unknown = await h.json('user-a', 'POST', '/probe', { kind: 'draft', baseUrl: 'https://api.example.com', protocol: 'openai-chat', endpointId, keyId: 'nope' })
    expect(unknown).toMatchObject({ status: 404, body: { error: { details: { entity: 'key' } } } })
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

describe('request configuration (docs/36)', () => {
  type Saved = { id: string; endpoints: { id: string; imageBaseUrl: string | null; imageEditBaseUrl: string | null; headers: Record<string, string> }[] }[]
  const put = (h: Harness, providerId: string, endpointId: string, extra: Record<string, unknown>) =>
    h.json<Saved>('user-a', 'PUT', '/providers', {
      id: providerId,
      name: 'Acme',
      endpoints: [{ id: endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', models: [chatModel('m1')], ...extra }],
    })

  it('saves, lists and keeps image base URL and headers when omitted', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    expect((await h.json<Saved>('user-a', 'GET', '/providers')).body[0]!.endpoints[0]).toMatchObject({ imageBaseUrl: null, imageEditBaseUrl: null, headers: {} })
    const saved = await put(h, providerId, endpointId, { imageBaseUrl: ' https://img.example.com ', imageEditBaseUrl: ' https://edit.example.com ', headers: { ' X-Team ': 'blue', 'x-trace': '' } })
    expect(saved).toMatchObject({ status: 200, body: [{ endpoints: [{ imageBaseUrl: 'https://img.example.com', imageEditBaseUrl: 'https://edit.example.com', headers: { 'X-Team': 'blue', 'x-trace': '' } }] }] })
    await put(h, providerId, endpointId, {})
    expect((await h.json<Saved>('user-a', 'GET', '/providers')).body[0]!.endpoints[0]).toMatchObject({
      imageBaseUrl: 'https://img.example.com',
      imageEditBaseUrl: 'https://edit.example.com',
      headers: { 'X-Team': 'blue', 'x-trace': '' },
    })
    const cleared = await put(h, providerId, endpointId, { imageBaseUrl: '  ', imageEditBaseUrl: null, headers: {} })
    expect(cleared.body[0]!.endpoints[0]).toMatchObject({ imageBaseUrl: null, imageEditBaseUrl: null, headers: {} })
  })

  it('rejects invalid image base URLs and headers with Aether reasons', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    const reason = async (extra: Record<string, unknown>) => (await put(h, providerId, endpointId, extra)) as unknown as { status: number; body: { error: { details: unknown } } }
    const bad = (field: string, why: string) => ({ status: 400, body: { error: { details: { field, reason: why } } } })
    expect(await reason({ imageBaseUrl: 'ftp://img' })).toMatchObject(bad('imageBaseUrl', 'invalid_url'))
    expect(await reason({ imageBaseUrl: `https://${'a'.repeat(2048)}` })).toMatchObject(bad('imageBaseUrl', 'invalid_url'))
    expect(await reason({ imageEditBaseUrl: 'ftp://img' })).toMatchObject(bad('imageEditBaseUrl', 'invalid_url'))
    expect(await reason({ imageEditBaseUrl: `https://${'a'.repeat(2048)}` })).toMatchObject(bad('imageEditBaseUrl', 'invalid_url'))
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`x-h${i}`, 'v']))
    expect(await reason({ headers: many })).toMatchObject(bad('headers', 'too_many'))
    for (const headers of [{ 'bad name': 'v' }, { '': 'v' }, { 'x-a': 'v', 'X-A': 'w' }, { 'x-a': 'a\nb' }, { 'x-a': 'v'.repeat(2049) }])
      expect(await reason({ headers }), JSON.stringify(headers).slice(0, 40)).toMatchObject(bad('headers', 'invalid'))
    for (const name of ['Authorization', 'x-api-key', 'Anthropic-Version', 'host', 'Content-Type', 'content-length', 'accept', 'connection', 'transfer-encoding', 'Cookie'])
      expect(await reason({ headers: { [name]: 'v' } }), name).toMatchObject(bad('headers', 'reserved'))
    expect((await h.json<Saved>('user-a', 'GET', '/providers')).body[0]!.endpoints[0]).toMatchObject({ imageBaseUrl: null, imageEditBaseUrl: null, headers: {} })
  })

  it('sends custom headers on chat rounds and probes without overriding system headers', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    await put(h, providerId, endpointId, { headers: { 'X-Team': 'blue' } })
    fetchMock.mockImplementation(async () => textStream('Hi'))
    const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
    expect(events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const chat = new Headers(fetchMock.mock.calls[0]![1]?.headers)
    expect([chat.get('x-team'), chat.get('authorization'), chat.get('content-type')]).toEqual(['blue', `Bearer ${KEY}`, 'application/json'])
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => Response.json({ data: [{ id: 'gpt-4o' }] }))
    await h.json('user-a', 'POST', '/probe', { kind: 'saved', endpointId })
    await h.json('user-a', 'POST', '/probe', { kind: 'draft', baseUrl: 'https://api.example.com', protocol: 'openai-chat', endpointId })
    await h.json('user-a', 'POST', '/probe', { kind: 'draft', baseUrl: 'https://api.example.com', protocol: 'openai-chat' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    for (const [, init] of fetchMock.mock.calls)
      expect(init?.headers).toEqual({ 'X-Team': 'blue', authorization: `Bearer ${KEY}` })
  })
})

type ConversationDto = Conversation

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
    expect(JSON.parse((await run(h, { skills: [{ id: 's', revision: 1 }] })).text)).toMatchObject({
      error: { code: 'unsupported', details: { reason: 'skills' } },
    })
    expect(JSON.parse((await run(h, { purpose: 'polish' })).text)).toMatchObject({
      error: { code: 'bad_request', details: { field: 'purpose', reason: 'unsupported' } },
    })
  })

  it('creates a conversation, continues it with history, regenerates, renames and deletes', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare(
      "INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(endpointId)
      .run()
    fetchMock.mockImplementation(async () => textStream('Hi!'))
    const first = await run(h, {
      input: 'Line one\r\nline two that is long enough to be cut at forty chars',
      scope: 'global',
    })
    const conversationId = String(first.events[0]!.conversationId)
    const list = await h.json<{ id: string; title: string; scope: string }[]>(
      'user-a',
      'GET',
      '/conversations?scope=global',
    )
    expect(list.body).toMatchObject([
      { id: conversationId, title: 'Line oneline two that is long enough to ', scope: 'global' },
    ])
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
      {
        id: expect.any(String),
        status: 'completed',
        input: 'Line one\r\nline two that is long enough to be cut at forty chars',
        text: 'Hi!',
        modelId: 'm1',
        errorCode: null,
      },
      { id: expect.any(String), status: 'completed', input: 'Second', text: 'Hi!', modelId: 'm1', errorCode: null },
      { id: expect.any(String), status: 'completed', input: 'Second', text: 'Again', modelId: 'm1', errorCode: null },
    ])
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(3)

    expect((await h.json('user-a', 'PATCH', `/conversations/${conversationId}`, { title: '   ' })).body).toMatchObject({
      error: { details: { field: 'title', reason: 'empty' } },
    })
    expect(
      (await h.json('user-a', 'PATCH', `/conversations/${conversationId}`, { title: ' Renamed ' })).body,
    ).toMatchObject({ id: conversationId, title: 'Renamed' })
    expect(await h.json('user-b', 'GET', `/conversations/${conversationId}`)).toMatchObject({
      status: 404,
      body: { error: { details: { entity: 'conversation' } } },
    })
    expect(await h.json('user-b', 'DELETE', `/conversations/${conversationId}`)).toMatchObject({ status: 404 })
    expect(JSON.parse((await run(h, { input: 'x', conversationId, scope: 'global' }, 'user-b')).text)).toMatchObject({
      error: { code: 'not_found', details: { entity: 'conversation' } },
    })
    expect((await h.json('user-a', 'DELETE', `/conversations/${conversationId}`)).body).toEqual({ ok: true })
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(0)
  })

  it('allows only one mutation from a shared snapshot and moves the context off a deleted selected candidate', async () => {
    const h = await createHarness(),
      { endpointId } = await saveProvider(h),
      model = { endpointId, modelId: 'm1' }
    fetchMock.mockImplementation(async () => textStream('Original'))
    const first = await run(h, { model }),
      id = String(first.events[0]!.conversationId),
      sourceId = String(first.events[0]!.turnId)
    const retry = await run(h, { model, conversationId: id, retryTurnId: sourceId, input: '' }),
      retryId = String(retry.events[0]!.turnId)
    await h.json('user-a', 'PUT', `/conversations/${id}/selection`, { turnId: retryId })
    const removed = await h.json<Conversation>('user-a', 'DELETE', `/conversations/${id}/turns/${retryId}`)
    expect(removed.body.turns.map((turn) => turn.id)).toEqual([sourceId])
    expect(removed.body.summary.selectedTurnId).toBe(sourceId)
    const snapshot = await loadConversation(h.env.DB, 'user-a', id)
    const outcomes = await Promise.allSettled([
      beginAction(h.env.DB, 'user-a', snapshot, null, 'A', sourceId, null, false),
      beginAction(h.env.DB, 'user-a', snapshot, null, 'B', sourceId, null, false),
    ])
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } })
    expect((await h.json<Conversation>('user-a', 'GET', `/conversations/${id}`)).body.turns).toHaveLength(2)
    const running = await loadConversation(h.env.DB, 'user-a', id)
    await expect(beginAction(h.env.DB, 'user-a', running, null, 'C', sourceId, null, false)).rejects.toMatchObject({
      code: 'conflict',
    })
    expect(await h.json('user-a', 'POST', `/conversations/${id}/fork`, { turnId: sourceId })).toMatchObject({
      status: 409,
    })
    expect(await h.json('user-a', 'DELETE', `/conversations/${id}`)).toMatchObject({ status: 409 })
  })

  it('does not emit End until the finished turn is readable by history', async () => {
    const h = await createHarness(),
      { endpointId } = await saveProvider(h)
    fetchMock.mockImplementation(async () => textStream('Stored before end'))
    const prepared = await prepareRun(
      h.env,
      'user-a',
      RunRequestSchema.parse({
        purpose: 'chat',
        model: { endpointId, modelId: 'm1' },
        skills: [],
        input: 'Q',
        regenerate: false,
        language: 'en-US',
      }),
    )
    const reached = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      db = h.env.DB
    h.env.DB = {
      prepare: db.prepare.bind(db),
      exec: db.exec.bind(db),
      batch: async (statements) => {
        reached.resolve()
        await release.promise
        return db.batch(statements)
      },
    } as D1Database
    const events: { kind: string }[] = []
    const execution = executeRun(h.env, 'user-a', prepared, new AbortController().signal, (event) => events.push(event))
    await reached.promise
    expect(events.some((event) => event.kind === 'end')).toBe(false)
    expect((await loadConversation(db, 'user-a', prepared.turn!.conversationId)).turns[0]!.status).toBe('running')
    release.resolve()
    await execution
    expect(events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
    expect((await loadConversation(db, 'user-a', prepared.turn!.conversationId)).turns[0]).toMatchObject({
      status: 'completed',
      messages: [{ assistant: { text: 'Stored before end' } }],
    })
  })

  it('preserves candidates, chosen ancestry, source model, translation chains and exact branch copies', async () => {
    const h = await createHarness(),
      original = await saveProvider(h),
      alternate = await saveProvider(h)
    const model = { endpointId: original.endpointId, modelId: 'm1' },
      otherModel = { endpointId: alternate.endpointId, modelId: 'm2' }
    await h.json('user-a', 'PUT', '/providers', {
      id: alternate.providerId,
      name: 'Acme',
      endpoints: [
        {
          id: alternate.endpointId,
          slug: 'main',
          baseUrl: 'https://api.example.com',
          protocol: 'openai-chat',
          models: [chatModel('m1'), chatModel('m2')],
        },
      ],
    })
    await h.env.DB.prepare(
      "INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(alternate.endpointId)
      .run()
    fetchMock.mockImplementation(async () => textStream('Original'))
    const first = await run(h, { model, input: 'Question', scope: 'global' })
    const conversationId = String(first.events[0]!.conversationId),
      sourceId = String(first.events[0]!.turnId)
    fetchMock.mockImplementation(async () => textStream('Alternative'))
    const retried = await run(h, { conversationId, scope: 'global', retryTurnId: sourceId, input: 'ignored' })
    const retryId = String(retried.events[0]!.turnId)
    let loaded = (await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body
    expect(loaded.summary.selectedTurnId).toBe(sourceId)
    expect(loaded.turns).toMatchObject([
      {
        id: sourceId,
        parentId: null,
        questionId: sourceId,
        supersedesId: null,
        kind: 'reply',
        text: 'Original',
        endpointId: model.endpointId,
      },
      {
        id: retryId,
        parentId: null,
        questionId: sourceId,
        supersedesId: sourceId,
        kind: 'reply',
        input: 'Question',
        text: 'Alternative',
        endpointId: model.endpointId,
      },
    ])
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body)).messages.slice(1)).toEqual([
      { role: 'user', content: 'Question' },
    ])
    const selected = await h.json<Conversation>('user-a', 'PUT', `/conversations/${conversationId}/selection`, {
      turnId: retryId,
    })
    expect(selected.body.summary).toMatchObject({ id: conversationId, selectedTurnId: retryId })
    fetchMock.mockImplementation(async () => textStream('Next'))
    const next = await run(h, { model, conversationId, scope: 'global', input: 'Next question' })
    const nextId = String(next.events[0]!.turnId)
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).messages.slice(1)).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Alternative' },
      { role: 'user', content: 'Next question' },
    ])
    const swapped = await run(h, { model: otherModel, conversationId, scope: 'global', retryTurnId: nextId, input: '' })
    const swappedId = String(swapped.events[0]!.turnId)
    loaded = (await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body
    expect(loaded.turns.at(-1)).toMatchObject({
      endpointId: alternate.endpointId,
      modelId: 'm2',
      questionId: nextId,
      supersedesId: nextId,
      parentId: retryId,
    })
    expect(loaded.summary.selectedTurnId).toBe(nextId)
    fetchMock.mockImplementation(async () => textStream('Traduit'))
    const translated = await run(h, {
      conversationId,
      scope: 'global',
      translateTurnId: swappedId,
      targetLanguage: ' French ',
      input: '',
    })
    const translatedId = String(translated.events[0]!.turnId)
    loaded = (await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body
    const instruction =
      'Translate the following reply into French. Return only the translation, preserving Markdown formatting.\n\nNext'
    expect(loaded.turns.at(-1)).toMatchObject({
      id: translatedId,
      parentId: swappedId,
      questionId: translatedId,
      kind: 'translation',
      input: instruction,
      endpointId: alternate.endpointId,
    })
    const translatedPrompt = JSON.parse(String(fetchMock.mock.calls[4]![1]?.body)).messages
    expect(translatedPrompt[0]).toMatchObject({
      role: 'system',
      content: expect.stringContaining("AutoNote's note assistant"),
    })
    expect(translatedPrompt.slice(1)).toEqual([
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Alternative' },
      { role: 'user', content: 'Next question' },
      { role: 'assistant', content: 'Next' },
      { role: 'user', content: instruction },
    ])
    const forked = await h.json<Conversation>('user-a', 'POST', `/conversations/${conversationId}/fork`, {
      turnId: translatedId,
    })
    expect(forked.body.summary.id).not.toBe(conversationId)
    expect(forked.body.summary.scope).toBe('global')
    expect(forked.body.turns.map((turn) => turn.text)).toEqual(['Alternative', 'Next', 'Traduit'])
    expect(
      forked.body.turns.every(
        (turn) => !loaded.turns.some((source) => source.id === turn.id || source.questionId === turn.questionId),
      ),
    ).toBe(true)
    expect(forked.body.turns.map((turn) => turn.parentId)).toEqual([
      null,
      forked.body.turns[0]!.id,
      forked.body.turns[1]!.id,
    ])
    expect(forked.body.summary.selectedTurnId).toBe(forked.body.turns[2]!.id)
    expect(forked.body.turns.every((turn) => turn.supersedesId === null)).toBe(true)
    const translatedRetry = await run(h, { conversationId, scope: 'global', retryTurnId: translatedId, input: '' })
    const afterTranslationRetry = (await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body
    expect(afterTranslationRetry.turns.at(-1)).toMatchObject({
      id: String(translatedRetry.events[0]!.turnId),
      kind: 'translation',
      questionId: translatedId,
      parentId: swappedId,
      supersedesId: translatedId,
      input: instruction,
    })
    expect(afterTranslationRetry.summary.selectedTurnId).toBe(translatedId)
    await h.json('user-a', 'DELETE', `/providers/${original.providerId}`)
    expect(
      JSON.parse((await run(h, { conversationId, scope: 'global', retryTurnId: sourceId, input: '' })).text),
    ).toMatchObject({ error: { code: 'needs_config' } })
    expect(
      (
        await run(h, { model: otherModel, conversationId, scope: 'global', retryTurnId: sourceId, input: '' })
      ).events.at(-1),
    ).toMatchObject({ status: 'completed' })
  })

  it('guards edit CAS, dependents, selection, running sources and cross-user access without falsifying usage', async () => {
    const h = await createHarness(),
      { endpointId } = await saveProvider(h),
      model = { endpointId, modelId: 'm1' }
    fetchMock.mockImplementation(async () => textStream('Original'))
    const first = await run(h, { model, input: 'Question' })
    const conversationId = String(first.events[0]!.conversationId),
      sourceId = String(first.events[0]!.turnId)
    const retry = await run(h, { model, conversationId, retryTurnId: sourceId, input: '' })
    const retryId = String(retry.events[0]!.turnId),
      base = `/conversations/${conversationId}`
    for (const [method, path, body] of [
      ['PATCH', `${base}/turns/${retryId}`, { text: 'Edited', expectedText: 'Original' }],
      ['DELETE', `${base}/turns/${retryId}`, undefined],
      ['POST', `${base}/fork`, { turnId: retryId }],
      ['PUT', `${base}/selection`, { turnId: retryId }],
    ] as const)
      expect(await h.json('user-b', method, path, body)).toMatchObject({ status: 404 })
    expect(
      await h.json('user-a', 'PATCH', `${base}/turns/${sourceId}`, { text: 'x', expectedText: 'Original' }),
    ).toMatchObject({ status: 409 })
    expect(
      await h.json('user-a', 'PATCH', `${base}/turns/${retryId}`, { text: 'x', expectedText: 'outdated' }),
    ).toMatchObject({ status: 409 })
    for (const text of [' ', 'x'.repeat(24_001)])
      expect(
        await h.json('user-a', 'PATCH', `${base}/turns/${retryId}`, { text, expectedText: 'Original' }),
      ).toMatchObject({ status: 400 })
    await h.env.DB.prepare("UPDATE ai_chat_turns SET reasoning_text = 'Reason', messages = ?1 WHERE id = ?2")
      .bind(
        JSON.stringify([
          {
            assistant: {
              text: 'Original',
              tool_calls: [],
              reasoning: [{ protocol: 'openai-chat', endpointId, modelId: 'm1', value: 'Reason' }],
            },
          },
        ]),
        retryId,
      )
      .run()
    const edited = await h.json<Conversation>('user-a', 'PATCH', `${base}/turns/${retryId}`, {
      text: '**Edited**',
      expectedText: 'Original',
    })
    expect(edited.body.turns.at(-1)).toMatchObject({
      text: '**Edited**',
      usage: { inputTokens: 3, outputTokens: 2 },
      contextUsage: null,
      reasoningText: '',
      modelId: 'm1',
      input: 'Question',
    })
    expect(
      await h.env.DB.prepare('SELECT messages FROM ai_chat_turns WHERE id = ?1').bind(retryId).first('messages'),
    ).toBe(JSON.stringify([{ assistant: { text: '**Edited**', tool_calls: [] } }]))
    expect(
      await h.json('user-a', 'PATCH', `${base}/turns/${retryId}`, { text: 'x', expectedText: 'Original' }),
    ).toMatchObject({ status: 409 })
    const removed = await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${retryId}`)
    expect(removed.body.turns.map((turn) => turn.id)).toEqual([sourceId])
    const child = await run(h, { model, conversationId, input: 'Child' })
    const childId = String(child.events[0]!.turnId)
    await h.env.DB.prepare("UPDATE ai_chat_turns SET status = 'running' WHERE id = ?1").bind(sourceId).run()
    for (const [method, path, body] of [
      ['PATCH', `${base}/turns/${childId}`, { text: 'x', expectedText: 'Original' }],
      ['DELETE', `${base}/turns/${childId}`, undefined],
      ['POST', `${base}/fork`, { turnId: childId }],
      ['PUT', `${base}/selection`, { turnId: childId }],
    ] as const)
      expect(await h.json('user-a', method, path, body)).toMatchObject({ status: 409 })
  })

  it('deletes any idle reply, reparents later turns, drops translations and moves the context to the newest leaf', async () => {
    const h = await createHarness(),
      { endpointId } = await saveProvider(h),
      model = { endpointId, modelId: 'm1' }
    fetchMock.mockImplementation(async () => textStream('Original'))
    const first = await run(h, { model, input: 'Q1' })
    const conversationId = String(first.events[0]!.conversationId),
      aId = String(first.events[0]!.turnId),
      base = `/conversations/${conversationId}`
    const bId = String((await run(h, { model, conversationId, input: 'Q2' })).events[0]!.turnId)
    const cId = String((await run(h, { model, conversationId, input: 'Q3' })).events[0]!.turnId)
    const reparented = (await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${bId}`)).body
    expect(reparented.turns.map((turn) => [turn.id, turn.parentId])).toEqual([[aId, null], [cId, aId]])
    expect(reparented.summary.selectedTurnId).toBe(cId)
    const retryId = String((await run(h, { model, conversationId, retryTurnId: cId, input: '' })).events[0]!.turnId)
    const candidate = (await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${cId}`)).body
    expect(candidate.summary.selectedTurnId).toBe(retryId)
    expect(candidate.turns.at(-1)).toMatchObject({ id: retryId, parentId: aId, supersedesId: null })
    const only = (await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${retryId}`)).body
    expect(only.turns.map((turn) => turn.id)).toEqual([aId])
    expect(only.summary.selectedTurnId).toBe(aId)
    await run(h, { model, conversationId, translateTurnId: aId, targetLanguage: 'French', input: '' })
    expect((await loadConversation(h.env.DB, 'user-a', conversationId)).turns).toHaveLength(2)
    const empty = (await h.json<Conversation>('user-a', 'DELETE', `${base}/turns/${aId}`)).body
    expect(empty.turns).toEqual([])
    expect(empty.summary.selectedTurnId).toBeNull()
  })

  it('rejects failed or cancelled normal parents without writes but still retries terminal failed sources', async () => {
    const h = await createHarness(),
      { endpointId } = await saveProvider(h),
      model = { endpointId, modelId: 'm1' }
    fetchMock.mockImplementation(async () => textStream('Original'))
    const first = await run(h, { model }),
      conversationId = String(first.events[0]!.conversationId),
      turnId = String(first.events[0]!.turnId)
    for (const status of ['failed', 'cancelled']) {
      await h.env.DB.prepare('UPDATE ai_chat_turns SET status = ?1 WHERE id = ?2').bind(status, turnId).run()
      const before = await loadConversation(h.env.DB, 'user-a', conversationId)
      for (const fields of [{ replyToId: turnId }, {}]) {
        expect(JSON.parse((await run(h, { model, conversationId, input: 'Next', ...fields })).text)).toMatchObject({
          error: { code: 'conflict', details: { reason: 'turn_not_completed' } },
        })
        expect(await loadConversation(h.env.DB, 'user-a', conversationId)).toEqual(before)
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const retried = await run(h, { conversationId, retryTurnId: turnId, input: '' })
    expect(retried.events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
    expect((await loadConversation(h.env.DB, 'user-a', conversationId)).turns).toHaveLength(2)
    for (const status of ['failed', 'cancelled']) {
      await h.env.DB.prepare('UPDATE ai_chat_turns SET status = ?1 WHERE id = ?2').bind(status, turnId).run()
      const translated = await run(h, { conversationId, translateTurnId: turnId, targetLanguage: 'French', input: '' })
      expect(translated.events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
      const prompt = JSON.parse(String(fetchMock.mock.calls.at(-1)![1]?.body)).messages.at(-1).content
      expect(prompt).toBe(
        'Translate the following reply into French. Return only the translation, preserving Markdown formatting.\n\nOriginal',
      )
    }
    await h.env.DB.prepare("UPDATE ai_chat_turns SET messages = '[]' WHERE id = ?1").bind(turnId).run()
    const beforeEmpty = await loadConversation(h.env.DB, 'user-a', conversationId)
    expect(
      JSON.parse((await run(h, { conversationId, translateTurnId: turnId, targetLanguage: 'French', input: '' })).text),
    ).toMatchObject({ error: { code: 'bad_request', details: { field: 'translateTurnId', reason: 'empty_reply' } } })
    expect(await loadConversation(h.env.DB, 'user-a', conversationId)).toEqual(beforeEmpty)
  })

  it('rejects invalid combinations, missing/cyclic/foreign ancestry and graph fields on writing', async () => {
    const h = await createHarness(),
      { endpointId } = await saveProvider(h),
      model = { endpointId, modelId: 'm1' }
    fetchMock.mockImplementation(async () => textStream('ok'))
    const first = await run(h, { model }),
      foreign = await run(h, { model })
    const conversationId = String(first.events[0]!.conversationId),
      turnId = String(first.events[0]!.turnId),
      base = { model, conversationId, input: '' }
    for (const fields of [
      { retryTurnId: turnId, translateTurnId: turnId, targetLanguage: 'French' },
      { retryTurnId: turnId, regenerate: true },
      { translateTurnId: turnId, targetLanguage: 'French', regenerate: true },
      { translateTurnId: turnId },
      { translateTurnId: turnId, targetLanguage: ' ' },
      { translateTurnId: turnId, targetLanguage: 'x'.repeat(81) },
      { retryTurnId: turnId, webSearch: true },
      { retryTurnId: turnId, replyToId: turnId },
      { retryTurnId: 'x'.repeat(129) },
    ])
      expect((await run(h, { ...base, ...fields })).response.status).toBe(400)
    for (const id of ['missing', String(foreign.events[0]!.turnId)]) {
      expect((await run(h, { ...base, retryTurnId: id })).response.status).toBe(404)
      expect((await run(h, { ...base, replyToId: id, input: 'Next' })).response.status).toBe(404)
      expect(await h.json('user-a', 'PUT', `/conversations/${conversationId}/selection`, { turnId: id })).toMatchObject(
        { status: 404 },
      )
    }
    await h.env.DB.prepare('UPDATE ai_chat_turns SET parent_id = id WHERE id = ?1').bind(turnId).run()
    expect((await run(h, { ...base, retryTurnId: turnId })).response.status).toBe(409)
    await h.env.DB.prepare('UPDATE ai_chat_turns SET parent_id = ?1 WHERE id = ?2')
      .bind(String(foreign.events[0]!.turnId), turnId)
      .run()
    expect((await run(h, { ...base, retryTurnId: turnId })).response.status).toBe(404)
    vi.setSystemTime((clock += 120_000))
    for (const field of ['replyToId', 'retryTurnId', 'translateTurnId', 'targetLanguage'])
      expect(JSON.parse((await run(h, { model, purpose: 'writing', input: '{}', [field]: null })).text)).toMatchObject({
        error: { code: 'bad_request', details: { reason: 'writing_actions' } },
      })
    await h.env.DB.prepare('UPDATE ai_chat_turns SET parent_id = NULL, messages = ?1 WHERE id = ?2')
      .bind(JSON.stringify([{ assistant: { text: 'x'.repeat(100_000), tool_calls: [] } }]), turnId)
      .run()
    expect(
      JSON.parse((await run(h, { ...base, translateTurnId: turnId, targetLanguage: 'French' })).text),
    ).toMatchObject({ error: { code: 'bad_request', details: { field: 'input', reason: 'too_long', limit: 100_000 } } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('preserves old linear data through migration and reloads selected ancestry after restart', async () => {
    const h = await createHarness(),
      { endpointId } = await saveProvider(h),
      model = { endpointId, modelId: 'm1' }
    fetchMock.mockImplementation(async () => textStream('Preserved'))
    const first = await run(h, { model, input: 'First', scope: 'global' }),
      conversationId = String(first.events[0]!.conversationId)
    await run(h, { model, conversationId, scope: 'global', input: 'Second' })
    const before = (await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body
    await h.env.DB.exec(
      "DELETE FROM schema_migrations WHERE version = 17; DELETE FROM app_meta WHERE key = 'database-state-v1'",
    )
    for (const column of ['parent_id', 'question_id', 'supersedes_id', 'kind'])
      await h.env.DB.exec(`ALTER TABLE ai_chat_turns DROP COLUMN ${column}`)
    for (const column of ['selected_turn_id', 'revision'])
      await h.env.DB.exec(`ALTER TABLE ai_chat_conversations DROP COLUMN ${column}`)
    const old = h.env.DB
    h.env.DB = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
    await initializeDatabase(h.env)
    const restored = (await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body
    expect(restored).toEqual(before)
    expect(restored.turns.map((turn) => turn.parentId)).toEqual([null, restored.turns[0]!.id])
    await h.json('user-a', 'PUT', `/conversations/${conversationId}/selection`, { turnId: restored.turns[0]!.id })
    const restarted = h.env.DB
    h.env.DB = {
      prepare: restarted.prepare.bind(restarted),
      batch: restarted.batch.bind(restarted),
      exec: restarted.exec.bind(restarted),
    } as D1Database
    await initializeDatabase(h.env)
    await run(h, { model, conversationId, scope: 'global', input: 'After restart' })
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]?.body)).messages.slice(1)).toEqual([
      { role: 'user', content: 'First' },
      { role: 'assistant', content: 'Preserved' },
      { role: 'user', content: 'After restart' },
    ])
    expect((await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body.turns).toHaveLength(3)
  })

  it('migrates a v22 single-key endpoint table to v23 keeping endpoints and dropping the old key', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.exec(
      "DROP TABLE ai_endpoint_keys; ALTER TABLE ai_endpoints ADD COLUMN key_ciphertext TEXT; UPDATE ai_endpoints SET key_ciphertext = 'legacy'; DELETE FROM schema_migrations WHERE version IN (23, 24, 25, 29); DELETE FROM app_meta WHERE key = 'database-state-v1'",
    )
    const old = h.env.DB
    h.env.DB = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
    await initializeDatabase(h.env)
    const columns = (await h.env.DB.prepare('PRAGMA table_info(ai_endpoints)').all<{ name: string }>()).results.map((row) => row.name)
    expect(columns).not.toContain('key_ciphertext')
    expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({ status: 200, body: [{ endpoints: [{ id: endpointId, keys: [], models: [{ id: 'm1' }] }] }] })
    await addKey(h, 'user-a', endpointId, KEY)
  })

  it('upgrades a v23 endpoint table to v24 with empty request configuration', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.exec(
      "ALTER TABLE ai_endpoints DROP COLUMN image_base_url; ALTER TABLE ai_endpoints DROP COLUMN headers; DELETE FROM schema_migrations WHERE version = 24; DELETE FROM app_meta WHERE key = 'database-state-v1'",
    )
    const old = h.env.DB
    h.env.DB = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
    await initializeDatabase(h.env)
    const columns = (await h.env.DB.prepare('PRAGMA table_info(ai_endpoints)').all<{ name: string }>()).results.map((row) => row.name)
    expect(columns).toEqual(expect.arrayContaining(['image_base_url', 'headers']))
    expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({
      status: 200,
      body: [{ endpoints: [{ id: endpointId, imageBaseUrl: null, headers: {}, keys: [{ masked: expect.any(String) }] }] }],
    })
  })

  it('upgrades a v24 endpoint table to v25 with no image edit base URL', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.exec(
      "ALTER TABLE ai_endpoints DROP COLUMN image_edit_base_url; DELETE FROM schema_migrations WHERE version = 25; DELETE FROM app_meta WHERE key = 'database-state-v1'",
    )
    const old = h.env.DB
    h.env.DB = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
    await initializeDatabase(h.env)
    const columns = (await h.env.DB.prepare('PRAGMA table_info(ai_endpoints)').all<{ name: string }>()).results.map((row) => row.name)
    expect(columns).toContain('image_edit_base_url')
    expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({ status: 200, body: [{ endpoints: [{ id: endpointId, imageEditBaseUrl: null }] }] })
  })

  it('upgrades a v28 endpoint to v29 keeping rotation and its keys usable', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.exec(
      "ALTER TABLE ai_endpoints DROP COLUMN key_strategy; ALTER TABLE ai_endpoint_keys DROP COLUMN exhausted_until; ALTER TABLE ai_endpoint_keys DROP COLUMN exhausted_reason; DELETE FROM schema_migrations WHERE version = 29; DELETE FROM app_meta WHERE key = 'database-state-v1'",
    )
    const old = h.env.DB
    h.env.DB = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
    await initializeDatabase(h.env)
    expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({
      status: 200,
      body: [{ endpoints: [{ id: endpointId, keyStrategy: 'round_robin', keys: [{ readable: true, exhaustedUntil: null, exhaustedReason: null }] }] }],
    })
  })

  it('stores provider model notes, keeps them when omitted and rejects oversized notes', async () => {
    const h = await createHarness()
    const { providerId } = await saveProvider(h)
    const put = (extra: Record<string, unknown>) =>
      h.json<{ notes: string }[]>('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [], ...extra })
    expect((await put({ notes: '## 价格\n- 便宜' })).body[0]?.notes).toBe('## 价格\n- 便宜')
    expect((await put({})).body[0]?.notes).toBe('## 价格\n- 便宜')
    expect(await put({ notes: 'x'.repeat(10_001) })).toMatchObject({ status: 400 })
    expect((await h.json<{ notes: string }[]>('user-a', 'GET', '/providers')).body[0]?.notes).toBe('## 价格\n- 便宜')
  })

  it('seeds a host preset once per user, adopts a same-named provider and refuses to delete presets', async () => {
    const h = await createHarness()
    type Listed = { id: string; name: string; presetId: string | null; enabled: boolean }[]
    const seed = (user: string, name: string, presetId: string) =>
      h.json<Listed>(user, 'PUT', '/providers', { name, presetId, enabled: false, endpoints: [{ slug: 'ep-1', baseUrl: 'https://api.qnaigc.com', protocol: 'openai-chat', models: [] }] })
    const first = await seed('user-a', '七牛云', 'qiniu')
    expect(first.body).toMatchObject([{ name: '七牛云', presetId: 'qiniu', enabled: false }])
    expect((await seed('user-a', '七牛云', 'qiniu')).body).toHaveLength(1)
    expect(await h.json('user-a', 'DELETE', `/providers/${first.body[0]!.id}`)).toMatchObject({ status: 409 })
    expect((await h.json<Listed>('user-a', 'GET', '/providers')).body).toHaveLength(1)
    expect((await seed('user-b', '七牛云', 'qiniu')).body).toMatchObject([{ presetId: 'qiniu' }])
    const own = (await h.json<Listed>('user-a', 'PUT', '/providers', { name: 'Fenno', endpoints: [] })).body.find((p) => p.name === 'Fenno')!
    const adopted = (await seed('user-a', 'fenno', 'fenno')).body
    expect(adopted).toHaveLength(2)
    expect(adopted.find((p) => p.id === own.id)).toMatchObject({ name: 'Fenno', presetId: 'fenno' })
  })

  it('drops note payload on first and continuing chat in actual loopback requests without losing history', async () => {
    const h = await createHarness()
    const marker = 'CURRENT-NOTE-BODY-NOT-IN-DROPPED-REQUEST'
    await h.env.DB.prepare(
      "INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES ('n1', 'user-a', 'Plan', ?1, 0, 0)",
    )
      .bind(marker)
      .run()
    await h.env.DB.prepare(
      "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('setting:ai_allow_private', '1')",
    ).run()
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
      res.end(
        'data: {"choices":[{"delta":{"content":"Loopback reply"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('missing loopback address')
      const baseUrl = `https://127.0.0.1:${address.port}`
      // Node's HTTPS client trusts only this test certificate; responses come from real sockets.
      vi.stubGlobal(
        'fetch',
        (url: string | URL, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            const outgoing = httpsRequest(
              String(url),
              {
                method: init?.method,
                headers: Object.fromEntries(new Headers(init?.headers)),
                signal: init?.signal ?? undefined,
                ca: cert,
              },
              (incoming) => {
                const chunks: Buffer[] = []
                incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
                incoming.on('error', reject)
                incoming.on('end', () =>
                  resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode ?? 500 })),
                )
              },
            )
            outgoing.on('error', reject)
            outgoing.end(init?.body)
          }),
      )
      const provider = await h.json<{ endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
        name: 'Loopback',
        endpoints: [{ slug: 'main', baseUrl, protocol: 'openai-chat', models: [chatModel('m1')] }],
      })
      expect(provider.status).toBe(200)
      const model = { endpointId: provider.body[0]!.endpoints[0]!.id, modelId: 'm1' }
      const first = await run(h, { model, input: 'First without payload', scope: 'note:n1', context: null })
      expect(first.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const conversationId = String(first.events[0]!.conversationId)
      const included = await run(h, {
        model,
        conversationId,
        input: 'With payload',
        scope: 'note:n1',
        context: { kind: 'autonote-note', id: 'n1' },
      })
      expect(included.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const dropped = await run(h, {
        model,
        conversationId,
        input: 'Continue without payload',
        scope: 'note:n1',
        context: null,
      })
      expect(dropped.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      expect(paths).toEqual(['/v1/chat/completions', '/v1/chat/completions', '/v1/chat/completions'])
      expect(JSON.stringify(seen[0])).not.toContain(marker)
      expect(JSON.stringify(seen[1])).toContain(marker)
      expect(JSON.stringify(seen[2])).not.toContain(marker)
      expect(seen[2]!.messages.slice(1)).toEqual([
        { role: 'user', content: 'First without payload' },
        { role: 'assistant', content: 'Loopback reply' },
        { role: 'user', content: 'With payload' },
        { role: 'assistant', content: 'Loopback reply' },
        { role: 'user', content: 'Continue without payload' },
      ])
      const loaded = await h.json<ConversationDto>('user-a', 'GET', `/conversations/${conversationId}`)
      expect(loaded.body.summary.scope).toBe('note:n1')
      expect(loaded.body.turns.map((turn) => turn.input)).toEqual([
        'First without payload',
        'With payload',
        'Continue without payload',
      ])
      expect(await h.env.DB.prepare("SELECT content FROM notes WHERE id = 'n1'").first('content')).toBe(marker)
      const sourceId = String(included.events[0]!.turnId)
      const retried = await run(h, {
        conversationId,
        scope: 'note:n1',
        retryTurnId: sourceId,
        input: '',
        context: null,
      })
      const retryId = String(retried.events[0]!.turnId)
      expect(retried.events.at(-1)).toMatchObject({ status: 'completed' })
      expect(seen[3]!.messages.slice(1)).toEqual([
        { role: 'user', content: 'First without payload' },
        { role: 'assistant', content: 'Loopback reply' },
        { role: 'user', content: 'With payload' },
      ])
      expect(JSON.stringify(seen[3])).not.toContain(marker)
      await h.json('user-a', 'PUT', `/conversations/${conversationId}/selection`, { turnId: retryId })
      const translated = await run(h, {
        conversationId,
        scope: 'note:n1',
        translateTurnId: retryId,
        targetLanguage: 'French',
        input: '',
        context: { kind: 'autonote-note', id: 'n1' },
      })
      expect(translated.events.at(-1)).toMatchObject({ status: 'completed' })
      expect(JSON.stringify(seen[4])).toContain(marker)
      expect(seen[4]!.messages.at(-2)).toEqual({ role: 'assistant', content: 'Loopback reply' })
      expect(seen[4]!.messages.at(-1)?.content).toBe(
        'Translate the following reply into French. Return only the translation, preserving Markdown formatting.\n\nLoopback reply',
      )
      const final = (await h.json<Conversation>('user-a', 'GET', `/conversations/${conversationId}`)).body
      expect(final.turns).toHaveLength(5)
      expect(final.turns[3]).toMatchObject({
        parentId: String(first.events[0]!.turnId),
        supersedesId: sourceId,
        questionId: sourceId,
      })
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
    }
  })

  it('keeps note ownership and scope checks with null payload on new and existing chats', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    const model = { endpointId, modelId: 'm1' }
    await h.env.DB.prepare(
      "INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES ('n1', 'user-a', 'Plan', 'Body', 0, 0), ('n2', 'user-a', 'Other', 'Other body', 0, 0), ('foreign', 'user-b', 'Private', 'Private body', 0, 0)",
    ).run()
    fetchMock.mockImplementation(async () => textStream('ok'))
    const first = await run(h, { model, scope: 'note:n1', context: null })
    expect(first.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const conversationId = String(first.events[0]!.conversationId)
    const base = { model, scope: 'note:n1', context: null }
    for (const conversation of [{}, { conversationId }]) {
      for (const context of [
        { kind: 'autonote-note', id: 'n2' },
        { kind: 'other', id: 'n1' },
      ]) {
        expect(JSON.parse((await run(h, { ...base, ...conversation, context })).text)).toMatchObject({
          error: { code: 'bad_request', details: { field: 'context', reason: 'conversation_mismatch' } },
        })
      }
    }
    for (const scope of ['global', 'note:n2', null]) {
      expect(JSON.parse((await run(h, { ...base, conversationId, scope })).text)).toMatchObject({
        error: { details: { field: 'scope', reason: 'conversation_mismatch' } },
      })
    }
    expect(JSON.parse((await run(h, { ...base, conversationId }, 'user-b')).text)).toMatchObject({
      error: { code: 'not_found', details: { entity: 'conversation' } },
    })
    for (const scope of ['note:missing', 'note:foreign']) {
      expect(JSON.parse((await run(h, { ...base, scope })).text)).toMatchObject({
        error: { code: 'not_found', details: { entity: 'note' } },
      })
    }
    await h.env.DB.prepare("UPDATE notes SET user_id = 'user-b' WHERE id = 'n1'").run()
    expect(JSON.parse((await run(h, { ...base, conversationId })).text)).toMatchObject({
      error: { code: 'not_found', details: { entity: 'note' } },
    })
    await h.env.DB.prepare("UPDATE notes SET user_id = 'user-a', deleted_at = 1 WHERE id = 'n1'").run()
    for (const conversation of [{}, { conversationId }]) {
      expect(JSON.parse((await run(h, { ...base, ...conversation })).text)).toMatchObject({
        error: { code: 'not_found', details: { entity: 'note' } },
      })
    }
    const writing = {
      action: 'polish',
      noteId: 'n2',
      selectedText: 'x',
      beforeText: '',
      afterText: '',
      cursorOffset: 0,
      language: 'en-US',
      title: 'Other',
    }
    expect(
      JSON.parse(
        (
          await run(h, {
            model,
            purpose: 'writing',
            input: JSON.stringify(writing),
            scope: 'note:n2:writing',
            context: null,
          })
        ).text,
      ),
    ).toMatchObject({ error: { code: 'bad_request', details: { field: 'context', reason: 'required' } } })
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
    const response = await h.call('user-a', 'POST', '/runs', {
      purpose: 'chat',
      model: { endpointId, modelId: 'm1' },
      skills: [],
      input: 'Hi',
      regenerate: false,
      language: 'en-US',
    })
    const reader = response.body!.getReader()
    const seen: string[] = []
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      seen.push(new TextDecoder().decode(chunk.value))
      if (seen.join('').includes('partial')) break
    }
    expect(seen.join('')).toContain('partial')
    await reader.cancel()
    await h.settle()
    const turn = await h.env.DB.prepare('SELECT status, messages FROM ai_chat_turns').first<{
      status: string
      messages: string
    }>()
    expect(turn).toEqual({
      status: 'cancelled',
      messages: JSON.stringify([{ assistant: { text: 'partial', tool_calls: [] } }]),
    })
  })

  it('fails before model request when explicit search fails', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare(
      "INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(endpointId)
      .run()
    fetchMock.mockResolvedValue(new Response('search failed', { status: 503 }))
    const { events } = await run(h, { model: { endpointId, modelId: 'm1' }, webSearch: true })
    expect(events.at(-1)).toMatchObject({
      kind: 'end',
      status: 'failed',
      error: { code: 'upstream', details: { status: 503 } },
    })
    expect(events.some((event) => event.kind === 'search_start')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(await h.env.DB.prepare('SELECT status, error_code AS errorCode FROM ai_chat_turns').first()).toMatchObject({
      status: 'failed',
      errorCode: 'upstream',
    })
  })

  it('searches the original input on regeneration and sends one model request per run', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare(
      "INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(endpointId)
      .run()
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).includes('mcp.exa.ai')) {
        const body = JSON.parse(String(init?.body)) as { params: { arguments: { query: string } } }
        return Response.json({
          result: {
            content: [{ text: `Title: ${body.params.arguments.query}\nURL: https://example.com/source\nText: source` }],
          },
        })
      }
      return textStream('ok')
    })
    const first = await run(h, { model: { endpointId, modelId: 'm1' }, input: 'original question', webSearch: true })
    const conversationId = String(first.events[0]!.conversationId)
    const regenerated = await run(h, {
      model: { endpointId, modelId: 'm1' },
      input: '',
      conversationId,
      regenerate: true,
      webSearch: true,
    })
    expect(regenerated.events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const searchCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes('mcp.exa.ai'))
    expect(searchCalls).toHaveLength(2)
    expect(searchCalls.map(([, init]) => JSON.parse(String(init?.body)).params.arguments.query)).toEqual([
      'original question',
      'original question',
    ])
    expect(fetchMock.mock.calls.filter(([url]) => !String(url).includes('mcp.exa.ai'))).toHaveLength(2)
  })

  it('cancels during pre-search without requesting the model', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare(
      "INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(endpointId)
      .run()
    fetchMock.mockImplementation(
      async (_url, init) =>
        await new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
            once: true,
          }),
        ),
    )
    const response = await h.call('user-a', 'POST', '/runs', {
      purpose: 'chat',
      model: { endpointId, modelId: 'm1' },
      skills: [],
      input: 'cancel me',
      regenerate: false,
      language: 'en-US',
      webSearch: true,
    })
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
    expect(events.at(-1)).toEqual({
      kind: 'end',
      status: 'failed',
      error: { code: 'rate_limited', message: '429: slow down', details: { status: 429 } },
    })
    expect(events.filter((event) => event.kind === 'end')).toHaveLength(1)
    expect(events.filter((event) => event.kind === 'context').at(-1)).toMatchObject({
      usage: { source: 'unknown', tokens: null },
    })
    const turn = await h.env.DB.prepare('SELECT status, error_code AS errorCode FROM ai_chat_turns').first()
    expect(turn).toEqual({ status: 'failed', errorCode: 'rate_limited' })
  })

  it('rotates enabled keys, fails over on 401 before output, and fails when every key is rejected', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    const SECOND = 'sk-second-0123456789'
    const secondId = await addKey(h, 'user-a', endpointId, SECOND)
    const model = { model: { endpointId, modelId: 'm1' } }
    const sent = () => fetchMock.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).authorization)
    fetchMock.mockImplementation(async () => textStream('ok'))
    for (let index = 0; index < 4; index++) await run(h, model)
    expect(sent()).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`, `Bearer ${KEY}`, `Bearer ${SECOND}`])

    fetchMock.mockReset()
    fetchMock.mockImplementation(async (_url, init) =>
      (init!.headers as Record<string, string>).authorization === `Bearer ${KEY}` ? new Response(`bad ${KEY}`, { status: 401 }) : textStream('fallback'),
    )
    const fallback = await run(h, model)
    expect(sent()).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`])
    expect(fallback.events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })

    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => new Response(`denied ${KEY} ${SECOND}`, { status: 401 }))
    const denied = await run(h, model)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(denied.events.at(-1)).toMatchObject({ kind: 'end', status: 'failed', error: { code: 'unauthorized', details: { status: 401 } } })
    expect(denied.text).not.toContain(KEY)
    expect(denied.text).not.toContain(SECOND)

    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => new Response('boom', { status: 500 }))
    await run(h, model)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await h.json('user-a', 'PUT', '/endpoint-keys', { endpointId, id: secondId, enabled: false })
    const { body } = await h.json<ProviderDto[]>('user-a', 'GET', '/providers')
    await h.json('user-a', 'PUT', '/endpoint-keys', { endpointId, id: body[0]!.endpoints[0]!.keys[0]!.id, enabled: false })
    fetchMock.mockReset()
    const missing = await run(h, model)
    expect(missing.text).toContain('missing_key')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fill-first sticks to the first key, sets used-up and rate-limited keys aside, and restores them', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    const SECOND = 'sk-second-0123456789'
    const secondId = await addKey(h, 'user-a', endpointId, SECOND)
    const endpoint = { id: endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', models: [chatModel('m1')] }
    await h.json('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [{ ...endpoint, keyStrategy: 'fill_first' }] })
    const model = { model: { endpointId, modelId: 'm1' } }
    const sent = () => fetchMock.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).authorization)
    const keys = async () => (await h.json<ProviderDto[]>('user-a', 'GET', '/providers')).body[0]!.endpoints[0]!
    const reply = (first: Response) => async (_url: unknown, init?: RequestInit) =>
      (init!.headers as Record<string, string>).authorization === `Bearer ${KEY}` ? first : textStream('ok')

    fetchMock.mockImplementation(async () => textStream('ok'))
    for (let index = 0; index < 3; index++) await run(h, model)
    expect(sent()).toEqual([`Bearer ${KEY}`, `Bearer ${KEY}`, `Bearer ${KEY}`])
    expect((await keys()).keyStrategy).toBe('fill_first')

    // A 5xx without quota wording is not a key problem: no switch, no mark.
    fetchMock.mockReset()
    fetchMock.mockImplementation(reply(new Response('boom', { status: 500 })))
    expect((await run(h, model)).events.at(-1)).toMatchObject({ status: 'failed', error: { code: 'upstream' } })
    expect(sent()).toEqual([`Bearer ${KEY}`])

    // Plain 429: switch, cool down for Retry-After, then the first key is used again.
    fetchMock.mockReset()
    // "rate limit exceeded" / "quota exceeded per minute" are plain rate limits: a cooldown, never the 24-hour pause.
    fetchMock.mockImplementation(reply(new Response('{"error":{"message":"Rate limit exceeded: quota exceeded per minute"}}', { status: 429, headers: { 'retry-after': '30' } })))
    expect((await run(h, model)).events.at(-1)).toMatchObject({ status: 'completed' })
    expect(sent()).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`])
    expect((await keys()).keys[0]).toMatchObject({ exhaustedUntil: clock + 30_000, exhaustedReason: expect.stringMatching(/^HTTP 429 /) })
    vi.setSystemTime((clock += 31_000))
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => textStream('ok'))
    await run(h, model)
    expect(sent()).toEqual([`Bearer ${KEY}`])

    // Quota wording on a 400: set aside for 24 hours and skipped by later requests.
    fetchMock.mockReset()
    fetchMock.mockImplementation(reply(new Response(`{"error":"余额不足 ${KEY}"}`, { status: 400 })))
    expect((await run(h, model)).events.at(-1)).toMatchObject({ status: 'completed' })
    const marked = (await keys()).keys[0]!
    expect(marked).toMatchObject({ exhaustedUntil: clock + 86_400_000 })
    expect(marked.exhaustedReason).toContain('余额不足')
    expect(marked.exhaustedReason).not.toContain(KEY)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => textStream('ok'))
    await run(h, model)
    expect(sent()).toEqual([`Bearer ${SECOND}`])

    // Once streaming started, a later error is the caller's: no switch, no mark.
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => new Response(streamOf(new TextEncoder().encode('data: {"error":{"message":"quota exceeded"}}\n\n')), { headers: { 'content-type': 'text/event-stream' } }))
    expect((await run(h, model)).events.at(-1)).toMatchObject({ status: 'failed' })
    expect(sent()).toEqual([`Bearer ${SECOND}`])
    expect((await keys()).keys[1]).toMatchObject({ exhaustedUntil: null })

    // Every key used up: rate_limited before any upstream call.
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => new Response('denied', { status: 402 }))
    await run(h, model)
    fetchMock.mockReset()
    const exhausted = await run(h, model)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(exhausted.response.status).toBe(429)
    expect(exhausted.text).toContain('keys_exhausted')
    expect(exhausted.text).toContain('Acme · main')

    await h.json('user-a', 'PUT', '/endpoint-keys', { endpointId, id: secondId, restore: true })
    expect((await keys()).keys[1]).toMatchObject({ exhaustedUntil: null, exhaustedReason: null })
    fetchMock.mockImplementation(async () => textStream('ok'))
    await run(h, model)
    expect(sent()).toEqual([`Bearer ${SECOND}`])

    // Switching back to rotation ignores and hides the marks.
    await h.json('user-a', 'PUT', '/providers', { id: providerId, name: 'Acme', endpoints: [{ ...endpoint, keyStrategy: 'round_robin' }] })
    expect((await keys()).keys[0]).toMatchObject({ exhaustedUntil: null, exhaustedReason: null })
    fetchMock.mockReset()
    fetchMock.mockImplementation(async () => textStream('ok'))
    await run(h, model)
    await run(h, model)
    expect(sent().sort()).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`].sort())
  })

  it('fill-first suspends each duplicate credential row and does not retry it on the next request', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    const duplicateId = await addKey(h, 'user-a', endpointId, 'sk-distinct-backup')
    await h.env.DB.prepare('UPDATE ai_endpoint_keys SET key_ciphertext = ?1 WHERE id = ?2')
      .bind(await encryptAiKey(h.env, duplicateId, KEY), duplicateId).run()
    await h.json('user-a', 'PUT', '/providers', {
      id: providerId, name: 'Acme',
      endpoints: [{ id: endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', models: [chatModel('m1')], keyStrategy: 'fill_first' }],
    })
    const connection = await resolveModel(h.env, 'user-a', { endpointId, modelId: 'm1' })
    await expect(withKeys(connection, async () => { throw upstreamFailure(402, 'insufficient balance', [KEY]) })).rejects.toMatchObject({ code: 'upstream' })
    const rows = await h.env.DB.prepare('SELECT exhausted_until AS until FROM ai_endpoint_keys WHERE endpoint_id = ?1').bind(endpointId).all<{ until: number | null }>()
    expect(rows.results.map(row => row.until)).toEqual([clock + 86_400_000, clock + 86_400_000])
    await expect(resolveModel(h.env, 'user-a', { endpointId, modelId: 'm1' })).rejects.toMatchObject({ code: 'rate_limited', details: { reason: 'keys_exhausted' } })
  })

  it('fill-first keeps a set-aside key out of later rounds of the same request and never falls back to no key', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    const SECOND = 'sk-second-0123456789'
    await addKey(h, 'user-a', endpointId, SECOND)
    await h.json('user-a', 'PUT', '/providers', {
      id: providerId,
      name: 'Acme',
      endpoints: [{ id: endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', models: [chatModel('m1')], keyStrategy: 'fill_first' }],
    })
    // One Connection serves every tool round of a run; drive withKeys twice on it like two rounds.
    const connection = await resolveModel(h.env, 'user-a', { endpointId, modelId: 'm1' })
    const tried: (string | null)[] = []
    const round = (failing: (string | null)[]) =>
      withKeys(connection, async (key) => {
        tried.push(key)
        if (failing.includes(key)) throw upstreamFailure(402, 'insufficient balance', [])
        return key
      })
    expect(await round([KEY])).toBe(SECOND)
    expect(await round([])).toBe(SECOND)
    expect(tried).toEqual([KEY, SECOND, SECOND])
    await expect(round([SECOND])).rejects.toMatchObject({ code: 'upstream' })
    await expect(round([])).rejects.toMatchObject({ code: 'rate_limited', details: { reason: 'keys_exhausted' } })
    expect(tried.at(-1)).toBe(SECOND)
  })

  it('fill-first retries the next key when the upstream drops the stream before the first chunk', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    const SECOND = 'sk-second-0123456789'
    await addKey(h, 'user-a', endpointId, SECOND)
    await h.json('user-a', 'PUT', '/providers', {
      id: providerId,
      name: 'Acme',
      endpoints: [{ id: endpointId, slug: 'main', baseUrl: 'https://api.example.com', protocol: 'openai-chat', models: [chatModel('m1')], keyStrategy: 'fill_first' }],
    })
    const dropped = () => new Response(new ReadableStream({ pull: (controller) => controller.error(new TypeError('socket hang up')) }), { headers: { 'content-type': 'text/event-stream' } })
    fetchMock.mockImplementation(async (_url, init) => ((init!.headers as Record<string, string>).authorization === `Bearer ${KEY}` ? dropped() : textStream('ok')))
    const result = await run(h, { model: { endpointId, modelId: 'm1' } })
    expect(result.events.at(-1)).toMatchObject({ kind: 'end', status: 'completed' })
    expect(fetchMock.mock.calls.map(([, init]) => (init!.headers as Record<string, string>).authorization)).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`])
    const { body } = await h.json<ProviderDto[]>('user-a', 'GET', '/providers')
    expect(body[0]!.endpoints[0]!.keys[0]).toMatchObject({ exhaustedUntil: null })
  })

  it('runs writing with note context through the writing role fallback and stores nothing', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare(
      "INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(endpointId)
      .run()
    await h.env.DB.prepare(
      "INSERT INTO notes (id, user_id, title, content, created_at, updated_at) VALUES ('n1', 'user-a', ' Plan ', 'Body', 0, 0)",
    ).run()
    fetchMock.mockImplementation(async () => textStream('Done'))
    const writing = {
      action: 'polish',
      noteId: 'n1',
      selectedText: 'x',
      beforeText: '',
      afterText: '',
      cursorOffset: 0,
      language: 'en-US',
      title: 'Plan',
    }
    const base = {
      purpose: 'writing',
      input: JSON.stringify(writing),
      context: { kind: 'autonote-note', id: 'n1' },
      scope: 'note:n1:writing',
    }
    const { events } = await run(h, base)
    expect(events[0]).toMatchObject({ kind: 'accepted', conversationId: null })
    expect(events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { messages: { content: string }[] }
    expect(sent.messages[0]!.content).toContain(`<context source="AutoNote note n1">\n笔记《Plan》\n\nBody\n</context>`)
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(0)
    expect(JSON.parse((await run(h, { ...base, scope: null })).text)).toMatchObject({
      error: { details: { field: 'scope', reason: 'invalid_writing_scope' } },
    })
    expect(JSON.parse((await run(h, { ...base, context: { kind: 'autonote-note', id: 'n2' } })).text)).toMatchObject({
      error: { code: 'not_found', details: { entity: 'note' } },
    })
  })
})
