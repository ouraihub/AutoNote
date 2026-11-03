import { afterEach, beforeEach, expect, vi } from 'vitest'

import type { Protocol } from '@ouraihub/aether-ui/ports'

import { addKey, chatModel, createHarness, frames } from './ai-kit-harness'

export const upstream = vi.fn<typeof fetch>()

beforeEach(() => vi.stubGlobal('fetch', upstream))

afterEach(() => {
  upstream.mockReset()
  vi.unstubAllGlobals()
})

export const sse = (...events: unknown[]) =>
  new Response(
    events
      .map(
        (event) =>
          'data: ' +
          `${typeof event === 'string' ? event : JSON.stringify(event)}` +
          '\n\n',
      )
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  )

export async function configured(protocol: Protocol) {
  const h = await createHarness()
  const reasoning = {
    dialect: protocol === 'anthropic-messages' ? 'anthropic-budget' : 'openai',
    efforts: ['none', 'low', 'high'],
    ...(protocol === 'anthropic-messages' ? { budgetTokens: 3000 } : {}),
  }
  const model = {
    ...chatModel('model'),
    maxOutput: 4096,
    contextWindow: 32000,
    reasoning,
  }
  const saved = await h.json<
    {
      id: string
      name: string
      endpoints: {
        id: string
        slug: string
        baseUrl: string
        protocol: Protocol
        models: (typeof model)[]
      }[]
    }[]
  >('user-a', 'PUT', '/providers', {
    name: 'Local',
    endpoints: [
      {
        slug: 'main',
        baseUrl: 'https://example.com/v1',
        protocol,
        models: [model],
      },
    ],
  })
  expect(saved.status).toBe(200)
  const wire = saved.body[0]!
  const provider = {
    ...wire,
    endpoints: wire.endpoints.map((e) => ({
      id: e.id,
      slug: e.slug,
      baseUrl: e.baseUrl,
      protocol: e.protocol,
      models: e.models,
    })),
  }
  const ref = { endpointId: provider.endpoints[0]!.id, modelId: 'model' }
  await addKey(h, 'user-a', ref.endpointId, 'local-test-key')
  const run = async (extra: Record<string, unknown> = {}) => {
    const r = await h.call('user-a', 'POST', '/runs', {
      purpose: 'chat',
      skills: [],
      input: 'Question',
      regenerate: false,
      language: 'en-US',
      model: ref,
      reasoningEffort: 'high',
      ...extra,
    })
    const text = await r.text()
    await h.settle()
    return {
      status: r.status,
      events: r.headers.get('content-type')?.includes('event-stream')
        ? frames(text)
        : [],
      body: r.headers.get('content-type')?.includes('json')
        ? (JSON.parse(text) as unknown)
        : null,
    }
  }
  return { h, run, provider, model, ref }
}
