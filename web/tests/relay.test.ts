import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppBindings } from '../src/worker/env'
import { relayRoutes, relaySettingsRoutes } from '../src/worker/routes/relay'
import { toBase64Url, utf8 } from '../src/worker/lib/encoding'
import { addKey, chatModel, createHarness, type Harness } from './support/ai-kit-harness'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

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
  return { request, json: async <T>(method: string, path: string, body?: unknown) => (await (await request(method, path, body)).json()) as T }
}

async function provider(h: Harness, name: string, baseUrl: string, key: string, models = ['m1'], protocol = 'openai-chat') {
  const { body } = await h.json<{ name: string; endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
    name,
    endpoints: [{ slug: 'main', baseUrl, protocol, models: models.map(chatModel) }],
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
        { id: 'm1', object: 'model', owned_by: 'Acme', protocol: 'openai-chat' },
        { id: 'shared', object: 'model', owned_by: 'Acme', protocol: 'openai-chat' },
        { id: 'shared', object: 'model', owned_by: 'Beta', protocol: 'anthropic-messages' },
        { id: 'claude-x', object: 'model', owned_by: 'Beta', protocol: 'anthropic-messages' },
      ],
    })

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
    const claims = {
      iss: 'https://token.actions.githubusercontent.com',
      aud: 'http://localhost',
      exp: now + 300,
      repository: 'acme/app',
      job_workflow_ref: 'tools/ci/.github/workflows/agent.yml@refs/heads/main',
      run_id: '42',
    }
    fetchMock.mockImplementation(async (url) => (String(url).endsWith('/.well-known/jwks') ? Response.json(jwks) : Response.json({ ok: true })))
    const exchange = async (token: string) => relay.request('POST', '/relay/github/token', { token })

    expect((await exchange(await sign(claims))).status).toBe(403)
    await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'tools/ci/.github/workflows/agent.yml' })
    expect((await exchange(await sign(claims))).status).toBe(503)
    await relay.request('PUT', '/api/relay', { enabled: true })

    for (const [bad, reason] of [
      [{ ...claims, job_workflow_ref: 'acme/app/.github/workflows/steal.yml@refs/heads/main' }, 'workflow'],
      [{ ...claims, aud: 'https://evil.example.com' }, 'audience'],
      [{ ...claims, exp: now - 10 }, 'expired'],
    ] as const) {
      const denied = await exchange(await sign(bad))
      expect(denied.status).toBe(401)
      expect(JSON.stringify(await denied.json())).toContain(reason)
    }
    const forged = (await sign(claims)).replace(/\.[^.]+$/, `.${toBase64Url(new Uint8Array(256))}`)
    expect((await exchange(forged)).status).toBe(401)

    const issued = await exchange(await sign(claims))
    const body = (await issued.json()) as { key: string; expiresAt: number; models: unknown[] }
    expect(body.key).toMatch(/^anr_/)
    expect(body.expiresAt - Date.now()).toBeGreaterThan(7_190_000)
    expect(body.models).toEqual([{ id: 'm1', object: 'model', owned_by: 'Acme', protocol: 'openai-chat' }])
    const settings = await relay.json<{ keys: { name: string; expiresAt: number | null }[] }>('GET', '/api/relay')
    expect(settings.keys.map((key) => key.name)).toContain('GitHub acme/app 42')

    const used = await relay.request('POST', '/relay/v1/chat/completions', { model: 'm1' }, { authorization: `Bearer ${body.key}` })
    expect(used.status).toBe(200)
  })

  it('lets only one user register a repository and updates the workflow for its owner', async () => {
    const { h, relay } = await setup()
    const add = (workflow: string) => relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow })
    expect((await add('tools/ci/.github/workflows/a.yml')).status).toBe(200)
    expect(await (await add('tools/ci/.github/workflows/b.yml')).json()).toEqual({ repos: [{ repo: 'acme/app', workflow: 'tools/ci/.github/workflows/b.yml' }] })
    await h.env.DB.prepare("UPDATE relay_github_repos SET user_id = 'user-b'").run()
    expect((await add('evil/x/.github/workflows/c.yml')).status).toBe(409)
    expect((await relay.request('POST', '/api/relay/repos', { repo: 'acme/app', workflow: 'not-a-workflow' })).status).toBe(400)
  })
})
