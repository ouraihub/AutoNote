import { describe, expect, it, vi } from 'vitest'

import { addKey, createHarness } from './support/ai-kit-harness'
import {
  KEY,
  fetchMock,
  saveProvider,
  run,
  ProviderDto,
  textStream,
} from './support/ai-kit-test-setup'

describe('run and history routes', () => {
  it(
    'explicit cancel from another worker isolate stop' +
      's a run whose stream is still open',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      let upstreamAborted = false
      fetchMock.mockImplementation(async (_url, init) => {
        const signal = init?.signal
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"partial"}' +
                    '}]}\n\n',
                ),
              )
              signal?.addEventListener('abort', () => {
                upstreamAborted = true
                controller.error(new Error('aborted'))
              })
            },
          }),
        )
      })
      const response = await h.call('user-a', 'POST', '/runs', {
        purpose: 'chat',
        model: { endpointId, modelId: 'm1' },
        skills: [],
        input: 'Hi',
        regenerate: false,
        language: 'en-US',
      })
      const reader = response.body!.getReader()
      let seen = ''
      while (!seen.includes('partial'))
        seen += new TextDecoder().decode((await reader.read()).value)
      const runId = /"runId":"([^"]+)"/.exec(seen)![1]!
      // A fresh module instance is a separate isolate: its in-memory
      // run registry cannot see this run.
      vi.resetModules()
      const isolate = (await import('../src/worker/routes/ai-kit')).aiKitRoutes
      const other = await createHarness(h, isolate)
      expect(
        (await other.call('user-b', 'POST', `/runs/${runId}/cancel`)).status,
      ).toBe(404)
      expect(upstreamAborted).toBe(false)
      const cancel = await other.call('user-a', 'POST', `/runs/${runId}/cancel`)
      expect(upstreamAborted).toBe(true)
      expect(await cancel.json()).toMatchObject({
        runId,
        status: 'cancelled',
        cancelRequested: true,
      })
      await reader.cancel()
      await h.settle()
    },
  )

  it('fails before model request when explicit search ' + 'fails', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    await h.env.DB.prepare(
      'INSERT INTO ai_roles (user_id, role, endpoint_id' +
        ", model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
    )
      .bind(endpointId)
      .run()
    fetchMock.mockResolvedValue(new Response('search failed', { status: 503 }))
    const { events } = await run(h, {
      model: { endpointId, modelId: 'm1' },
      webSearch: true,
    })
    expect(events.at(-1)).toMatchObject({
      kind: 'end',
      status: 'failed',
      error: { code: 'upstream', details: { status: 503 } },
    })
    expect(events.some((event) => event.kind === 'search_start')).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(
      await h.env.DB.prepare(
        'SELECT status, error_code AS errorCode FROM ai_c' + 'hat_turns',
      ).first(),
    ).toMatchObject({
      status: 'failed',
      errorCode: 'upstream',
    })
  })

  it(
    'searches the original input on regeneration and ' +
      'sends one model request per run',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id' +
          ", model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
      )
        .bind(endpointId)
        .run()
      fetchMock.mockImplementation(async (url, init) => {
        if (String(url).includes('mcp.exa.ai')) {
          const body = JSON.parse(String(init?.body)) as {
            params: {
              arguments: {
                query: string
              }
            }
          }
          return Response.json({
            result: {
              content: [
                {
                  text:
                    'Title: ' +
                    `${body.params.arguments.query}` +
                    '\nURL: https://example.com/source\nText: source',
                },
              ],
            },
          })
        }
        return textStream('ok')
      })
      const first = await run(h, {
        model: { endpointId, modelId: 'm1' },
        input: 'original question',
        webSearch: true,
      })
      const conversationId = String(first.events[0]!.conversationId)
      const regenerated = await run(h, {
        model: { endpointId, modelId: 'm1' },
        input: '',
        conversationId,
        regenerate: true,
        webSearch: true,
      })
      expect(regenerated.events.at(-1)).toEqual({
        kind: 'end',
        status: 'completed',
      })
      const searchCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).includes('mcp.exa.ai'),
      )
      expect(searchCalls).toHaveLength(2)
      expect(
        searchCalls.map(
          ([, init]) => JSON.parse(String(init?.body)).params.arguments.query,
        ),
      ).toEqual(['original question', 'original question'])
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => !String(url).includes('mcp.exa.ai'),
        ),
      ).toHaveLength(2)
    },
  )

  it(
    'cancels during pre-search without requesting the' + ' model',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      await h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id' +
          ", model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
      )
        .bind(endpointId)
        .run()
      fetchMock.mockImplementation(
        async (_url, init) =>
          await new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              {
                once: true,
              },
            ),
          ),
      )
      const response = await h.call('user-a', 'POST', '/runs', {
        purpose: 'chat',
        model: { endpointId, modelId: 'm1' },
        skills: [],
        input: 'cancel me',
        regenerate: false,
        language: 'en-US',
        webSearch: true,
      })
      const reader = response.body!.getReader()
      const accepted = await reader.read()
      expect(new TextDecoder().decode(accepted.value)).toContain('accepted')
      await reader.cancel()
      await h.settle()
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it('maps upstream HTTP errors to failed end events', async () => {
    const h = await createHarness()
    const { endpointId } = await saveProvider(h)
    fetchMock.mockResolvedValue(new Response('slow down', { status: 429 }))
    const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
    expect(events.at(-1)).toEqual({
      kind: 'end',
      status: 'failed',
      error: {
        code: 'rate_limited',
        message: '429: slow down',
        details: { status: 429 },
      },
    })
    expect(events.filter((event) => event.kind === 'end')).toHaveLength(1)
    expect(
      events.filter((event) => event.kind === 'context').at(-1),
    ).toMatchObject({
      usage: { source: 'unknown', tokens: null },
    })
    const turn = await h.env.DB.prepare(
      'SELECT status, error_code AS errorCode FROM ai_c' + 'hat_turns',
    ).first()
    expect(turn).toEqual({ status: 'failed', errorCode: 'rate_limited' })
  })

  it(
    'rotates enabled keys, fails over on 401 before o' +
      'utput, and fails when every key is rejected',
    async () => {
      const h = await createHarness()
      const { endpointId } = await saveProvider(h)
      const SECOND = 'sk-second-0123456789'
      const secondId = await addKey(h, 'user-a', endpointId, SECOND)
      const model = { model: { endpointId, modelId: 'm1' } }
      const sent = () =>
        fetchMock.mock.calls.map(
          ([, init]) => (init!.headers as Record<string, string>).authorization,
        )
      fetchMock.mockImplementation(async () => textStream('ok'))
      for (let index = 0; index < 4; index++) await run(h, model)
      expect(sent()).toEqual([
        `Bearer ${KEY}`,
        `Bearer ${SECOND}`,
        `Bearer ${KEY}`,
        `Bearer ${SECOND}`,
      ])
      fetchMock.mockReset()
      fetchMock.mockImplementation(async (_url, init) =>
        (init!.headers as Record<string, string>).authorization ===
        `Bearer ${KEY}`
          ? new Response(`bad ${KEY}`, { status: 401 })
          : textStream('fallback'),
      )
      const fallback = await run(h, model)
      expect(sent()).toEqual([`Bearer ${KEY}`, `Bearer ${SECOND}`])
      expect(fallback.events.at(-1)).toMatchObject({
        kind: 'end',
        status: 'completed',
      })
      fetchMock.mockReset()
      fetchMock.mockImplementation(
        async () => new Response(`denied ${KEY} ${SECOND}`, { status: 401 }),
      )
      const denied = await run(h, model)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(denied.events.at(-1)).toMatchObject({
        kind: 'end',
        status: 'failed',
        error: { code: 'unauthorized', details: { status: 401 } },
      })
      expect(denied.text).not.toContain(KEY)
      expect(denied.text).not.toContain(SECOND)
      fetchMock.mockReset()
      fetchMock.mockImplementation(
        async () => new Response('boom', { status: 500 }),
      )
      await run(h, model)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      await h.json('user-a', 'PUT', '/endpoint-keys', {
        endpointId,
        id: secondId,
        enabled: false,
      })
      const { body } = await h.json<ProviderDto[]>(
        'user-a',
        'GET',
        '/providers',
      )
      await h.json('user-a', 'PUT', '/endpoint-keys', {
        endpointId,
        id: body[0]!.endpoints[0]!.keys[0]!.id,
        enabled: false,
      })
      fetchMock.mockReset()
      const missing = await run(h, model)
      expect(missing.text).toContain('missing_key')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )
})
