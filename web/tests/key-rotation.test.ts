import { describe, expect, it, vi } from 'vitest'

import { upstreamFailure } from '../src/worker/ai/kit'
import { resolveModel, withKeys } from '../src/worker/ai/providers'

import { encryptAiKey } from '../src/worker/lib/crypto'
import {
  addKey,
  chatModel,
  createHarness,
  streamOf,
} from './support/ai-kit-harness'
import {
  KEY,
  fetchMock,
  testClock,
  saveProvider,
  run,
  ProviderDto,
  textStream,
} from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'fill-first sticks to the first key, sets used-up' +
      ' and rate-limited keys aside, and restores them',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      const SECOND = 'sk-second-0123456789'
      const secondId = await addKey(h, 'user-a', endpointId, SECOND)
      const endpoint = {
        id: endpointId,
        slug: 'main',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
        models: [chatModel('m1')],
      }
      await h.json('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'Acme',
        endpoints: [{ ...endpoint, keyStrategy: 'fill_first' }],
      })
      const model = { model: { endpointId, modelId: 'm1' } }
      const sent = () =>
        fetchMock.mock.calls.map(
          ([, init]) => (init!.headers as Record<string, string>).authorization,
        )
      const keys = async () =>
        (await h.json<ProviderDto[]>('user-a', 'GET', '/providers')).body[0]!
          .endpoints[0]!
      const reply =
        (first: Response) => async (_url: unknown, init?: RequestInit) =>
          (init!.headers as Record<string, string>).authorization ===
          `Bearer ${KEY}`
            ? first
            : textStream('ok')
      fetchMock.mockImplementation(async () => textStream('ok'))
      for (let index = 0; index < 3; index++) await run(h, model)
      expect(sent()).toEqual([
        `Bearer ${KEY}`,
        `Bearer ${KEY}`,
        `Bearer ${KEY}`,
      ])
      expect((await keys()).keyStrategy).toBe('fill_first')
      // A 5xx without quota wording is not a key problem: no switch,
      // no mark.
      fetchMock.mockReset()
      fetchMock.mockImplementation(reply(new Response('boom', { status: 500 })))
      expect((await run(h, model)).events.at(-1)).toMatchObject({
        status: 'failed',
        error: { code: 'upstream' },
      })
      expect(sent()).toEqual([`Bearer ${KEY}`])
      // Plain 429: switch, cool down for Retry-After, then the first
      // key is used again.
      fetchMock.mockReset()
      // "rate limit exceeded" / "quota exceeded per minute" are plain
      // rate limits: a cooldown, never the 24-hour pause.
      fetchMock.mockImplementation(
        reply(
          new Response(
            '{"error":{"message":"Rate limit exceeded: quota ' +
              'exceeded per minute"}}',
            {
              status: 429,
              headers: { 'retry-after': '30' },
            },
          ),
        ),
      )
      expect((await run(h, model)).events.at(-1)).toMatchObject({
        status: 'completed',
      })
      expect(sent()).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`])
      expect((await keys()).keys[0]).toMatchObject({
        exhaustedUntil: testClock.now + 30000,
        exhaustedReason: expect.stringMatching(/^HTTP 429 /),
      })
      vi.setSystemTime((testClock.now += 31000))
      fetchMock.mockReset()
      fetchMock.mockImplementation(async () => textStream('ok'))
      await run(h, model)
      expect(sent()).toEqual([`Bearer ${KEY}`])
      // Quota wording on a 400: set aside for 24 hours and skipped by
      // later requests.
      fetchMock.mockReset()
      fetchMock.mockImplementation(
        reply(new Response(`{"error":"余额不足 ${KEY}"}`, { status: 400 })),
      )
      expect((await run(h, model)).events.at(-1)).toMatchObject({
        status: 'completed',
      })
      const marked = (await keys()).keys[0]!
      expect(marked).toMatchObject({ exhaustedUntil: testClock.now + 86400000 })
      expect(marked.exhaustedReason).toContain('余额不足')
      expect(marked.exhaustedReason).not.toContain(KEY)
      fetchMock.mockReset()
      fetchMock.mockImplementation(async () => textStream('ok'))
      await run(h, model)
      expect(sent()).toEqual([`Bearer ${SECOND}`])
      // Once streaming started, a later error is the caller's: no
      // switch, no mark.
      fetchMock.mockReset()
      fetchMock.mockImplementation(
        async () =>
          new Response(
            streamOf(
              new TextEncoder().encode(
                'data: {"error":{"message":"quota exceeded"}}\n\n',
              ),
            ),
            {
              headers: { 'content-type': 'text/event-stream' },
            },
          ),
      )
      expect((await run(h, model)).events.at(-1)).toMatchObject({
        status: 'failed',
      })
      expect(sent()).toEqual([`Bearer ${SECOND}`])
      expect((await keys()).keys[1]).toMatchObject({ exhaustedUntil: null })
      // Every key used up: rate_limited before any upstream call.
      fetchMock.mockReset()
      fetchMock.mockImplementation(
        async () => new Response('denied', { status: 402 }),
      )
      const lastKey = await run(h, model)
      expect(lastKey.text).toContain('keys_exhausted')
      expect(lastKey.text).toContain(
        new Date(testClock.now + 86400000).toISOString(),
      )
      fetchMock.mockReset()
      const exhausted = await run(h, model)
      expect(fetchMock).not.toHaveBeenCalled()
      expect(exhausted.response.status).toBe(429)
      expect(exhausted.text).toContain('keys_exhausted')
      expect(exhausted.text).toContain('Acme · main')
      await h.json('user-a', 'PUT', '/endpoint-keys', {
        endpointId,
        id: secondId,
        restore: true,
      })
      expect((await keys()).keys[1]).toMatchObject({
        exhaustedUntil: null,
        exhaustedReason: null,
      })
      fetchMock.mockImplementation(async () => textStream('ok'))
      await run(h, model)
      expect(sent()).toEqual([`Bearer ${SECOND}`])
      // Switching back to rotation ignores and hides the marks.
      await h.json('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'Acme',
        endpoints: [{ ...endpoint, keyStrategy: 'round_robin' }],
      })
      expect((await keys()).keys[0]).toMatchObject({
        exhaustedUntil: null,
        exhaustedReason: null,
      })
      fetchMock.mockReset()
      fetchMock.mockImplementation(async () => textStream('ok'))
      await run(h, model)
      await run(h, model)
      expect(sent().sort()).toEqual(
        [`Bearer ${KEY}`, `Bearer ${SECOND}`].sort(),
      )
    },
  )

  it(
    'fill-first suspends each duplicate credential ro' +
      'w and does not retry it on the next request',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      const duplicateId = await addKey(
        h,
        'user-a',
        endpointId,
        'sk-distinct-backup',
      )
      await h.env.DB.prepare(
        'UPDATE ai_endpoint_keys SET key_ciphertext = ?1 ' + 'WHERE id = ?2',
      )
        .bind(await encryptAiKey(h.env, duplicateId, KEY), duplicateId)
        .run()
      await h.json('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'Acme',
        endpoints: [
          {
            id: endpointId,
            slug: 'main',
            baseUrl: 'https://api.example.com',
            protocol: 'openai-chat',
            models: [chatModel('m1')],
            keyStrategy: 'fill_first',
          },
        ],
      })
      const connection = await resolveModel(h.env, 'user-a', {
        endpointId,
        modelId: 'm1',
      })
      await expect(
        withKeys(connection, async () => {
          throw upstreamFailure(402, 'insufficient balance', [KEY])
        }),
      ).rejects.toMatchObject({
        code: 'rate_limited',
        resumeAt: testClock.now + 86400000,
      })
      const rows = await h.env.DB.prepare(
        'SELECT exhausted_until AS until FROM ai_endpoint' +
          '_keys WHERE endpoint_id = ?1',
      )
        .bind(endpointId)
        .all<{
          until: number | null
        }>()
      expect(rows.results.map((row) => row.until)).toEqual([
        testClock.now + 86400000,
        testClock.now + 86400000,
      ])
      await expect(
        resolveModel(h.env, 'user-a', { endpointId, modelId: 'm1' }),
      ).rejects.toMatchObject({
        code: 'rate_limited',
        details: { reason: 'keys_exhausted' },
      })
    },
  )

  it(
    'fill-first keeps a set-aside key out of later ro' +
      'unds of the same request and never falls back to' +
      ' no key',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      const SECOND = 'sk-second-0123456789'
      await addKey(h, 'user-a', endpointId, SECOND)
      await h.json('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'Acme',
        endpoints: [
          {
            id: endpointId,
            slug: 'main',
            baseUrl: 'https://api.example.com',
            protocol: 'openai-chat',
            models: [chatModel('m1')],
            keyStrategy: 'fill_first',
          },
        ],
      })
      // One Connection serves every tool round of a run; drive
      // withKeys twice on it like two rounds.
      const connection = await resolveModel(h.env, 'user-a', {
        endpointId,
        modelId: 'm1',
      })
      const tried: (string | null)[] = []
      const round = (failing: (string | null)[]) =>
        withKeys(connection, async (key) => {
          tried.push(key)
          if (failing.includes(key))
            throw upstreamFailure(402, 'insufficient balance', [])
          return key
        })
      expect(await round([KEY])).toBe(SECOND)
      expect(await round([])).toBe(SECOND)
      expect(tried).toEqual([KEY, SECOND, SECOND])
      await expect(round([SECOND])).rejects.toMatchObject({
        code: 'rate_limited',
        details: { reason: 'keys_exhausted' },
      })
      await expect(round([])).rejects.toMatchObject({
        code: 'rate_limited',
        details: { reason: 'keys_exhausted' },
      })
      expect(tried.at(-1)).toBe(SECOND)
    },
  )

  it(
    'fill-first retries the next key when the upstrea' +
      'm drops the stream before the first chunk',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      const SECOND = 'sk-second-0123456789'
      await addKey(h, 'user-a', endpointId, SECOND)
      await h.json('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'Acme',
        endpoints: [
          {
            id: endpointId,
            slug: 'main',
            baseUrl: 'https://api.example.com',
            protocol: 'openai-chat',
            models: [chatModel('m1')],
            keyStrategy: 'fill_first',
          },
        ],
      })
      const dropped = () =>
        new Response(
          new ReadableStream({
            pull: (controller) =>
              controller.error(new TypeError('socket hang up')),
          }),
          {
            headers: { 'content-type': 'text/event-stream' },
          },
        )
      fetchMock.mockImplementation(async (_url, init) =>
        (init!.headers as Record<string, string>).authorization ===
        `Bearer ${KEY}`
          ? dropped()
          : textStream('ok'),
      )
      const result = await run(h, { model: { endpointId, modelId: 'm1' } })
      expect(result.events.at(-1)).toMatchObject({
        kind: 'end',
        status: 'completed',
      })
      expect(
        fetchMock.mock.calls.map(
          ([, init]) => (init!.headers as Record<string, string>).authorization,
        ),
      ).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`])
      const { body } = await h.json<ProviderDto[]>(
        'user-a',
        'GET',
        '/providers',
      )
      expect(body[0]!.endpoints[0]!.keys[0]).toMatchObject({
        exhaustedUntil: null,
      })
    },
  )

  it(
    'persists authoritative owner-scoped snapshots wi' +
      'thout retaining prompt or credentials',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      fetchMock.mockImplementation(async () => textStream('Answer'))
      const result = await run(h, {
        model: { endpointId, modelId: 'm1' },
        input: 'private prompt marker',
      })
      const accepted = result.events[0]!
      const snapshot = await h.json('user-a', 'GET', `/runs/${accepted.runId}`)
      expect(snapshot.status).toBe(200)
      expect(snapshot.body).toMatchObject({
        runId: accepted.runId,
        conversationId: accepted.conversationId,
        turnId: accepted.turnId,
        status: 'completed',
        cancelRequested: false,
      })
      expect(JSON.stringify(snapshot.body)).not.toContain(
        'private prompt marker',
      )
      expect(JSON.stringify(snapshot.body)).not.toContain(KEY)
      expect(
        (await h.json('user-b', 'GET', `/runs/${accepted.runId}`)).status,
      ).toBe(404)
    },
  )
})
