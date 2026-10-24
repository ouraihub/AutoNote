import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings } from '../src/worker/env'
import { relayRoutes, relaySettingsRoutes } from '../src/worker/routes/relay'
import { sha256Hex, toBase64Url, utf8 } from '../src/worker/lib/encoding'
import { initializeDatabase } from '../src/worker/db/schema'
import { addKey, chatModel, createHarness, type Harness } from './support/ai-kit-harness'

const fetchMock = vi.fn<typeof fetch>()
let clock = Date.now()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['Date'] })
  clock += 120_000
  vi.setSystemTime(clock)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

function relayApp(h: Harness) {
  const app = new Hono<AppBindings>()
  app.use('/api/*', async (c, next) => {
    c.set('userId', 'user-a')
    c.set('user', { id: 'user-a', username: 'user-a', login: 'user-a', name: 'user-a', avatarUrl: '', role: 'owner', createdAt: 0, settingsRaw: '{}' })
    await next()
  })
  app.route('/api/relay', relaySettingsRoutes)
  app.route('/relay', relayRoutes)
  const request = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    app.request(path, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, h.env)
  const raw = (path: string, init: RequestInit) => app.request(path, init, h.env)
  return { request, raw, json: async <T>(method: string, path: string, body?: unknown) => (await (await request(method, path, body)).json()) as T }
}

async function provider(h: Harness, name: string, baseUrl: string, key: string, models = ['m1'], protocol = 'openai-chat', image = false) {
  const { body } = await h.json<{ name: string; endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
    name,
    endpoints: [{ slug: 'main', baseUrl, protocol, models: models.map((id) => ({ ...chatModel(id), ...(image ? { modelType: 'image' } : {}) })) }],
  })
  const endpointId = body.find((item) => item.name === name)!.endpoints[0]!.id
  await addKey(h, 'user-a', endpointId, key)
  return endpointId
}

async function setup() {
  const h = await createHarness()
  const relay = relayApp(h)
  const { token } = await relay.json<{ token: string }>('POST', '/api/relay/keys', { name: 'omp' })
  const auth = { authorization: `Bearer ${token}` }
  return { h, relay, token, auth }
}

const sentAuth = (index: number) => (fetchMock.mock.calls[index]![1]!.headers as Record<string, string>).authorization

describe('relay access keys and pause switch', () => {
  it('rejects bad keys, stays paused until enabled, then forwards; revoked keys stop working', async () => {
    const { h, relay, token, auth } = await setup()
    await provider(h, 'Acme', 'https://acme.example.com', 'sk-acme-0123456789')
    expect(token).toMatch(/^anr_[A-Za-z0-9_-]{43}$/)
    const chat = (headers: Record<string, string>) => relay.request('POST', '/relay/v1/chat/completions', { model: 'm1', messages: [] }, headers)

    expect((await chat({ authorization: 'Bearer anr_wrong' })).status).toBe(401)
    const paused = await chat(auth)
    expect(paused.status).toBe(503)
    expect(await paused.json()).toMatchObject({ error: { type: 'relay_paused' } })
    expect(fetchMock).not.toHaveBeenCalled()

    await relay.request('PUT', '/api/relay', { enabled: true })
    fetchMock.mockResolvedValue(new Response('data: {}\n\n', { headers: { 'content-type': 'text/event-stream' } }))
    const ok = await chat({ 'x-api-key': token })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toBe('text/event-stream')
    expect(await ok.text()).toBe('data: {}\n\n')

    const settings = await relay.json<{ enabled: boolean; endpoint: string; keys: { id: string; todayRequests: number; lastUsedAt: number | null }[] }>('GET', '/api/relay')
    expect(settings).toMatchObject({ enabled: true, endpoint: expect.stringMatching(/\/relay\/v1$/) })
    // The paused and the forwarded request were authenticated; the bad key was not.
    expect(settings.keys[0]).toMatchObject({ todayRequests: 2 })
    expect(settings.keys[0]!.lastUsedAt).not.toBeNull()

    await relay.request('DELETE', `/api/relay/keys/${settings.keys[0]!.id}`)
    expect((await chat(auth)).status).toBe(401)
  })

  it('keeps a separate atomic manual-key cap and stores only hashes', async () => {
    const { h, relay, token } = await setup()
    const stored = await h.env.DB.prepare('SELECT key_hash FROM relay_access_keys').first<{ key_hash: string }>()
    expect(stored?.key_hash).toBe(await sha256Hex(token))
    await h.env.DB.prepare(`INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at, expires_at, github_run)
      VALUES ('github', 'user-a', 'GitHub', 'github-hash', 0, ?1, 'acme/app#1#1')`).bind(Date.now() + 100_000).run()
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => relay.request('POST', '/api/relay/keys', { name: `manual ${i}` })))
    expect(responses.filter((response) => response.status === 201)).toHaveLength(19)
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1)
    expect((await h.env.DB.prepare('SELECT COUNT(*) AS count FROM relay_access_keys WHERE revoked_at IS NULL').first<{ count: number }>())?.count).toBe(21)
  })

  it('upgrades v29 to v30 without losing provider keys or notes', async () => {
    const { h, relay } = await setup()
    const endpointId = await provider(h, 'Acme', 'https://acme.example.com', 'sk-acme-0123456789')
    await h.env.DB.prepare(`INSERT INTO notes (id, user_id, title, content, excerpt, rev, created_at, updated_at)
      VALUES ('retained', 'user-a', 'Retained', 'content', '', 1, 1, 1)`).run()
    await h.env.DB.exec("DROP TABLE relay_access_keys; DROP TABLE relay_github_repos; DELETE FROM schema_migrations WHERE version = 30; DELETE FROM app_meta WHERE key = 'database-state-v1'")
    const old = h.env.DB
    h.env.DB = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
    await initializeDatabase(h.env)
    expect(await h.env.DB.prepare('SELECT version FROM schema_migrations WHERE version = 30').first()).toEqual({ version: 30 })
    expect(await h.env.DB.prepare("SELECT content FROM notes WHERE id = 'retained'").first()).toEqual({ content: 'content' })
    expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({ body: [{ endpoints: [{ id: endpointId, keys: [{ readable: true }] }] }] })
    const indexes = (await h.env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all<{ name: string }>()).results.map((row) => row.name)
    expect(indexes).toEqual(expect.arrayContaining(['idx_relay_access_keys_user', 'idx_relay_access_keys_expires', 'idx_relay_access_keys_run', 'idx_relay_github_repos_user']))
    expect((await relay.request('POST', '/api/relay/keys', { name: 'after migration' })).status).toBe(201)
    expect((await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'acme/app/.github/workflows/agent.yml' })).status).toBe(200)
  })
})

describe('relay forwarding', () => {
  it('lists models with protocols, finds lines by model or provider/model, and 404s with the available list', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    await provider(h, 'Acme', 'https://acme.example.com', 'sk-acme-0123456789', ['m1', 'shared'])
    await provider(h, 'Beta', 'https://beta.example.com', 'sk-beta-0123456789', ['shared', 'claude-x'], 'anthropic-messages')

    const models = await (await relay.request('GET', '/relay/v1/models', undefined, auth)).json()
    expect(models).toEqual({
      object: 'list',
      data: [
        { id: 'm1', object: 'model', owned_by: 'Acme', protocol: 'openai-chat', model_type: 'chat' },
        { id: 'shared', object: 'model', owned_by: 'Acme', protocol: 'openai-chat', model_type: 'chat' },
        { id: 'shared', object: 'model', owned_by: 'Beta', protocol: 'anthropic-messages', model_type: 'chat' },
        { id: 'claude-x', object: 'model', owned_by: 'Beta', protocol: 'anthropic-messages', model_type: 'chat' },
      ],
    })
    expect((await relay.json<{ protocols: string[] }>('GET', '/api/relay')).protocols).toEqual(['openai-chat', 'anthropic-messages'])

    const missing = await relay.request('POST', '/relay/v1/chat/completions', { model: 'claude-x' }, auth)
    expect(missing.status).toBe(404)
    expect(JSON.stringify(await missing.json())).toContain('available: m1, shared')

    fetchMock.mockResolvedValue(Response.json({ ok: true }))
    const inbound = { ...auth, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'tools-1', cookie: 'secret=1', 'x-forwarded-for': '1.2.3.4' }
    const response = await relay.request('POST', '/relay/v1/messages', { model: 'Beta/shared', max_tokens: 1 }, inbound)
    expect(response.status).toBe(200)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://beta.example.com/v1/messages')
    expect(JSON.parse(String(init!.body))).toEqual({ model: 'shared', max_tokens: 1 })
    expect(init!.headers).toEqual({
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'tools-1',
      'content-type': 'application/json',
      authorization: 'Bearer sk-beta-0123456789',
      'x-api-key': 'sk-beta-0123456789',
    })
  })

  it('advertises and forwards Responses only when a Responses chat model is configured', async () => {
    const { h, relay, auth } = await setup()
    expect((await relay.json<{ protocols: string[] }>('GET', '/api/relay')).protocols).toEqual([])
    await provider(h, 'Responses', 'https://responses.example.com/v1', 'sk-responses-0123456789', ['gpt-x'], 'openai-responses')
    expect((await relay.json<{ protocols: string[] }>('GET', '/api/relay')).protocols).toEqual(['openai-responses'])
    await relay.request('PUT', '/api/relay', { enabled: true })
    fetchMock.mockResolvedValue(Response.json({ output: [] }))
    const response = await relay.request('POST', '/relay/v1/responses', { model: 'gpt-x', input: 'hello' }, auth)
    expect(await response.json()).toEqual({ output: [] })
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://responses.example.com/v1/responses')
    expect(await new Response(fetchMock.mock.calls[0]![1]!.body).json()).toEqual({ model: 'gpt-x', input: 'hello' })
  })
  it('lists image models and forwards generation and multipart edit requests', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    const endpoint = await provider(h, 'Fenno', 'https://api.fenno.ai/v1', 'sk-fenno-0123456789', ['gpt-img'], 'openai-chat', true)
    const fenno = (await h.json<{ id: string }[]>('user-a', 'GET', '/providers')).body.find((item) => item.name === 'Fenno')!
    await h.json('user-a', 'PUT', '/providers', {
      id: fenno.id,
      name: 'Fenno',
      endpoints: [{ id: endpoint, slug: 'main', baseUrl: 'https://api.fenno.ai/v1', protocol: 'openai-chat', models: [{ ...chatModel('gpt-img'), modelType: 'image' }] }],
    })
    const listing = await (await relay.request('GET', '/relay/v1/models', undefined, auth)).json() as { data: { id: string; model_type: string }[] }
    expect(listing.data).toContainEqual({ id: 'gpt-img', object: 'model', owned_by: 'Fenno', protocol: 'openai-chat', model_type: 'image' })

    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] }))
    const generated = await relay.request('POST', '/relay/v1/images/generations', { model: 'gpt-img', prompt: 'a cat' }, auth)
    expect(generated.status).toBe(200)
    expect(await generated.json()).toEqual({ data: [{ b64_json: 'aW1hZ2U=' }] })
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.fenno.ai/v1/images/generations')

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(Response.json({ data: [{ b64_json: 'ZWRpdA==' }] }))
    const form = new FormData()
    form.set('model', 'gpt-img')
    form.set('prompt', 'make it blue')
    form.set('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'input.png')
    const edited = await relay.raw('/relay/v1/images/edits', { method: 'POST', headers: auth, body: form })
    expect(edited.status).toBe(200)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.fenno.ai/v1/images/edits')
    expect(fetchMock.mock.calls[0]![1]!.body).toBeInstanceOf(Uint8Array)
  })

  it('rewrites qualified image models without losing JSON fields or multipart files', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    await provider(h, 'First', 'https://first.example.com', 'sk-first-0123456789', ['vendor/image'], 'openai-chat', true)
    await provider(h, 'Team/Second', 'https://second.example.com', 'sk-second-0123456789', ['vendor/image'], 'openai-chat', true)
    const listing = await (await relay.request('GET', '/relay/v1/models', undefined, auth)).json() as { data: { id: string }[] }
    expect(listing.data.map((entry) => entry.id)).toContain('Team/Second/vendor/image')
    fetchMock.mockImplementation(async () => Response.json({ data: [] }))
    expect((await relay.request('POST', '/relay/v1/images/generations', { model: 'Team/Second/vendor/image', prompt: 'a cat', n: 2 }, auth)).status).toBe(200)
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://second.example.com/v1/images/generations')
    expect(await new Response(fetchMock.mock.calls[0]![1]!.body).json()).toEqual({ model: 'vendor/image', prompt: 'a cat', n: 2 })
    const form = new FormData()
    form.set('model', 'Team/Second/vendor/image')
    form.set('prompt', 'make it blue')
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'input.png')
    form.append('image', new Blob([new Uint8Array([4])], { type: 'image/png' }), 'second.png')
    expect((await relay.raw('/relay/v1/images/edits', { method: 'POST', headers: auth, body: form })).status).toBe(200)
    const [url, init] = fetchMock.mock.calls[1]!
    expect(String(url)).toBe('https://second.example.com/v1/images/edits')
    const sent = await new Request(String(url), init).formData()
    expect(sent.get('model')).toBe('vendor/image')
    expect(sent.get('prompt')).toBe('make it blue')
    const images = sent.getAll('image') as File[]
    expect(images.map((file) => [file.name, file.type])).toEqual([['input.png', 'image/png'], ['second.png', 'image/png']])
    expect(await Promise.all(images.map(async (file) => [...new Uint8Array(await file.arrayBuffer())]))).toEqual([[1, 2, 3], [4]])
  })

  it('bounds image requests and responses, rejects malformed input, and masks upstream errors', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    await provider(h, 'Image', 'https://image.example.com', 'sk-image-0123456789', ['image'], 'openai-chat', true)
    for (const path of ['/relay/v1/images/generations', '/relay/v1/images/edits']) {
      expect((await relay.raw(path, { method: 'POST', headers: auth, body: '{' })).status).toBe(400)
      expect((await relay.request('POST', path, {}, { ...auth, 'content-length': String(10 * 1024 * 1024 + 1) })).status).toBe(413)
      const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) } })
      expect((await relay.raw(path, { method: 'POST', headers: auth, body, duplex: 'half' } as RequestInit)).status).toBe(413)
    }
    expect((await relay.request('POST', '/relay/v1/images/generations', {}, auth)).status).toBe(400)
    expect((await relay.request('POST', '/relay/v1/images/generations', { model: 'missing' }, auth)).status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValueOnce(new Response('bad sk-image-0123456789', { status: 400, headers: { 'content-type': 'text/plain' } }))
    const rejected = await relay.request('POST', '/relay/v1/images/generations', { model: 'image' }, auth)
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toBe('bad ***')
    fetchMock.mockResolvedValueOnce(new Response('x'.repeat(10 * 1024 * 1024 + 1)))
    const oversized = await relay.request('POST', '/relay/v1/images/generations', { model: 'image' }, auth)
    expect(oversized.status).toBe(502)
    expect(await oversized.json()).toMatchObject({ error: { type: 'api_error', message: 'image response exceeds 10 MB' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('moves to the next line when a line is used up, passes other upstream errors through, and never sends the body twice on 5xx', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    await provider(h, 'First', 'https://first.example.com', 'sk-first-0123456789')
    await provider(h, 'Second', 'https://second.example.com', 'sk-second-0123456789')
    const chat = () => relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, auth)

    fetchMock.mockImplementation(async (url) =>
      String(url).startsWith('https://first.') ? new Response('{"error":"余额不足"}', { status: 402 }) : Response.json({ id: 'from-second' }),
    )
    const fallback = await chat()
    expect(await fallback.json()).toEqual({ id: 'from-second' })
    expect([sentAuth(0), sentAuth(1)]).toEqual(['Bearer sk-first-0123456789', 'Bearer sk-second-0123456789'])

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"bad schema"}}', { status: 400, headers: { 'content-type': 'application/json' } }))
    const rejected = await chat()
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toBe('{"error":{"message":"bad schema"}}')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    fetchMock.mockReset()
    fetchMock.mockResolvedValue(new Response('boom', { status: 503 }))
    expect((await chat()).status).toBe(503)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('caps one access key at 8 concurrent requests', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    await provider(h, 'Acme', 'https://acme.example.com', 'sk-acme-0123456789')
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => (release = resolve))
    fetchMock.mockImplementation(async () => {
      await gate
      return Response.json({ ok: true })
    })
    const running = Array.from({ length: 8 }, () => relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, auth))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8))
    expect((await relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, auth)).status).toBe(429)
    release()
    await Promise.all((await Promise.all(running)).map((response) => response.text()))
    fetchMock.mockResolvedValue(Response.json({ ok: true }))
    expect((await relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, auth)).status).toBe(200)
  })

  it('deduplicates repeated endpoints and qualifies only later providers per protocol', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    const first = await provider(h, 'First', 'https://first.example.com', 'sk-first-0123456789', ['m1', 'Second/m1', 'shared'])
    const second = await provider(h, 'Second', 'https://second.example.com', 'sk-second-0123456789', ['m1', 'shared'])
    await h.env.DB.prepare(`INSERT INTO ai_endpoints (id, user_id, provider_id, slug, base_url, protocol, position)
      SELECT 'duplicate', user_id, provider_id, 'duplicate', base_url, protocol, 1 FROM ai_endpoints WHERE id = ?1`).bind(first).run()
    await h.env.DB.prepare(`INSERT INTO ai_models (user_id, endpoint_id, model_id, model_type, type_source, position)
      VALUES ('user-a', 'duplicate', 'm1', 'chat', 'user', 0)`).run()
    const listed = await (await relay.request('GET', '/relay/v1/models', undefined, auth)).json() as { data: { id: string; protocol: string }[] }
    expect(listed.data.map((model) => model.id)).toEqual(['m1', 'Second/m1', 'shared', 'Second/shared'])
    fetchMock.mockImplementation(async () => Response.json({ ok: true }))
    await (await relay.request('POST', '/relay/v1/chat/completions', { model: 'Second/m1' }, auth)).text()
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://first.example.com/v1/chat/completions')
    expect(await new Response(fetchMock.mock.calls[0]![1]!.body).json()).toMatchObject({ model: 'Second/m1' })
    await (await relay.request('POST', '/relay/v1/chat/completions', { model: 'Second/shared' }, auth)).text()
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe('https://second.example.com/v1/chat/completions')
    expect(await new Response(fetchMock.mock.calls.at(-1)![1]!.body).json()).toMatchObject({ model: 'shared' })
    await h.env.DB.prepare("DELETE FROM ai_models WHERE model_id = 'Second/m1'").run()
    await h.env.DB.prepare("UPDATE ai_providers SET name = 'First' WHERE id = (SELECT provider_id FROM ai_endpoints WHERE id = ?1)").bind(second).run()
    await h.env.DB.prepare("INSERT INTO ai_models (user_id, endpoint_id, model_id, model_type, type_source, position) VALUES ('user-a', ?1, 'second-only', 'chat', 'user', 1)").bind(second).run()
    expect((await relay.request('POST', '/relay/v1/chat/completions', { model: 'First/second-only' }, auth)).status).toBe(404)
    await (await relay.request('POST', '/relay/v1/chat/completions', { model: 'First/m1' }, auth)).text()
    expect(String(fetchMock.mock.calls.at(-1)![0])).toBe('https://first.example.com/v1/chat/completions')
    const settings = await relay.json<{ protocols: string[] }>('GET', '/api/relay')
    expect(settings.protocols).toEqual(['openai-chat'])
  })

  it('routes discovered models when both provider and model names contain slashes', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    await provider(h, 'Team', 'https://team.example.com', 'sk-team-0123456789', ['other'])
    await provider(h, 'First', 'https://first.example.com', 'sk-first-0123456789', ['vendor/m1'])
    await provider(h, 'Team/Acme', 'https://acme.example.com', 'sk-acme-0123456789', ['vendor/m1'])
    const listing = await (await relay.request('GET', '/relay/v1/models', undefined, auth)).json() as { data: { id: string }[] }
    expect(listing.data.map((entry) => entry.id)).toContain('Team/Acme/vendor/m1')
    fetchMock.mockResolvedValue(Response.json({ ok: true }))
    const result = await relay.request('POST', '/relay/v1/chat/completions', { model: 'Team/Acme/vendor/m1' }, auth)
    expect(result.status).toBe(200)
    await result.text()
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://acme.example.com/v1/chat/completions')
    expect(await new Response(fetchMock.mock.calls[0]![1]!.body).json()).toMatchObject({ model: 'vendor/m1' })
  })

  it('reports mixed configuration failures instead of claiming every line is paused', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    const paused = await provider(h, 'Paused', 'https://paused.example.com', 'sk-paused-0123456789')
    const missing = await provider(h, 'Missing', 'https://missing.example.com', 'sk-missing-0123456789')
    await h.env.DB.prepare("UPDATE ai_endpoints SET key_strategy = 'fill_first'").run()
    await h.env.DB.prepare('UPDATE ai_endpoint_keys SET exhausted_until = ?1 WHERE endpoint_id = ?2').bind(Date.now() + 120_000, paused).run()
    await h.env.DB.prepare('DELETE FROM ai_endpoint_keys WHERE endpoint_id = ?1').bind(missing).run()
    const send = () => relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, auth)
    for (const position of [-1, 99]) {
      await h.env.DB.prepare('UPDATE ai_providers SET position = ?1 WHERE id = (SELECT provider_id FROM ai_endpoints WHERE id = ?2)').bind(position, missing).run()
      const result = await send()
      expect(result.status).toBe(502)
      expect(await result.json()).toMatchObject({ error: { type: 'api_error', message: 'missing key' } })
    }
    await h.env.DB.prepare('UPDATE ai_endpoints SET base_url = ?1 WHERE id = ?2').bind('http://127.0.0.1', missing).run()
    expect((await send()).status).toBe(502)
    expect(fetchMock).not.toHaveBeenCalled()
    await addKey(h, 'user-a', missing, 'sk-missing-0123456789')
    const recovery = Date.now() + 60_000
    await h.env.DB.prepare('UPDATE ai_endpoints SET base_url = ?1 WHERE id = ?2').bind('https://missing.example.com', missing).run()
    await h.env.DB.prepare('UPDATE ai_endpoint_keys SET exhausted_until = ?1 WHERE endpoint_id = ?2').bind(recovery, missing).run()
    const exhausted = await send()
    expect(exhausted.status).toBe(429)
    expect(JSON.stringify(await exhausted.json())).toContain(new Date(recovery).toISOString())
  })

  it('keeps the client Anthropic version over endpoint and default headers', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    const endpointId = await provider(h, 'Claude', 'https://claude.example.com', 'sk-claude-0123456789', ['m1'], 'anthropic-messages')
    await h.env.DB.prepare('UPDATE ai_endpoints SET headers = ?1 WHERE id = ?2').bind(JSON.stringify({ 'Anthropic-Version': 'endpoint-version' }), endpointId).run()
    fetchMock.mockImplementation(async () => Response.json({ ok: true }))
    await (await relay.request('POST', '/relay/v1/messages', { model: 'm1' }, { ...auth, 'anthropic-version': 'client-version' })).text()
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({ 'anthropic-version': 'client-version' })
  })

  it('masks keys already removed from a fill-first pool in passthrough errors', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    const first = 'sk-first-0123456789'
    const second = 'sk-second-0123456789'
    const endpointId = await provider(h, 'Acme', 'https://acme.example.com', first)
    await addKey(h, 'user-a', endpointId, second)
    await h.env.DB.prepare("UPDATE ai_endpoints SET key_strategy = 'fill_first' WHERE id = ?1").bind(endpointId).run()
    fetchMock.mockResolvedValueOnce(new Response('insufficient balance', { status: 402 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: `${first} ${second}` }), { status: 400, headers: { 'content-type': 'application/json' } }))
    const response = await relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, auth)
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: '*** ***' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('bounds chunked bodies at 10 MB without trusting content-length', async () => {
    const { relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    let pulls = 0
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel })
    const oversized = await relay.raw('/relay/v1/chat/completions', { method: 'POST', headers: auth, body, duplex: 'half' } as RequestInit)
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toMatchObject({ type: 'error', error: { type: 'invalid_request_error' } })
    expect(pulls).toBeLessThanOrEqual(12)
    expect(cancel).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    const declared = await relay.request('POST', '/relay/v1/chat/completions', {}, { ...auth, 'content-length': String(10 * 1024 * 1024 + 1) })
    expect(declared.status).toBe(413)
  })

  it('uses relay envelopes for malformed JSON, oversized exchange bodies and unknown paths', async () => {
    const { relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    for (const response of [
      await relay.raw('/relay/github/token', { method: 'POST', body: '{' }),
      await relay.request('POST', '/relay/github/token', { token: 'x'.repeat(9000) }),
      await relay.request('POST', '/relay/v1/chat/completions', ['not an object'], auth),
      await relay.request('GET', '/relay/unknown'),
      await relay.request('GET', '/relay/v1/unknown', undefined, auth),
    ]) {
      expect([400, 413, 404]).toContain(response.status)
      expect(await response.json()).toMatchObject({ type: 'error', error: { type: expect.stringMatching(/invalid_request_error|not_found_error/) } })
    }
  })

  it('releases slots for null bodies, cancellation and propagated stream errors', async () => {
    const { h, relay, auth } = await setup()
    await relay.request('PUT', '/api/relay', { enabled: true })
    await provider(h, 'Acme', 'https://acme.example.com', 'sk-acme-0123456789')
    const chat = () => relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, auth)
    fetchMock.mockImplementation(async () => new Response(null, { status: 204 }))
    for (let i = 0; i < 10; i++) expect((await chat()).status).toBe(204)
    const cancelled = vi.fn()
    fetchMock.mockImplementation(async () => new Response(new ReadableStream({ cancel: cancelled })))
    const held = await Promise.all(Array.from({ length: 8 }, chat))
    expect((await chat()).status).toBe(429)
    await held[0]!.body!.cancel('client stopped')
    const replacement = await chat()
    expect(replacement.status).toBe(200)
    await Promise.all([...held.slice(1), replacement].map((response) => response.body!.cancel()))
    expect(cancelled).toHaveBeenCalledTimes(9)
    fetchMock.mockImplementation(async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken upstream')) } })))
    for (let i = 0; i < 10; i++) {
      const response = await chat()
      expect(response.status).toBe(200)
      await expect(response.text()).rejects.toThrow('broken upstream')
    }
    fetchMock.mockImplementation(async () => Response.json({ ok: true }))
    expect(await (await chat()).json()).toEqual({ ok: true })
  })
})

describe('GitHub OIDC exchange', () => {
  async function signer() {
    const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey)
    const sign = async (claims: Record<string, unknown>, kid = 'k1') => {
      const encode = (value: unknown) => toBase64Url(utf8(JSON.stringify(value)))
      const input = `${encode({ alg: 'RS256', kid })}.${encode(claims)}`
      const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, utf8(input))
      return `${input}.${toBase64Url(signature)}`
    }
    return { jwks: { keys: [{ ...jwk, kid: 'k1' }] }, sign }
  }

  it('issues a 2-hour key only to the registered workflow of a registered repository while the relay is enabled', async () => {
    const { h, relay } = await setup()
    await provider(h, 'Acme', 'https://acme.example.com', 'sk-acme-0123456789')
    const { jwks, sign } = await signer()
    const now = Math.floor(Date.now() / 1000)
    // A plain workflow run of acme/app on main, pushed (no job_workflow_ref).
    const claims = {
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'http://localhost',
      exp: now + 300,
      repository: 'acme/app',
      ref: 'refs/heads/main',
      event_name: 'push',
      workflow_ref: 'acme/app/.github/workflows/agent.yml@refs/heads/main',
      run_id: '42',
      run_attempt: '1',
      repository_id: '12345',
    }
    fetchMock.mockImplementation(async (url) => (String(url).endsWith('/.well-known/jwks') ? Response.json(jwks) : Response.json({ ok: true })))
    const exchange = async (token: string) => relay.request('POST', '/relay/github/token', { token })

    expect((await exchange(await sign(claims))).status).toBe(403)
    await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'acme/app/.github/workflows/agent.yml' })
    expect((await exchange(await sign(claims))).status).toBe(503)
    await relay.request('PUT', '/api/relay', { enabled: true })

    for (const [bad, reason] of [
      [{ ...claims, ref: 'refs/pull/7/merge', event_name: 'pull_request' }, 'ref'],
      [{ ...claims, event_name: 'pull_request_target' }, 'event'],
      [{ ...claims, event_name: 'workflow_run' }, 'event'],
      [{ ...claims, event_name: 'issue_comment' }, 'event'],
      [{ ...claims, event_name: 'release' }, 'event'],
      [{ ...claims, ref: 'refs/heads/feature', workflow_ref: 'acme/app/.github/workflows/agent.yml@refs/heads/feature' }, 'ref'],
      [{ ...claims, workflow_ref: 'acme/app/.github/workflows/steal.yml@refs/heads/main' }, 'workflow'],
      [{ ...claims, job_workflow_ref: 'tools/ci/.github/workflows/agent.yml@refs/heads/main' }, 'workflow'],
      [{ ...claims, aud: 'https://evil.example.com' }, 'audience'],
      [{ ...claims, exp: now - 10 }, 'expired'],
      [{ ...claims, repository_id: '' }, 'malformed'],
      [{ ...claims, run_attempt: '' }, 'malformed'],
    ] as const) {
      const denied = await exchange(await sign(bad))
      expect(denied.status).toBe(401)
      expect(JSON.stringify(await denied.json())).toContain(reason)
    }
    const forged = (await sign(claims)).replace(/\.[^.]+$/, `.${toBase64Url(new Uint8Array(256))}`)
    expect((await exchange(forged)).status).toBe(401)
    const malformedSignature = (await sign(claims)).replace(/\.[^.]+$/, '.%%%')
    expect((await exchange(malformedSignature)).status).toBe(401)

    // A reusable workflow is checked by job_workflow_ref; the caller is still the registered repo on main.
    await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'tools/ci/.github/workflows/agent.yml' })
    const reusable = { ...claims, event_name: 'workflow_dispatch', job_workflow_ref: 'tools/ci/.github/workflows/agent.yml@v1' }
    expect((await exchange(await sign(reusable))).status).toBe(200)
    await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'acme/app/.github/workflows/agent.yml' })

    const issued = await exchange(await sign(claims))
    const body = (await issued.json()) as { key: string; expiresAt: number; models: unknown[] }
    expect(body.key).toMatch(/^anr_/)
    expect(body.expiresAt - Date.now()).toBeGreaterThan(7_190_000)
    expect(body.models).toEqual([{ id: 'm1', object: 'model', owned_by: 'Acme', protocol: 'openai-chat', model_type: 'chat' }])
    const settings = await relay.json<{ keys: { name: string; expiresAt: number | null }[] }>('GET', '/api/relay')
    expect(settings.keys.map((key) => key.name)).toContain('GitHub acme/app 42')

    const used = await relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, { authorization: `Bearer ${body.key}` })
    expect(used.status).toBe(200)
  })

  it('normalizes repository names but preserves workflow path case and pins immutable identity', async () => {
    const { h, relay } = await setup()
    const { jwks, sign } = await signer()
    fetchMock.mockImplementation(async () => Response.json(jwks))
    const claims = {
      iss: 'https://token.actions.githubusercontent.com', aud: 'http://localhost', exp: Math.floor(Date.now() / 1000) + 300,
      repository: 'ACME/App', repository_id: '100', ref: 'refs/heads/Main', event_name: 'schedule',
      workflow_ref: 'TOOLS/CI/.github/workflows/Agent.yml@v1', run_id: '1', run_attempt: '1',
    }
    await relay.request('POST', '/api/relay/repos', { repo: 'Acme/APP', workflow: 'Tools/Ci/.github/workflows/Agent.yml', ref: claims.ref })
    const repos = await relay.json<{ repos: unknown[] }>('GET', '/api/relay')
    expect(repos.repos).toEqual([{ repo: 'acme/app', workflow: 'tools/ci/.github/workflows/Agent.yml', ref: claims.ref }])
    await relay.request('PUT', '/api/relay', { enabled: true })
    expect((await relay.request('POST', '/relay/github/token', { token: await sign({ ...claims, workflow_ref: claims.workflow_ref.replace('Agent', 'agent') }) })).status).toBe(401)
    expect(await h.env.DB.prepare('SELECT repository_id FROM relay_github_repos').first()).toEqual({ repository_id: null })
    expect((await relay.request('POST', '/relay/github/token', { token: await sign(claims) })).status).toBe(200)
    expect(await h.env.DB.prepare('SELECT repository_id FROM relay_github_repos').first()).toEqual({ repository_id: '100' })
    const replaced = await relay.request('POST', '/relay/github/token', { token: await sign({ ...claims, repository_id: '101' }) })
    expect(replaced.status).toBe(401)
    expect(await replaced.json()).toMatchObject({ error: { message: expect.stringContaining('repository_id') } })
    await relay.request('POST', '/api/relay/repos', { repo: 'ACME/APP', workflow: 'tools/ci/.github/workflows/Agent.yml', ref: claims.ref })
    expect((await relay.request('POST', '/relay/github/token', { token: await sign({ ...claims, repository_id: '101' }) })).status).toBe(401)
    await relay.request('DELETE', '/api/relay/repos/ACME/APP')
    await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'tools/ci/.github/workflows/Agent.yml', ref: claims.ref })
    expect((await relay.request('POST', '/relay/github/token', { token: await sign({ ...claims, repository_id: '101' }) })).status).toBe(200)
  })

  it('rotates each run attempt atomically, purges expired keys and caps each repository separately from manual keys', async () => {
    const { h, relay, token: manual } = await setup()
    const { jwks, sign } = await signer()
    fetchMock.mockImplementation(async () => Response.json(jwks))
    await relay.request('PUT', '/api/relay', { enabled: true })
    for (const repo of ['acme/app', 'acme/other']) await relay.request('POST', '/api/relay/repos', { repo, workflow: 'acme/app/.github/workflows/agent.yml' })
    const claims = {
      iss: 'https://token.actions.githubusercontent.com', aud: 'http://localhost', exp: Math.floor(Date.now() / 1000) + 300,
      repository: 'acme/app', repository_id: '100', ref: 'refs/heads/main', event_name: 'push',
      workflow_ref: 'acme/app/.github/workflows/agent.yml@refs/heads/main', run_id: '1', run_attempt: '1',
    }
    const exchange = async (extra: Record<string, string> = {}) => {
      const response = await relay.request('POST', '/relay/github/token', { token: await sign({ ...claims, ...extra }) })
      expect(response.status).toBe(200)
      return await response.json() as { key: string }
    }
    const first = await exchange()
    const replacement = await exchange()
    expect(replacement.key).not.toBe(first.key)
    const keyStatus = async (key: string) => (await relay.request('GET', '/relay/v1/models', undefined, { authorization: `Bearer ${key}` })).status
    expect(await keyStatus(first.key)).toBe(401)
    expect(await keyStatus(replacement.key)).toBe(200)
    await h.env.DB.prepare("UPDATE relay_access_keys SET created_at = 1 WHERE github_run IS NOT NULL").run()
    await exchange({ run_attempt: '2' })
    expect(await keyStatus(replacement.key)).toBe(200)
    await h.env.DB.prepare(`INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at, expires_at, github_run)
      VALUES ('expired', 'user-a', 'expired', 'expired-hash', 0, 1, 'acme/app#expired#1')`).run()
    await Promise.all(Array.from({ length: 22 }, (_, i) => exchange({ run_id: String(i + 2) })))
    expect(await keyStatus(replacement.key)).toBe(401)
    expect(await h.env.DB.prepare("SELECT id FROM relay_access_keys WHERE id = 'expired'").first()).toBeNull()
    expect((await h.env.DB.prepare("SELECT COUNT(*) AS count FROM relay_access_keys WHERE github_run LIKE 'acme/app#%' AND revoked_at IS NULL").first<{ count: number }>())?.count).toBe(20)
    await exchange({ repository: 'acme/other', repository_id: '200' })
    expect((await h.env.DB.prepare("SELECT COUNT(*) AS count FROM relay_access_keys WHERE revoked_at IS NULL").first<{ count: number }>())?.count).toBe(22)
    expect(await keyStatus(manual)).toBe(200)
    const stored = await h.env.DB.prepare('SELECT key_hash FROM relay_access_keys WHERE key_hash = ?1').bind(await sha256Hex(replacement.key)).first()
    expect(stored).toEqual({ key_hash: await sha256Hex(replacement.key) })
  })

  it('does not pin identity or partially revoke keys when issuance rolls back', async () => {
    const { h, relay } = await setup()
    const { jwks, sign } = await signer()
    fetchMock.mockImplementation(async () => Response.json(jwks))
    await relay.request('PUT', '/api/relay', { enabled: true })
    await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'acme/app/.github/workflows/agent.yml' })
    const claims = {
      iss: 'https://token.actions.githubusercontent.com', aud: 'http://localhost', exp: Math.floor(Date.now() / 1000) + 300,
      repository: 'acme/app', repository_id: '100', ref: 'refs/heads/main', event_name: 'push',
      workflow_ref: 'acme/app/.github/workflows/agent.yml@refs/heads/main', run_id: '1', run_attempt: '1',
    }
    await h.env.DB.prepare(`INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at, expires_at, github_run)
      VALUES ('prior', 'user-a', 'prior', 'prior-hash', 0, ?1, 'acme/app#1#1')`).bind(Date.now() + 100_000).run()
    await h.env.DB.exec("CREATE TRIGGER reject_github BEFORE INSERT ON relay_access_keys WHEN NEW.github_run IS NOT NULL BEGIN SELECT RAISE(ABORT, 'unavailable'); END")
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const response = await relay.request('POST', '/relay/github/token', { token: await sign(claims) })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } })
      expect(await h.env.DB.prepare('SELECT repository_id FROM relay_github_repos').first()).toEqual({ repository_id: null })
      expect(await h.env.DB.prepare("SELECT revoked_at FROM relay_access_keys WHERE id = 'prior'").first()).toEqual({ revoked_at: null })
    } finally { log.mockRestore() }
  })

  it('rejects a repository identity changed between lookup and the atomic issuance batch', async () => {
    const { h, relay } = await setup()
    const { jwks, sign } = await signer()
    fetchMock.mockImplementation(async () => Response.json(jwks))
    await relay.request('PUT', '/api/relay', { enabled: true })
    await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'acme/app/.github/workflows/agent.yml' })
    const batch = h.env.DB.batch.bind(h.env.DB)
    h.env.DB.batch = async (statements) => {
      await h.env.DB.prepare("UPDATE relay_github_repos SET repository_id = 'other-id'").run()
      return batch(statements)
    }
    const token = await sign({
      iss: 'https://token.actions.githubusercontent.com', aud: 'http://localhost', exp: Math.floor(Date.now() / 1000) + 300,
      repository: 'acme/app', repository_id: '100', ref: 'refs/heads/main', event_name: 'push',
      workflow_ref: 'acme/app/.github/workflows/agent.yml@refs/heads/main', run_id: '1', run_attempt: '1',
    })
    const response = await relay.request('POST', '/relay/github/token', { token })
    expect(response.status).toBe(401)
    expect((await h.env.DB.prepare('SELECT COUNT(*) AS count FROM relay_access_keys WHERE github_run IS NOT NULL').first<{ count: number }>())?.count).toBe(0)
  })

  it('lets only one user register a repository and updates the workflow for its owner', async () => {
    const { h, relay } = await setup()
    const add = (workflow: string) => relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow })
    expect((await add('tools/ci/.github/workflows/a.yml')).status).toBe(200)
    expect(await (await add('tools/ci/.github/workflows/b.yml')).json()).toEqual({ repos: [{ repo: 'acme/app', workflow: 'tools/ci/.github/workflows/b.yml', ref: 'refs/heads/main' }] })
    expect((await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'tools/ci/.github/workflows/b.yml', ref: 'main' })).status).toBe(400)
    await h.env.DB.prepare("UPDATE relay_github_repos SET user_id = 'user-b'").run()
    expect((await add('evil/x/.github/workflows/c.yml')).status).toBe(409)
    expect((await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'not-a-workflow' })).status).toBe(400)
  })
})
