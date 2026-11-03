import { describe, expect, it } from 'vitest'

import {
  chatModel,
  createHarness,
  type Harness,
} from './support/ai-kit-harness'
import {
  KEY,
  fetchMock,
  saveProvider,
  run,
  textStream,
} from './support/ai-kit-test-setup'

describe('request configuration (docs/36)', () => {
  type Saved = {
    id: string
    endpoints: {
      id: string
      imageBaseUrl: string | null
      imageEditBaseUrl: string | null
      headers: Record<string, string>
    }[]
  }[]

  const put = (
    h: Harness,
    providerId: string,
    endpointId: string,
    extra: Record<string, unknown>,
  ) =>
    h.json<Saved>('user-a', 'PUT', '/providers', {
      id: providerId,
      name: 'Acme',
      endpoints: [
        {
          id: endpointId,
          slug: 'main',
          baseUrl: 'https://api.example.com',
          protocol: 'openai-chat',
          models: [chatModel('m1')],
          ...extra,
        },
      ],
    })

  it(
    'saves, lists and keeps image base URL and header' + 's when omitted',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      expect(
        (await h.json<Saved>('user-a', 'GET', '/providers')).body[0]!
          .endpoints[0],
      ).toMatchObject({
        imageBaseUrl: null,
        imageEditBaseUrl: null,
        headers: {},
      })
      const saved = await put(h, providerId, endpointId, {
        imageBaseUrl: ' https://img.example.com ',
        imageEditBaseUrl: ' https://edit.example.com ',
        headers: { ' X-Team ': 'blue', 'x-trace': '' },
      })
      expect(saved).toMatchObject({
        status: 200,
        body: [
          {
            endpoints: [
              {
                imageBaseUrl: 'https://img.example.com',
                imageEditBaseUrl: 'https://edit.example.com',
                headers: { 'X-Team': 'blue', 'x-trace': '' },
              },
            ],
          },
        ],
      })
      await put(h, providerId, endpointId, {})
      expect(
        (await h.json<Saved>('user-a', 'GET', '/providers')).body[0]!
          .endpoints[0],
      ).toMatchObject({
        imageBaseUrl: 'https://img.example.com',
        imageEditBaseUrl: 'https://edit.example.com',
        headers: { 'X-Team': 'blue', 'x-trace': '' },
      })
      const cleared = await put(h, providerId, endpointId, {
        imageBaseUrl: '  ',
        imageEditBaseUrl: null,
        headers: {},
      })
      expect(cleared.body[0]!.endpoints[0]).toMatchObject({
        imageBaseUrl: null,
        imageEditBaseUrl: null,
        headers: {},
      })
    },
  )

  it(
    'rejects invalid image base URLs and headers with' + ' Aether reasons',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      const reason = async (extra: Record<string, unknown>) =>
        (await put(h, providerId, endpointId, extra)) as unknown as {
          status: number
          body: {
            error: {
              details: unknown
            }
          }
        }
      const bad = (field: string, why: string) => ({
        status: 400,
        body: { error: { details: { field, reason: why } } },
      })
      expect(await reason({ imageBaseUrl: 'ftp://img' })).toMatchObject(
        bad('imageBaseUrl', 'invalid_url'),
      )
      expect(
        await reason({ imageBaseUrl: `https://${'a'.repeat(2048)}` }),
      ).toMatchObject(bad('imageBaseUrl', 'invalid_url'))
      expect(await reason({ imageEditBaseUrl: 'ftp://img' })).toMatchObject(
        bad('imageEditBaseUrl', 'invalid_url'),
      )
      expect(
        await reason({ imageEditBaseUrl: `https://${'a'.repeat(2048)}` }),
      ).toMatchObject(bad('imageEditBaseUrl', 'invalid_url'))
      const many = Object.fromEntries(
        Array.from({ length: 21 }, (_, i) => [`x-h${i}`, 'v']),
      )
      expect(await reason({ headers: many })).toMatchObject(
        bad('headers', 'too_many'),
      )
      for (const headers of [
        { 'bad name': 'v' },
        { '': 'v' },
        { 'x-a': 'v', 'X-A': 'w' },
        { 'x-a': 'a\nb' },
        { 'x-a': 'v'.repeat(2049) },
      ])
        expect(
          await reason({ headers }),
          JSON.stringify(headers).slice(0, 40),
        ).toMatchObject(bad('headers', 'invalid'))
      for (const name of [
        'Authorization',
        'x-api-key',
        'Anthropic-Version',
        'host',
        'Content-Type',
        'content-length',
        'accept',
        'connection',
        'transfer-encoding',
        'Cookie',
      ])
        expect(await reason({ headers: { [name]: 'v' } }), name).toMatchObject(
          bad('headers', 'reserved'),
        )
      expect(
        (await h.json<Saved>('user-a', 'GET', '/providers')).body[0]!
          .endpoints[0],
      ).toMatchObject({
        imageBaseUrl: null,
        imageEditBaseUrl: null,
        headers: {},
      })
    },
  )

  it(
    'sends custom headers on chat rounds and probes w' +
      'ithout overriding system headers',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      await put(h, providerId, endpointId, { headers: { 'X-Team': 'blue' } })
      fetchMock.mockImplementation(async () => textStream('Hi'))
      const { events } = await run(h, { model: { endpointId, modelId: 'm1' } })
      expect(events.at(-1)).toEqual({ kind: 'end', status: 'completed' })
      const chat = new Headers(fetchMock.mock.calls[0]![1]?.headers)
      expect([
        chat.get('x-team'),
        chat.get('authorization'),
        chat.get('content-type'),
      ]).toEqual(['blue', `Bearer ${KEY}`, 'application/json'])
      fetchMock.mockReset()
      fetchMock.mockImplementation(async () =>
        Response.json({ data: [{ id: 'gpt-4o' }] }),
      )
      await h.json('user-a', 'POST', '/probe', { kind: 'saved', endpointId })
      await h.json('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
        endpointId,
      })
      await h.json('user-a', 'POST', '/probe', {
        kind: 'draft',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
      for (const [, init] of fetchMock.mock.calls) {
        const headers = new Headers(init?.headers)
        expect(headers.get('x-team')).toBe('blue')
        expect(headers.get('authorization')).toBe(`Bearer ${KEY}`)
      }
    },
  )
})
