import { afterEach, beforeEach, vi } from 'vitest'

import type { Conversation } from '@ouraihub/aether-ui/ports'

import {
  addKey,
  chatModel,
  fixture,
  frames,
  streamOf,
  type Harness,
} from './ai-kit-harness'

export const KEY = 'sk-test-abcdefghijklmnop'

export const PROTOCOLS = [
  'anthropic-messages',
  'openai-chat',
  'openai-responses',
] as const

export const expected = JSON.parse(
  fixture('sse/expect.json').toString(),
) as Record<
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

export const fetchMock = vi.fn<typeof fetch>()

export const testClock = { now: Date.now() }

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  vi.useFakeTimers({ toFake: ['Date'] })
  testClock.now += 120000
  vi.setSystemTime(testClock.now)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

export async function saveProvider(
  h: Harness,
  user = 'user-a',
  protocol: (typeof PROTOCOLS)[number] = 'openai-chat',
) {
  const { body } = await h.json<
    {
      id: string
      endpoints: {
        id: string
      }[]
    }[]
  >(user, 'PUT', '/providers', {
    name: 'Acme',
    endpoints: [
      {
        slug: 'main',
        baseUrl: 'https://api.example.com',
        protocol,
        models: [chatModel('m1')],
      },
    ],
  })
  const provider = body.at(-1)!
  const endpointId = provider.endpoints[0]!.id
  await addKey(h, user, endpointId, KEY)
  return { providerId: provider.id, endpointId }
}

export async function run(
  h: Harness,
  body: Record<string, unknown>,
  user = 'user-a',
) {
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
    events: response.headers
      .get('content-type')
      ?.startsWith('text/event-stream')
      ? frames(text)
      : [],
    text,
  }
}

export type ProviderDto = {
  id: string
  name: string
  enabled: boolean
  endpoints: {
    id: string
    slug: string
    keyStrategy?: string
    keys: {
      id: string
      label: string
      enabled: boolean
      masked: string | null
      readable: boolean
      exhaustedUntil?: number | null
      exhaustedReason?: string | null
    }[]
    probeUrl: string
    models: unknown[]
  }[]
}

export const textStream = (text: string) =>
  new Response(
    streamOf(
      new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":' +
          `${JSON.stringify(text)}` +
          ('}}]}\n\ndata: {"choices":[{"delta":{},"finish_reas' +
            'on":"stop"}]}\n\ndata: {"choices":[],"usage":{"pro' +
            'mpt_tokens":3,"completion_tokens":2}}\n\ndata: [DO' +
            'NE]\n\n'),
      ),
    ),
  )

export type ConversationDto = Conversation
