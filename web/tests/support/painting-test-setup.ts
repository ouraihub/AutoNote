import { afterEach, beforeEach, vi } from 'vitest'

import {
  addKey,
  chatModel,
  createHarness,
  fixture,
  frames,
  streamOf,
  type Harness,
} from './ai-kit-harness'

export const KEY = 'sk-test-abcdefghijklmnop'

export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAA' +
  'C0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

export const PROMPT = '{"prompt":"a cat"}'

export const fetchMock = vi.fn<typeof fetch>()

export type Protocol = 'openai-chat' | 'openai-responses' | 'anthropic-messages'

export const sse = (events: unknown[]) =>
  new TextEncoder().encode(
    events
      .map(
        (event) =>
          'data: ' +
          `${typeof event === 'string' ? event : JSON.stringify(event)}` +
          '\n\n',
      )
      .join(''),
  )

export const TOOL_ROUND: Record<Protocol, Uint8Array> = {
  'openai-chat': sse([
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_1',
                type: 'function',
                function: { name: 'generate_image', arguments: '' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: PROMPT } }],
          },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    '[DONE]',
  ]),
  'anthropic-messages': sse([
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call_1',
        name: 'generate_image',
        input: {},
      },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: PROMPT },
    },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { output_tokens: 3 },
    },
    { type: 'message_stop' },
  ]),
  'openai-responses': sse([
    {
      type: 'response.output_item.added',
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'generate_image',
        arguments: '',
      },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      delta: PROMPT,
    },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 5, output_tokens: 3 }, output: [] },
    },
  ]),
}

export const testClock = { now: Date.now() }

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  // Run and key routes are rate-limited per user per minute; each
  // test gets its own window.
  vi.useFakeTimers({ toFake: ['Date'] })
  testClock.now += 120000
  vi.setSystemTime(testClock.now)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

export async function setup(
  protocol: Protocol,
  { bind = true, supportsTools = null as boolean | null } = {},
) {
  const h = await createHarness()
  const { body } = await h.json<
    {
      endpoints: {
        id: string
      }[]
    }[]
  >('user-a', 'PUT', '/providers', {
    name: 'P',
    endpoints: [
      {
        slug: 'main',
        baseUrl: 'https://api.example.com',
        protocol,
        models: [
          { ...chatModel('m1'), supportsTools },
          { ...chatModel('img1'), modelType: 'image' },
        ],
      },
    ],
  })
  const endpointId = body[0]!.endpoints[0]!.id
  await addKey(h, 'user-a', endpointId, KEY)
  if (bind)
    await h.env.DB.prepare(
      'INSERT INTO ai_roles (user_id, role, endpoint_id' +
        ", model_id) VALUES ('user-a', 'painting', ?1, 'i" +
        "mg1')",
    )
      .bind(endpointId)
      .run()
  return { h, model: { endpointId, modelId: 'm1' } }
}

export /** The chat model answers with `rounds` (tool calls, then the
 * text fixture); the painting model with `paint`.
 */
function upstream(
  protocol: Protocol,
  toolRounds: number,
  paint: () => Response = () => Response.json({ data: [{ b64_json: PNG }] }),
) {
  let chats = 0
  fetchMock.mockImplementation(async (input) => {
    if (String(input).endsWith('/images/generations')) return paint()
    const round = chats++
    const bytes =
      round < toolRounds
        ? new TextEncoder().encode(
            new TextDecoder()
              .decode(TOOL_ROUND[protocol])
              .replaceAll('call_1', `call_${round + 1}`)
              .replaceAll('fc_1', `fc_${round + 1}`),
          )
        : new Uint8Array(fixture(`sse/${protocol}/text.sse`))
    return new Response(streamOf(bytes))
  })
}

export async function run(h: Harness, body: Record<string, unknown>) {
  const response = await h.call('user-a', 'POST', '/runs', {
    purpose: 'chat',
    skills: [],
    input: 'Draw a cat',
    regenerate: false,
    language: 'en-US',
    ...body,
  })
  const text = await response.text()
  await h.settle()
  return { status: response.status, events: frames(text), text }
}

export const calls = (suffix: string) =>
  fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix))

export const bodyOf = (call: Parameters<typeof fetch>) =>
  JSON.parse(String(call[1]?.body)) as Record<string, unknown>

export const CHAT_PATH: Record<Protocol, string> = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
}
