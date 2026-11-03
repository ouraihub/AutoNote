import { describe, expect, it, vi } from 'vitest'

import { fetchMock, provider, setup } from './support/relay-test-setup'

describe('relay forwarding', () => {
  it(
    'bounds chunked bodies at 10 MB without trusting ' + 'content-length',
    async () => {
      const { relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      let pulls = 0
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++
          controller.enqueue(new Uint8Array(1024 * 1024))
        },
        cancel,
      })
      const oversized = await relay.raw('/relay/v1/chat/completions', {
        method: 'POST',
        headers: auth,
        body,
        duplex: 'half',
      } as RequestInit)
      expect(oversized.status).toBe(413)
      expect(await oversized.json()).toMatchObject({
        type: 'error',
        error: { type: 'invalid_request_error' },
      })
      expect(pulls).toBeLessThanOrEqual(12)
      expect(cancel).toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
      const declared = await relay.request(
        'POST',
        '/relay/v1/chat/completions',
        {},
        { ...auth, 'content-length': String(10 * 1024 * 1024 + 1) },
      )
      expect(declared.status).toBe(413)
    },
  )

  it(
    'uses relay envelopes for malformed JSON, oversiz' +
      'ed exchange bodies and unknown paths',
    async () => {
      const { relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      for (const response of [
        await relay.raw('/relay/github/token', { method: 'POST', body: '{' }),
        await relay.request('POST', '/relay/github/token', {
          token: 'x'.repeat(9000),
        }),
        await relay.request(
          'POST',
          '/relay/v1/chat/completions',
          ['not an object'],
          auth,
        ),
        await relay.request('GET', '/relay/unknown'),
        await relay.request('GET', '/relay/v1/unknown', undefined, auth),
      ]) {
        expect([400, 413, 404]).toContain(response.status)
        expect(await response.json()).toMatchObject({
          type: 'error',
          error: {
            type: expect.stringMatching(
              /invalid_request_error|not_found_error/,
            ),
          },
        })
      }
    },
  )

  it(
    'releases slots for null bodies, cancellation and' +
      ' propagated stream errors',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      await provider(
        h,
        'Acme',
        'https://acme.example.com',
        'sk-acme-0123456789',
      )
      const chat = () =>
        relay.request(
          'POST',
          '/relay/v1/chat/completions',
          { model: 'm1' },
          auth,
        )
      fetchMock.mockImplementation(
        async () => new Response(null, { status: 204 }),
      )
      for (let i = 0; i < 10; i++) expect((await chat()).status).toBe(204)
      const cancelled = vi.fn()
      fetchMock.mockImplementation(
        async () => new Response(new ReadableStream({ cancel: cancelled })),
      )
      const held = await Promise.all(Array.from({ length: 8 }, chat))
      expect((await chat()).status).toBe(429)
      await held[0]!.body!.cancel('client stopped')
      const replacement = await chat()
      expect(replacement.status).toBe(200)
      await Promise.all(
        [...held.slice(1), replacement].map((response) =>
          response.body!.cancel(),
        ),
      )
      expect(cancelled).toHaveBeenCalledTimes(9)
      fetchMock.mockImplementation(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error('broken upstream'))
              },
            }),
          ),
      )
      for (let i = 0; i < 10; i++) {
        const response = await chat()
        expect(response.status).toBe(200)
        await expect(response.text()).rejects.toThrow('broken upstream')
      }
      fetchMock.mockImplementation(async () => Response.json({ ok: true }))
      expect(await (await chat()).json()).toEqual({ ok: true })
    },
  )
})
