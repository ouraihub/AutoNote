import { afterEach, expect, test, vi } from 'vitest'
import { chatModel, createHarness, frames } from './support/ai-kit-harness'
import { initializeDatabase } from '../src/worker/db/schema'

afterEach(() => vi.unstubAllGlobals())

test('native preference selects declared server tool, keeps citations, and disabled search sends no tool', async () => {
  const h = await createHarness()
  const saved = await h.json<{ endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
    name: 'Native',
    endpoints: [
      {
        slug: 'main',
        baseUrl: 'https://example.com/v1',
        protocol: 'openai-responses',
        apiKey: 'model-key',
        models: [{ ...chatModel('native'), nativeWebSearch: true }],
      },
    ],
  })
  expect(saved.status).toBe(200)
  const model = { endpointId: saved.body[0]!.endpoints[0]!.id, modelId: 'native' }
  const prefs = { maxResults: 5, compression: 'none', cutoffLimit: 2000, blacklist: [], modelToolsPreferred: true }
  expect((await h.json('user-a', 'PUT', '/search/preferences', prefs)).status).toBe(200)
  const calls: Record<string, unknown>[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)))
      const events = [
        { type: 'response.output_text.delta', delta: 'Answer' },
        {
          type: 'response.output_text.annotation.added',
          annotation: { type: 'url_citation', url: 'https://example.com/source' },
        },
        { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } },
      ]
      return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }),
  )
  for (const webSearch of [true, false]) {
    const result = await h.call('user-a', 'POST', '/runs', {
      purpose: 'chat',
      model,
      skills: [],
      input: 'Search',
      regenerate: false,
      language: 'en-US',
      webSearch,
    })
    const events = frames(await result.text())
    await h.settle()
    expect(events.at(-1)).toMatchObject({ status: 'completed' })
    expect(events.some((e) => e.kind === 'search_start')).toBe(false)
    expect(
      events
        .filter((e) => e.kind === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('Answer [source](<https://example.com/source>)')
  }
  expect(calls[0]?.tools).toEqual([{ type: 'web_search' }])
  expect(calls[1]?.tools).toBeUndefined()
})

test('unsupported models use external search despite preference; Chat protocol cannot declare native search', async () => {
  const h = await createHarness()
  const endpoint = {
    slug: 'main',
    baseUrl: 'https://example.com/v1',
    protocol: 'openai-chat',
    apiKey: 'model-key',
    models: [{ ...chatModel('plain'), nativeWebSearch: true }],
  }
  expect((await h.json('user-a', 'PUT', '/providers', { name: 'Plain', endpoints: [endpoint] })).status).toBe(400)
  const saved = await h.json<{ endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', {
    name: 'Plain',
    endpoints: [{ ...endpoint, models: [chatModel('plain')] }],
  })
  const model = { endpointId: saved.body[0]!.endpoints[0]!.id, modelId: 'plain' }
  await h.json('user-a', 'PUT', '/search/preferences', {
    maxResults: 5,
    compression: 'none',
    cutoffLimit: 2000,
    blacklist: [],
    modelToolsPreferred: true,
  })
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      calls.push(String(url))
      if (String(url).includes('mcp.exa.ai'))
        return Response.json({
          result: {
            content: [{ type: 'text', text: 'Title: Source\nURL: https://example.com/source\nHighlights:\nFact' }],
          },
        })
      return new Response(
        'data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }),
  )
  const response = await h.call('user-a', 'POST', '/runs', {
    purpose: 'chat',
    model,
    skills: [],
    input: 'Question',
    regenerate: false,
    language: 'en-US',
    webSearch: true,
  })
  const events = frames(await response.text())
  await h.settle()
  expect(events.at(-1)).toMatchObject({ status: 'completed' })
  expect(events.some((e) => e.kind === 'search_result')).toBe(true)
  expect(calls).toEqual(['https://mcp.exa.ai/mcp', 'https://example.com/v1/chat/completions'])
})

test('upgrades existing model configuration without losing credentials or search settings', async () => {
  const h = await createHarness()
  const input = {
    name: 'Existing',
    endpoints: [{ slug: 'main', baseUrl: 'https://example.com/v1', protocol: 'openai-responses', apiKey: 'retain-key', models: [chatModel('existing')] }],
  }
  const saved = await h.json<{ id: string; endpoints: { id: string }[] }[]>('user-a', 'PUT', '/providers', input)
  const provider = saved.body[0]!
  const endpoint = provider.endpoints[0]!
  await h.env.DB.exec("ALTER TABLE ai_models DROP COLUMN native_web_search; DELETE FROM schema_migrations WHERE version = 18; UPDATE app_meta SET value = '{\"schema\":\"before-native-search\",\"ftsEnabled\":true}' WHERE key = 'database-state-v1'")
  const old = h.env.DB
  h.env.DB = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
  await initializeDatabase(h.env)
  expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({ status: 200, body: [{ id: provider.id, endpoints: [{ id: endpoint.id, hasKey: true, models: [{ id: 'existing', nativeWebSearch: false }] }] }] })
  const updated = { ...input, id: provider.id, endpoints: [{ ...input.endpoints[0]!, id: endpoint.id, apiKey: undefined, models: [{ ...chatModel('existing'), nativeWebSearch: true }] }] }
  expect(await h.json('user-a', 'PUT', '/providers', updated)).toMatchObject({ status: 200, body: [{ endpoints: [{ hasKey: true, models: [{ nativeWebSearch: true }] }] }] })
  expect(await h.json('user-a', 'GET', '/model-options')).toMatchObject({ status: 200, body: [{ modelId: 'existing', nativeWebSearch: true }] })
  expect(await h.json('user-a', 'GET', '/search/settings?capability=search')).toMatchObject({ status: 200, body: { defaultProvider: 'exa-mcp' } })
  const restarted = h.env.DB
  h.env.DB = { prepare: restarted.prepare.bind(restarted), batch: restarted.batch.bind(restarted), exec: restarted.exec.bind(restarted) } as D1Database
  await initializeDatabase(h.env)
  expect(await h.json('user-a', 'GET', '/providers')).toMatchObject({ status: 200, body: [{ endpoints: [{ hasKey: true, models: [{ nativeWebSearch: true }] }] }] })
})
