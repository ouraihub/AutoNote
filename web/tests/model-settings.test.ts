import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelPricing, TokenUsage } from '@ouraihub/aether-ui/ports'
import type { AppBindings } from '../src/worker/env'
import { cost } from '@ouraihub/aether-core/pricing'
import { aiRoutes } from '../src/worker/routes/ai'
import {
  addKey,
  chatModel,
  createHarness,
  fixture,
  frames,
  streamOf,
  type Harness,
} from './support/ai-kit-harness'

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const PRICING: ModelPricing = {
  currency: 'USD',
  tiers: [
    {
      minInputTokens: 0,
      input: 1,
      output: 2,
      cacheRead: null,
      cacheWrite: null,
    },
  ],
}
const tier = (minInputTokens: number) => ({
  minInputTokens,
  input: 1,
  output: 1,
  cacheRead: null,
  cacheWrite: null,
})

async function save(
  h: Harness,
  models: unknown[],
  protocol = 'openai-chat',
  id?: string,
  endpointId?: string,
) {
  return h.json<
    {
      id: string
      endpoints: { id: string; models: Record<string, unknown>[] }[]
    }[]
  >('user-a', 'PUT', '/providers', {
    ...(id ? { id } : {}),
    name: 'Acme',
    endpoints: [
      {
        ...(endpointId ? { id: endpointId } : {}),
        slug: 'main',
        baseUrl: 'https://api.example.com',
        protocol,
        models,
      },
    ],
  })
}

describe('migration v28', () => {
  it('adds model metadata and turn cost columns', async () => {
    const h = await createHarness()
    const columns = async (table: string) =>
      (
        await h.env.DB.prepare(`PRAGMA table_info(${table})`).all<{
          name: string
        }>()
      ).results.map((row) => row.name)
    expect(await columns('ai_models')).toEqual(
      expect.arrayContaining(['name', 'group_name', 'pricing']),
    )
    expect(await columns('ai_chat_turns')).toEqual(
      expect.arrayContaining(['cost', 'cost_currency']),
    )
  })
})

describe('model validation', () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ name: 'x'.repeat(81) }, 'name', 'too_long'],
    [{ groupName: 'x'.repeat(81) }, 'groupName', 'too_long'],
    [{ contextWindow: 0 }, 'contextWindow', 'invalid'],
    [{ maxOutput: 0 }, 'maxOutput', 'invalid'],
    [{ contextWindow: 4096, maxOutput: 4096 }, 'maxOutput', 'exceeds_context'],
    [{ modelType: 'embedding', pricing: PRICING }, 'pricing', 'invalid'],
    [{ pricing: { currency: 'USD', tiers: [] } }, 'pricing', 'invalid'],
    [{ pricing: { currency: 'USD', tiers: [tier(1)] } }, 'pricing', 'invalid'],
    [
      { pricing: { currency: 'USD', tiers: [tier(0), tier(0)] } },
      'pricing',
      'invalid',
    ],
    [
      {
        pricing: {
          currency: 'USD',
          tiers: Array.from({ length: 9 }, (_, index) => tier(index)),
        },
      },
      'pricing',
      'invalid',
    ],
    [
      { pricing: { currency: 'USD', tiers: [{ ...tier(0), output: -1 }] } },
      'pricing',
      'invalid',
    ],
    [
      {
        reasoning: { dialect: 'openai', efforts: ['low'] },
        modelType: 'image',
      },
      'reasoning',
      'invalid_efforts',
    ],
  ]
  it.each(cases)('%j → %s %s', async (patch, field, reason) => {
    const h = await createHarness()
    const { status, body } = await save(h, [{ ...chatModel('m1'), ...patch }])
    expect(status).toBe(400)
    expect(body).toMatchObject({ error: { details: { field, reason } } })
  })

  it('trims name and group, stores pricing and returns them on every read path', async () => {
    const h = await createHarness()
    const saved = await save(h, [
      {
        ...chatModel('m1'),
        name: '  Friendly  ',
        groupName: ' ',
        pricing: PRICING,
      },
    ])
    expect(saved.body[0]!.endpoints[0]!.models[0]).toMatchObject({
      name: 'Friendly',
      groupName: null,
      pricing: PRICING,
    })
    expect(
      (await h.json('user-a', 'GET', '/model-options')).body,
    ).toMatchObject([{ modelId: 'm1', name: 'Friendly' }])
  })
})

describe('reasoning semantics', () => {
  it('keeps "off" without re-inferring and re-validates an omitted value against the new protocol', async () => {
    const h = await createHarness()
    const first = await save(
      h,
      [chatModel('claude-sonnet-5-5')],
      'anthropic-messages',
    )
    const { id } = first.body[0]!
    const endpointId = first.body[0]!.endpoints[0]!.id
    expect(first.body[0]!.endpoints[0]!.models[0]!.reasoning).not.toBeNull()
    const off = await save(
      h,
      [{ ...chatModel('claude-sonnet-5-5'), reasoning: null }],
      'anthropic-messages',
      id,
      endpointId,
    )
    expect(off.body[0]!.endpoints[0]!.models[0]!.reasoning).toBeNull()
    const kept = await save(
      h,
      [chatModel('claude-sonnet-5-5')],
      'anthropic-messages',
      id,
      endpointId,
    )
    expect(kept.body[0]!.endpoints[0]!.models[0]!.reasoning).toBeNull()
    expect(
      (
        await h.json<{ reasoning: unknown }[]>(
          'user-a',
          'GET',
          '/model-options',
        )
      ).body[0]!.reasoning,
    ).toBeNull()

    const config = { dialect: 'anthropic-adaptive', efforts: ['low', 'high'] }
    await save(
      h,
      [{ ...chatModel('claude-sonnet-5-5'), reasoning: config }],
      'anthropic-messages',
      id,
      endpointId,
    )
    expect(
      await save(
        h,
        [chatModel('claude-sonnet-5-5')],
        'openai-chat',
        id,
        endpointId,
      ),
    ).toMatchObject({
      status: 400,
      body: {
        error: { details: { field: 'reasoning', reason: 'protocol_mismatch' } },
      },
    })
  })
})

describe('cost', () => {
  it('matches the shared fixture', () => {
    const cases = JSON.parse(fixture('pricing-cost.json').toString()) as {
      name: string
      pricing: ModelPricing
      rounds: TokenUsage[]
      cost: number | null
    }[]
    expect(cases.length).toBeGreaterThanOrEqual(6)
    for (const entry of cases) {
      const got = cost(entry.pricing, entry.rounds)
      if (entry.cost === null) expect(got, entry.name).toBeNull()
      else
        expect(Math.abs(got!.amount - entry.cost), entry.name).toBeLessThan(
          1e-9,
        )
    }
  })

  it('prices each round at its own tier', () => {
    const pricing: ModelPricing = {
      currency: 'CNY',
      tiers: [
        { ...tier(0), input: 1 },
        { ...tier(1000), input: 10 },
      ],
    }
    const round = (inputTokens: number): TokenUsage => ({
      inputTokens,
      outputTokens: 0,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      reasoningTokens: null,
    })
    // Summed input (1400) would land in the upper tier; per round both stay in the lower one.
    expect(cost(pricing, [round(700), round(700)])).toEqual({
      amount: 1400 / 1e6,
      currency: 'CNY',
    })
    expect(cost(pricing, [round(700), round(1000)])!.amount).toBeCloseTo(
      (700 + 10_000) / 1e6,
      12,
    )
  })

  it('emits cost on usage and persists it on the turn', async () => {
    const h = await createHarness()
    const saved = await save(h, [{ ...chatModel('m1'), pricing: PRICING }])
    const endpointId = saved.body[0]!.endpoints[0]!.id
    await addKey(h, 'user-a', endpointId, 'sk-test-abcdefghijklmnop')
    fetchMock.mockResolvedValue(
      new Response(
        streamOf(new Uint8Array(fixture('sse/openai-chat/text.sse'))),
      ),
    )
    const response = await h.call('user-a', 'POST', '/runs', {
      purpose: 'chat',
      skills: [],
      input: 'Hi',
      regenerate: false,
      language: 'en-US',
      model: { endpointId, modelId: 'm1' },
    })
    const events = frames(await response.text())
    await h.settle()
    const want = { amount: (19 * 1 + 10 * 2) / 1e6, currency: 'USD' }
    expect(events.find((event) => event.kind === 'usage')).toMatchObject({
      cost: want,
    })
    const conversationId = events[0]!.conversationId as string
    const loaded = await h.json<{ turns: { cost: unknown }[] }>(
      'user-a',
      'GET',
      `/conversations/${conversationId}`,
    )
    expect(loaded.body.turns[0]!.cost).toEqual(want)
  })
})

describe('roles', () => {
  it('hides bindings whose model is missing or of the wrong type and labels from the option', async () => {
    const h = await createHarness()
    const saved = await save(h, [
      chatModel('m1'),
      { ...chatModel('img'), modelType: 'image' },
    ])
    const endpointId = saved.body[0]!.endpoints[0]!.id
    const bind = (role: string, modelId: string) =>
      h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id, model_id) VALUES (?1, ?2, ?3, ?4)',
      )
        .bind('user-a', role, endpointId, modelId)
        .run()
    await bind('chat', 'm1')
    await bind('writing', 'img')
    await bind('painting', 'm1')
    const app = new Hono<AppBindings>()
    app.use('*', async (c, next) => {
      c.set('userId', 'user-a')
      c.set('user', {
        id: 'user-a',
        username: 'a',
        login: 'a',
        name: 'a',
        avatarUrl: '',
        role: 'owner',
        createdAt: 0,
        settingsRaw: '{}',
      })
      await next()
    })
    app.route('/api/ai', aiRoutes)
    const roles = await (await app.request('/api/ai/roles', {}, h.env)).json()
    const label = 'Acme · main · m1'
    expect(roles).toEqual([
      {
        role: 'chat',
        binding: { endpointId, modelId: 'm1', label },
        isFallback: false,
      },
      {
        role: 'writing',
        binding: { endpointId, modelId: 'm1', label },
        isFallback: true,
      },
      { role: 'painting', binding: null, isFallback: false },
    ])
  })
})
