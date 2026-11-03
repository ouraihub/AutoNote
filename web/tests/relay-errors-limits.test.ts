import { describe, expect, it, vi } from 'vitest'

import { sha256Hex } from '../src/worker/lib/encoding'

import { addKey } from './support/ai-kit-harness'
import {
  fetchMock,
  provider,
  setup,
  sentAuth,
} from './support/relay-test-setup'

describe('relay forwarding', () => {
  it(
    'moves to the next line when a line is used up, p' +
      'asses other upstream errors through, and never s' +
      'ends the body twice on 5xx',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      await provider(
        h,
        'First',
        'https://first.example.com',
        'sk-first-0123456789',
      )
      await provider(
        h,
        'Second',
        'https://second.example.com',
        'sk-second-0123456789',
      )
      const chat = () =>
        relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'm1' },
          auth,
        )
      fetchMock.mockImplementation(async (url) =>
        String(url).startsWith('https://first.')
          ? new Response('{"error":"余额不足"}', { status: 402 })
          : Response.json({ id: 'from-second' }),
      )
      const fallback = await chat()
      expect(await fallback.json()).toEqual({ id: 'from-second' })
      expect([sentAuth(0), sentAuth(1)]).toEqual([
        'Bearer sk-first-0123456789',
        'Bearer sk-second-0123456789',
      ])
      fetchMock.mockReset()
      fetchMock.mockResolvedValue(
        new Response('{"error":{"message":"bad schema"}}', {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      )
      const rejected = await chat()
      expect(rejected.status).toBe(400)
      expect(await rejected.text()).toBe('{"error":{"message":"bad schema"}}')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      fetchMock.mockReset()
      fetchMock.mockResolvedValue(new Response('boom', { status: 503 }))
      expect((await chat()).status).toBe(503)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    },
  )

  it(
    'caps manual keys at 8 and GitHub run keys at 32 ' +
      'concurrent requests, answering 429 with Retry-Af' +
      'ter',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      await provider(
        h,
        'Acme',
        'https://acme.example.com',
        'sk-acme-0123456789',
      )
      const github = `anr_${'g'.repeat(43)}`
      await h.env.DB.prepare(
        'INSERT INTO relay_access_keys (id, user_id, name' +
          ', key_hash, created_at, expires_at, github_run)\n' +
          "      VALUES ('github', 'user-a', 'GitHub', ?1, " +
          "0, ?2, 'acme/app#1#1')",
      )
        .bind(await sha256Hex(github), Date.now() + 100000)
        .run()
      const chat = (headers: Record<string, string>) =>
        relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'm1' },
          headers,
        )
      for (const [headers, cap] of [
        [auth, 8],
        [{ authorization: `Bearer ${github}` }, 32],
      ] as const) {
        fetchMock.mockReset()
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => (release = resolve))
        fetchMock.mockImplementation(async () => {
          await gate
          return Response.json({ ok: true })
        })
        const running = Array.from({ length: cap }, () => chat(headers))
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(cap))
        const busy = await chat(headers)
        expect(busy.status).toBe(429)
        expect(busy.headers.get('retry-after')).toBe('2')
        expect(await busy.json()).toMatchObject({
          error: {
            type: 'rate_limit_error',
            message: expect.stringContaining(`at most ${cap} concurrent`),
          },
        })
        release()
        await Promise.all(
          (await Promise.all(running)).map((response) => response.text()),
        )
        fetchMock.mockResolvedValue(Response.json({ ok: true }))
        expect((await chat(headers)).status).toBe(200)
      }
    },
  )

  it(
    'deduplicates repeated endpoints and qualifies on' +
      'ly later providers per protocol',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      const first = await provider(
        h,
        'First',
        'https://first.example.com',
        'sk-first-0123456789',
        ['m1', 'Second/m1', 'shared'],
      )
      const second = await provider(
        h,
        'Second',
        'https://second.example.com',
        'sk-second-0123456789',
        ['m1', 'shared'],
      )
      await h.env.DB.prepare(
        'INSERT INTO ai_endpoints (id, user_id, provider_' +
          'id, slug, base_url, protocol, position)\n      SE' +
          "LECT 'duplicate', user_id, provider_id, 'duplica" +
          "te', base_url, protocol, 1 FROM ai_endpoints WHE" +
          'RE id = ?1',
      )
        .bind(first)
        .run()
      await h.env.DB.prepare(
        'INSERT INTO ai_models (user_id, endpoint_id, mod' +
          'el_id, model_type, type_source, position)\n      ' +
          "VALUES ('user-a', 'duplicate', 'm1', 'chat', 'us" +
          "er', 0)",
      ).run()
      const listed = (await (
        await relay.request('GET', '/relay/v1/models', undefined, auth)
      ).json()) as {
        data: {
          id: string
          protocol: string
        }[]
      }
      expect(listed.data.map((model) => model.id)).toEqual([
        'm1',
        'Second/m1',
        'shared',
        'Second/shared',
      ])
      fetchMock.mockImplementation(async () => Response.json({ ok: true }))
      await (
        await relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'Second/m1' },
          auth,
        )
      ).text()
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://first.example.com/v1/chat/completions',
      )
      expect(
        await new Response(fetchMock.mock.calls[0]![1]!.body).json(),
      ).toMatchObject({ model: 'Second/m1' })
      await (
        await relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'Second/shared' },
          auth,
        )
      ).text()
      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
        'https://second.example.com/v1/chat/completions',
      )
      expect(
        await new Response(fetchMock.mock.calls.at(-1)![1]!.body).json(),
      ).toMatchObject({ model: 'shared' })
      await h.env.DB.prepare(
        "DELETE FROM ai_models WHERE model_id = 'Second/m" + "1'",
      ).run()
      await h.env.DB.prepare(
        "UPDATE ai_providers SET name = 'First' WHERE id " +
          '= (SELECT provider_id FROM ai_endpoints WHERE id' +
          ' = ?1)',
      )
        .bind(second)
        .run()
      await h.env.DB.prepare(
        'INSERT INTO ai_models (user_id, endpoint_id, mod' +
          'el_id, model_type, type_source, position) VALUES' +
          " ('user-a', ?1, 'second-only', 'chat', 'user', 1" +
          ')',
      )
        .bind(second)
        .run()
      expect(
        (
          await relay.request(
            'POST',
            '/relay/v1/chat/completions',
            { model: 'First/second-only' },
            auth,
          )
        ).status,
      ).toBe(404)
      await (
        await relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'First/m1' },
          auth,
        )
      ).text()
      expect(String(fetchMock.mock.calls.at(-1)![0])).toBe(
        'https://first.example.com/v1/chat/completions',
      )
      const settings = await relay.json<{
        protocols: string[]
      }>('GET', '/api/relay')
      expect(settings.protocols).toEqual(['openai-chat'])
    },
  )

  it(
    'routes discovered models when both provider and ' +
      'model names contain slashes',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      await provider(
        h,
        'Team',
        'https://team.example.com',
        'sk-team-0123456789',
        ['other'],
      )
      await provider(
        h,
        'First',
        'https://first.example.com',
        'sk-first-0123456789',
        ['vendor/m1'],
      )
      await provider(
        h,
        'Team/Acme',
        'https://acme.example.com',
        'sk-acme-0123456789',
        ['vendor/m1'],
      )
      const listing = (await (
        await relay.request('GET', '/relay/v1/models', undefined, auth)
      ).json()) as {
        data: {
          id: string
        }[]
      }
      expect(listing.data.map((entry) => entry.id)).toContain(
        'Team/Acme/vendor/m1',
      )
      fetchMock.mockResolvedValue(Response.json({ ok: true }))
      const result = await relay.request(
        'POST',
        '/relay/v1/chat/completions',
        { model: 'Team/Acme/vendor/m1' },
        auth,
      )
      expect(result.status).toBe(200)
      await result.text()
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://acme.example.com/v1/chat/completions',
      )
      expect(
        await new Response(fetchMock.mock.calls[0]![1]!.body).json(),
      ).toMatchObject({ model: 'vendor/m1' })
    },
  )

  it(
    'reports mixed configuration failures instead of ' +
      'claiming every line is paused',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      const paused = await provider(
        h,
        'Paused',
        'https://paused.example.com',
        'sk-paused-0123456789',
      )
      const missing = await provider(
        h,
        'Missing',
        'https://missing.example.com',
        'sk-missing-0123456789',
      )
      await h.env.DB.prepare(
        "UPDATE ai_endpoints SET key_strategy = 'fill_fir" + "st'",
      ).run()
      await h.env.DB.prepare(
        'UPDATE ai_endpoint_keys SET exhausted_until = ?1' +
          ' WHERE endpoint_id = ?2',
      )
        .bind(Date.now() + 120000, paused)
        .run()
      await h.env.DB.prepare(
        'DELETE FROM ai_endpoint_keys WHERE endpoint_id =' + ' ?1',
      )
        .bind(missing)
        .run()
      const send = () =>
        relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'm1' },
          auth,
        )
      for (const position of [-1, 99]) {
        await h.env.DB.prepare(
          'UPDATE ai_providers SET position = ?1 WHERE id =' +
            ' (SELECT provider_id FROM ai_endpoints WHERE id ' +
            '= ?2)',
        )
          .bind(position, missing)
          .run()
        const result = await send()
        expect(result.status).toBe(502)
        expect(await result.json()).toMatchObject({
          error: { type: 'api_error', message: 'missing key' },
        })
      }
      await h.env.DB.prepare(
        'UPDATE ai_endpoints SET base_url = ?1 WHERE id =' + ' ?2',
      )
        .bind('http://127.0.0.1', missing)
        .run()
      expect((await send()).status).toBe(502)
      expect(fetchMock).not.toHaveBeenCalled()
      await addKey(h, 'user-a', missing, 'sk-missing-0123456789')
      const recovery = Date.now() + 60000
      await h.env.DB.prepare(
        'UPDATE ai_endpoints SET base_url = ?1 WHERE id =' + ' ?2',
      )
        .bind('https://missing.example.com', missing)
        .run()
      await h.env.DB.prepare(
        'UPDATE ai_endpoint_keys SET exhausted_until = ?1' +
          ' WHERE endpoint_id = ?2',
      )
        .bind(recovery, missing)
        .run()
      const exhausted = await send()
      expect(exhausted.status).toBe(429)
      expect(JSON.stringify(await exhausted.json())).toContain(
        new Date(recovery).toISOString(),
      )
    },
  )

  it(
    'keeps the client Anthropic version over endpoint' + ' and default headers',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      const endpointId = await provider(
        h,
        'Claude',
        'https://claude.example.com',
        'sk-claude-0123456789',
        ['m1'],
        'anthropic-messages',
      )
      await h.env.DB.prepare(
        'UPDATE ai_endpoints SET headers = ?1 WHERE id = ' + '?2',
      )
        .bind(
          JSON.stringify({ 'Anthropic-Version': 'endpoint-version' }),
          endpointId,
        )
        .run()
      fetchMock.mockImplementation(async () => Response.json({ ok: true }))
      await (
        await relay.request(
          'POST',
          '/relay/v1/messages',
          { model: 'm1' },
          { ...auth, 'anthropic-version': 'client-version' },
        )
      ).text()
      expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
        'anthropic-version': 'client-version',
      })
    },
  )

  it(
    'masks keys already removed from a fill-first poo' +
      'l in passthrough errors',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      const first = 'sk-first-0123456789'
      const second = 'sk-second-0123456789'
      const endpointId = await provider(
        h,
        'Acme',
        'https://acme.example.com',
        first,
      )
      await addKey(h, 'user-a', endpointId, second)
      await h.env.DB.prepare(
        "UPDATE ai_endpoints SET key_strategy = 'fill_fir" +
          "st' WHERE id = ?1",
      )
        .bind(endpointId)
        .run()
      fetchMock
        .mockResolvedValueOnce(
          new Response('insufficient balance', { status: 402 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: `${first} ${second}` }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          }),
        )
      const response = await relay.request(
        'POST',
        '/relay/v1/chat/completions',
        { model: 'm1' },
        auth,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: '*** ***' })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )
})
