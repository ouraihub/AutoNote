import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Protocol } from '@ouraihub/aether-ui/ports'
import { addKey, chatModel, createHarness, frames } from './support/ai-kit-harness'
import { initializeDatabase } from '../src/worker/db/schema'
import type { Env } from '../src/worker/env'
import { inferReasoning } from '../src/worker/ai/infer'

const upstream = vi.fn<typeof fetch>()
beforeEach(() => vi.stubGlobal('fetch', upstream))
afterEach(() => { upstream.mockReset(); vi.unstubAllGlobals() })
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })

async function configured(protocol: Protocol) {
  const h = await createHarness()
  const reasoning = { dialect: protocol === 'anthropic-messages' ? 'anthropic-budget' : 'openai', efforts: ['none', 'low', 'high'], ...(protocol === 'anthropic-messages' ? { budgetTokens: 3000 } : {}) }
  const model = { ...chatModel('model'), maxOutput: 4096, contextWindow: 32000, reasoning }
  const saved = await h.json<{ id: string; name: string; endpoints: { id: string; slug: string; baseUrl: string; protocol: Protocol; models: typeof model[] }[] }[]>('user-a', 'PUT', '/providers', { name: 'Local', endpoints: [{ slug: 'main', baseUrl: 'https://example.com/v1', protocol, models: [model] }] })
  expect(saved.status).toBe(200)
  const wire = saved.body[0]!
  const provider = { ...wire, endpoints: wire.endpoints.map(e => ({ id: e.id, slug: e.slug, baseUrl: e.baseUrl, protocol: e.protocol, models: e.models })) }
  const ref = { endpointId: provider.endpoints[0]!.id, modelId: 'model' }
  await addKey(h, 'user-a', ref.endpointId, 'local-test-key')
  const run = async (extra: Record<string, unknown> = {}) => {
    const r = await h.call('user-a', 'POST', '/runs', { purpose: 'chat', skills: [], input: 'Question', regenerate: false, language: 'en-US', model: ref, reasoningEffort: 'high', ...extra })
    const text = await r.text(); await h.settle()
    return { status: r.status, events: r.headers.get('content-type')?.includes('event-stream') ? frames(text) : [], body: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) as unknown : null }
  }
  return { h, run, provider, model, ref }
}

describe('reasoning and usage', () => {
  it('preserves signed Anthropic blocks and normalizes cache input without double counting', async () => {
    const { h, run } = await configured('anthropic-messages')
    upstream.mockImplementation(async () => sse(
      { type: 'message_start', message: { usage: { input_tokens: 40, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Reason' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } },
      { type: 'message_delta', usage: { output_tokens: 30 }, delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ))
    const first = await run()
    expect(first.events.at(-1)).toMatchObject({ status: 'completed' })
    expect(first.events.find((event) => event.kind === 'usage')).toMatchObject({ inputTokens: 130, outputTokens: 30, cacheReadTokens: 80, cacheWriteTokens: 10 })
    expect(first.events.filter((event) => event.kind === 'context').at(-1)).toMatchObject({ usage: { source: 'reported', tokens: 160 } })
    const id = String(first.events[0]!.conversationId)
    await run({ conversationId: id, input: 'Next' })
    const sent = JSON.parse(String(upstream.mock.calls[1]![1]?.body)) as { messages: { content: unknown }[]; thinking: { budget_tokens: number } }
    expect(sent.thinking.budget_tokens).toBe(2400)
    expect(sent.messages).toContainEqual({ role: 'assistant', content: [{ type: 'thinking', thinking: 'Reason', signature: 'signature' }, { type: 'text', text: 'Answer' }] })
    const history = await h.json<{ turns: { usage: { inputTokens: number }; reasoningText: string }[] }>('user-a', 'GET', `/conversations/${id}`)
    expect(history.body.turns[0]).toMatchObject({ usage: { inputTokens: 130 }, reasoningText: 'Reason' })
  })

  it('replays encrypted Responses reasoning only for the same model identity', async () => {
    const { run, provider, model, h, ref } = await configured('openai-responses')
    const item = { id: 'rs', type: 'reasoning', summary: [], encrypted_content: 'opaque' }
    upstream.mockImplementation(async () => sse({ type: 'response.output_item.done', item }, { type: 'response.output_text.delta', delta: 'Answer' }, { type: 'response.completed', response: { output: [item], usage: { input_tokens: 120, output_tokens: 30, input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 20 } } } }))
    const first = await run(); const id = String(first.events[0]!.conversationId)
    await run({ conversationId: id, input: 'Next' })
    expect(JSON.parse(String(upstream.mock.calls[1]![1]?.body))).toMatchObject({ store: false, reasoning: { effort: 'high' }, input: expect.arrayContaining([item]) })
    const endpoint = provider.endpoints[0]!
    await h.json('user-a', 'PUT', '/providers', { id: provider.id, name: provider.name, endpoints: [{ ...endpoint, models: [model, { ...model, id: 'other' }] }] })
    await run({ conversationId: id, model: { ...ref, modelId: 'other' } })
    expect(JSON.stringify(JSON.parse(String(upstream.mock.calls[2]![1]?.body)).input)).not.toContain('opaque')
  })

  it('rejects unsupported effort before writing history or making a model request', async () => {
    const { run, h } = await configured('openai-chat')
    const rejected = await run({ reasoningEffort: 'max' })
    expect(rejected.status).toBe(400)
    expect(upstream).not.toHaveBeenCalled()
    expect(await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_chat_turns').first('n')).toBe(0)
  })

  it('keeps omitted capability, clears explicit null, and reports estimates for missing usage', async () => {
    const { run, h, provider, model } = await configured('openai-chat')
    const { reasoning: _reasoning, ...omitted } = model
    const endpoint = provider.endpoints[0]!
    const keep = await h.json<typeof provider[]>('user-a', 'PUT', '/providers', { id: provider.id, name: provider.name, endpoints: [{ ...endpoint, models: [omitted] }] })
    expect(keep.body[0]!.endpoints[0]!.models[0]!.reasoning).toEqual(model.reasoning)
    upstream.mockImplementation(async () => sse({ choices: [{ delta: { content: 'Answer' }, finish_reason: 'stop' }] }, '[DONE]'))
    const result = await run()
    expect(result.events.find((event) => event.kind === 'usage')).toMatchObject({ inputTokens: null, outputTokens: null })
    expect(result.events.filter((event) => event.kind === 'context').at(-1)).toMatchObject({ usage: { source: 'estimated', tokens: expect.any(Number) } })
    const clear = await h.json<typeof provider[]>('user-a', 'PUT', '/providers', { id: provider.id, name: provider.name, endpoints: [{ ...endpoint, models: [{ ...model, reasoning: null }] }] })
    expect(clear.body[0]!.endpoints[0]!.models[0]!.reasoning).toBeNull()
  })
  it('rejects duplicate levels, mismatched dialect and invalid budgets without saving configuration', async () => {
    const { h, provider, model } = await configured('openai-chat')
    const endpoint = provider.endpoints[0]!
    for (const reasoning of [
      { dialect: 'openai', efforts: ['high', 'low', 'high'], budgetTokens: null },
      { dialect: 'anthropic-adaptive', efforts: ['high'], budgetTokens: null },
      { dialect: 'openai', efforts: ['default'], budgetTokens: null },
    ]) {
      const result = await h.json('user-a', 'PUT', '/providers', { id: provider.id, name: provider.name, endpoints: [{ ...endpoint, models: [{ ...model, reasoning }] }] })
      expect(result.status).toBe(400)
    }
    const after = await h.json<typeof provider[]>('user-a', 'GET', '/providers')
    expect(after.body[0]!.endpoints[0]!.models[0]!.reasoning).toEqual(model.reasoning)
  })

  it('preserves partial usage on upstream failure but never marks context as reported', async () => {
    const { run } = await configured('openai-chat')
    upstream.mockImplementation(async () => sse({ choices: [{ delta: { content: 'partial' } }], usage: { prompt_tokens: 12, completion_tokens: 3 } }, { error: { message: 'failed' } }))
    const result = await run()
    expect(result.events.at(-1)).toMatchObject({ status: 'failed' })
    expect(result.events.find((event) => event.kind === 'usage')).toMatchObject({ inputTokens: 12, outputTokens: 3 })
    expect(result.events.filter((event) => event.kind === 'context').at(-1)).toMatchObject({ usage: { source: 'unknown', tokens: null } })
  })
  it('upgrades an old history row without losing its text or reported token counts', async () => {
    const { h, run } = await configured('openai-chat')
    upstream.mockImplementation(async () => sse({ choices: [{ delta: { content: 'Old answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3 } }, '[DONE]'))
    const result = await run()
    const id = String(result.events[0]!.conversationId)
    await h.env.DB.exec("DELETE FROM schema_migrations WHERE version = 16; DELETE FROM app_meta WHERE key = 'database-state-v1'")
    for (const column of ['cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens', 'reasoning_effort', 'reasoning_text', 'context_usage', 'endpoint_id']) await h.env.DB.exec(`ALTER TABLE ai_chat_turns DROP COLUMN ${column}`)
    await h.env.DB.exec('ALTER TABLE ai_models DROP COLUMN reasoning')
    const old = h.env.DB
    const fresh = { prepare: old.prepare.bind(old), batch: old.batch.bind(old), exec: old.exec.bind(old) } as D1Database
    await initializeDatabase({ ...h.env, DB: fresh } as Env)
    const row = await fresh.prepare('SELECT messages, input_tokens AS inputTokens, output_tokens AS outputTokens, context_usage AS contextUsage FROM ai_chat_turns WHERE conversation_id = ?1').bind(id).first<{ messages: string; inputTokens: number; outputTokens: number; contextUsage: string | null }>()
    expect(row).toMatchObject({ inputTokens: 12, outputTokens: 3, contextUsage: null })
    expect(JSON.parse(row?.messages ?? '[]')).toEqual([{ assistant: { text: 'Old answer', tool_calls: [] } }])
  })

  it('recognizes saved models automatically and applies effort only on the current run', async () => {
    const h = await createHarness()
    const saved = await h.json<{ endpoints: { id: string; models: { reasoning: unknown }[] }[] }[]>('user-a', 'PUT', '/providers', {
      name: 'Automatic', endpoints: [{ slug: 'main', baseUrl: 'https://example.com', protocol: 'anthropic-messages', models: [chatModel('claude-sonnet-5-5')] }],
    })
    await addKey(h, 'user-a', saved.body[0]!.endpoints[0]!.id, 'test-key')
    const expected = { dialect: 'anthropic-adaptive', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'] }
    expect(saved.body[0]!.endpoints[0]!.models[0]!.reasoning).toEqual(expected)
    expect(await h.json('user-a', 'GET', '/model-options')).toMatchObject({ status: 200, body: [{ reasoning: expected }] })
    upstream.mockImplementation(async () => sse({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Answer' } }, { type: 'message_stop' }))
    for (const effort of ['default', 'high']) {
      const response = await h.call('user-a', 'POST', '/runs', { purpose: 'chat', skills: [], input: effort, regenerate: false, language: 'en-US', model: { endpointId: saved.body[0]!.endpoints[0]!.id, modelId: 'claude-sonnet-5-5' }, reasoningEffort: effort })
      expect(frames(await response.text()).at(-1)).toMatchObject({ status: 'completed' })
      await h.settle()
    }
    const bodies = upstream.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(bodies[0].thinking).toBeUndefined()
    expect(bodies[1]).toMatchObject({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } })
    expect(await h.env.DB.prepare('SELECT reasoning FROM ai_models').first('reasoning')).toBeNull()
  })

  it('does not infer unsupported protocols or model families and bounds legacy budgets', () => {
    expect(inferReasoning('anthropic/claude-opus-5-5', 'anthropic-messages', 8192)?.efforts).not.toContain('none')
    expect(inferReasoning('claude-sonnet-5-5', 'openai-chat', 8192)).toBeNull()
    expect(inferReasoning('claude-3-5-sonnet', 'anthropic-messages', 8192)).toBeNull()
    expect(inferReasoning('unknown', 'openai-chat', 8192)).toBeNull()
    expect(inferReasoning('o1-mini', 'openai-chat', 8192)).toBeNull()
    expect(inferReasoning('gpt-5-chat-latest', 'openai-chat', 8192)).toBeNull()
    expect(inferReasoning('gpt-5.2', 'openai-responses', 8192)?.efforts).toContain('xhigh')
    expect(inferReasoning('claude-sonnet-4-5', 'anthropic-messages', 4096)?.budgetTokens).toBe(4095)
    expect(inferReasoning('claude-sonnet-4-5', 'anthropic-messages', 1024)).toBeNull()
  })
})
