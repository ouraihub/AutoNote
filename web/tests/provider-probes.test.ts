import { describe, expect, it } from 'vitest'

import { addKey, createHarness } from './support/ai-kit-harness'
import { KEY, fetchMock, saveProvider } from './support/ai-kit-test-setup'

describe('provider routes', () => {
  it(
    'probes drafts with inferred models and reports b' +
      'locked or missing keys as results',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      fetchMock.mockResolvedValue(
        Response.json({
          data: [{ id: 'gpt-4o' }, { id: 'claude-x' }, { id: 'gpt-4o' }],
        }),
      )
      const ok = await h.json<{
        models: {
          id: string
          group: string | null
        }[]
        error: unknown
      }>('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://api.example.com/',
        protocol: 'anthropic-messages',
        endpointId,
      })
      expect(ok.body).toMatchObject({
        probeUrl: 'https://api.example.com/v1/models',
        error: null,
        models: [
          { id: 'claude-x', group: 'claude' },
          { id: 'gpt-4o', group: 'gpt' },
        ],
      })
      expect(fetchMock.mock.calls[0]![1]?.redirect).toBe('manual')
      const probeHeaders = new Headers(fetchMock.mock.calls[0]![1]?.headers)
      expect(probeHeaders.get('x-api-key')).toBe(KEY)
      expect(probeHeaders.get('anthropic-version')).toBe('2023-06-01')
      const missing = await h.json('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
      })
      expect(missing.body).toMatchObject({
        models: [],
        error: { kind: 'missing_key' },
      })
      const blocked = await h.json('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://10.0.0.1',
        protocol: 'openai-chat',
        endpointId,
      })
      expect(blocked.body).toMatchObject({ error: { kind: 'blocked_address' } })
      fetchMock.mockResolvedValue(
        new Response('denied sk-test-abcdefghijklmnop', { status: 401 }),
      )
      const denied = await h.json('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
        endpointId,
      })
      expect(denied.body).toMatchObject({
        error: { kind: 'unauthorized', status: 401 },
      })
      expect(JSON.stringify(denied.body)).not.toContain(KEY)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it(
    'suggests Anthropic Messages only when a claude r' +
      'elay validates the empty request there',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      const reply = (
        messages: number,
        listed = [{ id: 'claude-sonnet-5-5' }, { id: 'gpt-6-sol' }],
      ) =>
        fetchMock.mockImplementation(async (url) =>
          String(url).endsWith('/messages')
            ? new Response('{"error":{}}', { status: messages })
            : Response.json({ data: listed }),
        )
      const check = (protocol: string) =>
        h.json<{
          error: unknown
          suggestedProtocol: string | null
        }>('user-a', 'POST', '/probe', {
          kind: 'draft',
          baseUrl: 'https://api.example.com',
          protocol,
          endpointId,
        })
      for (const status of [400, 422]) {
        reply(status)
        fetchMock.mockClear()
        expect((await check('openai-chat')).body).toMatchObject({
          error: null,
          suggestedProtocol: 'anthropic-messages',
        })
        const [url, init] = fetchMock.mock.calls[1]!
        expect(String(url)).toBe('https://api.example.com/v1/messages')
        expect(init).toMatchObject({
          method: 'POST',
          redirect: 'manual',
        })
        const headers = new Headers(init?.headers)
        expect(headers.get('x-api-key')).toBe(KEY)
        expect(headers.get('anthropic-version')).toBe('2023-06-01')
        expect(JSON.parse(String(init!.body))).toEqual({
          model: 'claude-sonnet-5-5',
          max_tokens: 1,
          messages: [],
        })
      }
      for (const status of [404, 401, 500]) {
        reply(status)
        expect((await check('openai-chat')).body).toMatchObject({
          error: null,
          suggestedProtocol: null,
        })
      }
      reply(400)
      fetchMock.mockClear()
      expect(
        (await check('anthropic-messages')).body.suggestedProtocol,
      ).toBeNull()
      reply(400, [{ id: 'gpt-6-sol' }])
      expect((await check('openai-chat')).body.suggestedProtocol).toBeNull()
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )

  it(
    'probes with failover across keys, or with one ch' + 'osen key',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      const second = await addKey(
        h,
        'user-a',
        endpointId,
        'sk-second-0123456789',
      )
      const sent = (index: number) =>
        new Headers(fetchMock.mock.calls[index]![1]!.headers).get(
          'authorization',
        )
      fetchMock.mockImplementation(async (_url, init) => {
        const authorization = new Headers(init!.headers).get('authorization')
        return authorization === `Bearer ${KEY}`
          ? new Response('no', { status: 429 })
          : Response.json({ data: [{ id: 'gpt-4o' }] })
      })
      const ok = await h.json('user-a', 'POST', '/probe', {
        kind: 'saved',
        endpointId,
      })
      expect(ok.body).toMatchObject({ error: null, models: [{ id: 'gpt-4o' }] })
      expect(fetchMock.mock.calls.map((_, index) => sent(index))).toEqual([
        `Bearer ${KEY}`,
        'Bearer sk-second-0123456789',
      ])
      fetchMock.mockClear()
      const only = await h.json('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
        endpointId,
        keyId: second,
      })
      expect(only.body).toMatchObject({ error: null })
      expect(fetchMock.mock.calls.map((_, index) => sent(index))).toEqual([
        'Bearer sk-second-0123456789',
      ])
      const unknown = await h.json('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
        endpointId,
        keyId: 'nope',
      })
      expect(unknown).toMatchObject({
        status: 404,
        body: { error: { details: { entity: 'key' } } },
      })
    },
  )
})
