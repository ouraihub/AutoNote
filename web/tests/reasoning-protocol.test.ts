import { describe, expect, it } from 'vitest'

import {
  addKey,
  chatModel,
  createHarness,
  frames,
} from './support/ai-kit-harness'

import { upstream, sse } from './support/reasoning-test-setup'

describe('reasoning and usage', () => {
  it(
    'writes each line its own reasoning fields from i' + 'nferred capabilities',
    async () => {
      const h = await createHarness()
      const lines = [
        {
          slug: 'ds',
          baseUrl: 'https://api.deepseek.com',
          protocol: 'openai-chat',
          model: 'deepseek-v4-pro',
        },
        {
          slug: 'qw',
          baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v' + '1',
          protocol: 'openai-chat',
          model: 'qwen3-max',
        },
        {
          slug: 'relay',
          baseUrl: 'https://relay.example/v1',
          protocol: 'openai-chat',
          model: 'claude-sonnet-4-5',
        },
        {
          slug: 'resp',
          baseUrl: 'https://relay.example/v1',
          protocol: 'openai-responses',
          model: 'gpt-5.2',
        },
        {
          slug: 'oai',
          baseUrl: 'https://api.openai.com/v1',
          protocol: 'openai-responses',
          model: 'gpt-5.2',
        },
      ] as const
      // Own user: the per-user AI request window (20/min) is shared
      // across this file.
      const user = 'user-lines'
      const saved = await h.json<
        {
          endpoints: {
            id: string
            slug: string
          }[]
        }[]
      >(user, 'PUT', '/providers', {
        name: 'Lines',
        endpoints: lines.map(({ slug, baseUrl, protocol, model }) => ({
          slug,
          baseUrl,
          protocol,
          models: [chatModel(model)],
        })),
      })
      const endpoint = (slug: string) =>
        saved.body[0]!.endpoints.find((e) => e.slug === slug)!.id
      for (const { slug } of lines)
        await addKey(h, user, endpoint(slug), 'test-key')
      upstream.mockImplementation(async (url) =>
        String(url).endsWith('/responses')
          ? sse(
              { type: 'response.output_text.delta', delta: 'A' },
              {
                type: 'response.completed',
                response: {
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              },
            )
          : sse({ choices: [{ delta: { content: 'A' } }] }, '[DONE]'),
      )
      const send = async (
        slug: string,
        modelId: string,
        reasoningEffort: string,
      ) => {
        upstream.mockClear()
        const response = await h.call(user, 'POST', '/runs', {
          purpose: 'chat',
          skills: [],
          input: 'q',
          regenerate: false,
          language: 'en-US',
          model: { endpointId: endpoint(slug), modelId },
          reasoningEffort,
        })
        expect(
          frames(await response.text()).at(-1),
          `${slug} ${reasoningEffort}`,
        ).toMatchObject({ status: 'completed' })
        await h.settle()
        return JSON.parse(String(upstream.mock.calls[0]![1]?.body)) as Record<
          string,
          unknown
        >
      }
      const pick = (body: Record<string, unknown>) =>
        Object.fromEntries(
          [
            'thinking',
            'reasoning_effort',
            'enable_thinking',
            'thinking_budget',
            'reasoning',
          ]
            .filter((key) => key in body)
            .map((key) => [key, body[key]]),
        )
      expect(pick(await send('ds', 'deepseek-v4-pro', 'default'))).toEqual({})
      expect(pick(await send('ds', 'deepseek-v4-pro', 'none'))).toEqual({
        thinking: { type: 'disabled' },
      })
      expect(pick(await send('ds', 'deepseek-v4-pro', 'high'))).toEqual({
        thinking: { type: 'enabled' },
        reasoning_effort: 'high',
      })
      expect(pick(await send('qw', 'qwen3-max', 'none'))).toEqual({
        enable_thinking: false,
      })
      expect(pick(await send('qw', 'qwen3-max', 'auto'))).toEqual({
        enable_thinking: true,
      })
      expect(pick(await send('qw', 'qwen3-max', 'low'))).toEqual({
        enable_thinking: true,
        thinking_budget: 8192,
      })
      expect(pick(await send('relay', 'claude-sonnet-4-5', 'default'))).toEqual(
        {},
      )
      expect(pick(await send('relay', 'claude-sonnet-4-5', 'high'))).toEqual({
        reasoning_effort: 'high',
      })
      expect(pick(await send('resp', 'gpt-5.2', 'high'))).toEqual({
        reasoning: { effort: 'high' },
      })
      expect(pick(await send('oai', 'gpt-5.2', 'high'))).toEqual({
        reasoning: { effort: 'high', summary: 'auto' },
      })
    },
  )
})
