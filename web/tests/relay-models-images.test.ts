import { describe, expect, it } from 'vitest'

import { chatModel } from './support/ai-kit-harness'
import { fetchMock, provider, setup } from './support/relay-test-setup'

describe('relay forwarding', () => {
  it(
    'lists models with protocols, finds lines by mode' +
      'l or provider/model, and 404s with the available' +
      ' list',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      await provider(
        h,
        'Acme',
        'https://acme.example.com',
        'sk-acme-0123456789',
        ['m1', 'shared'],
      )
      await provider(
        h,
        'Beta',
        'https://beta.example.com',
        'sk-beta-0123456789',
        ['shared', 'claude-x'],
        'anthropic-messages',
      )
      const models = await (
        await relay.request('GET', '/relay/v1/models', undefined, auth)
      ).json()
      expect(models).toEqual({
        object: 'list',
        data: [
          {
            id: 'm1',
            object: 'model',
            owned_by: 'Acme',
            protocol: 'openai-chat',
            model_type: 'chat',
          },
          {
            id: 'shared',
            object: 'model',
            owned_by: 'Acme',
            protocol: 'openai-chat',
            model_type: 'chat',
          },
          {
            id: 'shared',
            object: 'model',
            owned_by: 'Beta',
            protocol: 'anthropic-messages',
            model_type: 'chat',
          },
          {
            id: 'claude-x',
            object: 'model',
            owned_by: 'Beta',
            protocol: 'anthropic-messages',
            model_type: 'chat',
          },
        ],
      })
      expect(
        (
          await relay.json<{
            protocols: string[]
          }>('GET', '/api/relay')
        ).protocols,
      ).toEqual(['openai-chat', 'anthropic-messages'])
      const missing = await relay.request(
        'POST',
        '/relay/v1/chat/completions',
        { model: 'claude-x' },
        auth,
      )
      expect(missing.status).toBe(404)
      expect(JSON.stringify(await missing.json())).toContain(
        'available: m1, shared',
      )
      fetchMock.mockResolvedValue(Response.json({ ok: true }))
      const inbound = {
        ...auth,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-1',
        cookie: 'secret=1',
        'x-forwarded-for': '1.2.3.4',
      }
      const response = await relay.request(
        'POST',
        '/relay/v1/messages',
        { model: 'Beta/shared', max_tokens: 1 },
        inbound,
      )
      expect(response.status).toBe(200)
      const [url, init] = fetchMock.mock.calls[0]!
      expect(String(url)).toBe('https://beta.example.com/v1/messages')
      expect(JSON.parse(String(init!.body))).toEqual({
        model: 'shared',
        max_tokens: 1,
      })
      expect(init!.headers).toEqual({
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-1',
        'content-type': 'application/json',
        authorization: 'Bearer sk-beta-0123456789',
        'x-api-key': 'sk-beta-0123456789',
      })
    },
  )

  it(
    'advertises and forwards Responses only when a Re' +
      'sponses chat model is configured',
    async () => {
      const { h, relay, auth } = await setup()
      expect(
        (
          await relay.json<{
            protocols: string[]
          }>('GET', '/api/relay')
        ).protocols,
      ).toEqual([])
      await provider(
        h,
        'Responses',
        'https://responses.example.com/v1',
        'sk-responses-0123456789',
        ['gpt-x'],
        'openai-responses',
      )
      expect(
        (
          await relay.json<{
            protocols: string[]
          }>('GET', '/api/relay')
        ).protocols,
      ).toEqual(['openai-responses'])
      await relay.request('PUT', '/api/relay', { enabled: true })
      fetchMock.mockResolvedValue(Response.json({ output: [] }))
      const response = await relay.request(
        'POST',
        '/relay/v1/responses',
        { model: 'gpt-x', input: 'hello' },
        auth,
      )
      expect(await response.json()).toEqual({ output: [] })
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://responses.example.com/v1/responses',
      )
      expect(
        await new Response(fetchMock.mock.calls[0]![1]!.body).json(),
      ).toEqual({ model: 'gpt-x', input: 'hello' })
    },
  )

  it(
    'lists image models and forwards generation and m' +
      'ultipart edit requests',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      const endpoint = await provider(
        h,
        'Fenno',
        'https://api.fenno.ai/v1',
        'sk-fenno-0123456789',
        ['gpt-img'],
        'openai-chat',
        true,
      )
      const fenno = (
        await h.json<
          {
            id: string
            name: string
          }[]
        >('user-a', 'GET', '/providers')
      ).body.find((item) => item.name === 'Fenno')!
      await h.json('user-a', 'PUT', '/providers', {
        id: fenno.id,
        name: 'Fenno',
        endpoints: [
          {
            id: endpoint,
            slug: 'main',
            baseUrl: 'https://api.fenno.ai/v1',
            protocol: 'openai-chat',
            models: [{ ...chatModel('gpt-img'), modelType: 'image' }],
          },
        ],
      })
      const listing = (await (
        await relay.request('GET', '/relay/v1/models', undefined, auth)
      ).json()) as {
        data: {
          id: string
          model_type: string
        }[]
      }
      expect(listing.data).toContainEqual({
        id: 'gpt-img',
        object: 'model',
        owned_by: 'Fenno',
        protocol: 'openai-chat',
        model_type: 'image',
      })
      fetchMock.mockResolvedValue(
        Response.json({ data: [{ b64_json: 'aW1hZ2U=' }] }),
      )
      const generated = await relay.request(
        'POST',
        '/relay/v1/images/generations',
        { model: 'gpt-img', prompt: 'a cat' },
        auth,
      )
      expect(generated.status).toBe(200)
      expect(await generated.json()).toEqual({
        data: [{ b64_json: 'aW1hZ2U=' }],
      })
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://api.fenno.ai/v1/images/generations',
      )
      fetchMock.mockReset()
      fetchMock.mockResolvedValue(
        Response.json({ data: [{ b64_json: 'ZWRpdA==' }] }),
      )
      const form = new FormData()
      form.set('model', 'gpt-img')
      form.set('prompt', 'make it blue')
      form.set(
        'image',
        new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        'input.png',
      )
      const edited = await relay.raw('/relay/v1/images/edits', {
        method: 'POST',
        headers: auth,
        body: form,
      })
      expect(edited.status).toBe(200)
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://api.fenno.ai/v1/images/edits',
      )
      expect(fetchMock.mock.calls[0]![1]!.body).toBeInstanceOf(Uint8Array)
    },
  )

  it(
    'rewrites qualified image models without losing J' +
      'SON fields or multipart files',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      await provider(
        h,
        'First',
        'https://first.example.com',
        'sk-first-0123456789',
        ['vendor/image'],
        'openai-chat',
        true,
      )
      await provider(
        h,
        'Team/Second',
        'https://second.example.com',
        'sk-second-0123456789',
        ['vendor/image'],
        'openai-chat',
        true,
      )
      const listing = (await (
        await relay.request('GET', '/relay/v1/models', undefined, auth)
      ).json()) as {
        data: {
          id: string
        }[]
      }
      expect(listing.data.map((entry) => entry.id)).toContain(
        'Team/Second/vendor/image',
      )
      fetchMock.mockImplementation(async () => Response.json({ data: [] }))
      expect(
        (
          await relay.request(
            'POST',
            '/relay/v1/images/generations',
            { model: 'Team/Second/vendor/image', prompt: 'a cat', n: 2 },
            auth,
          )
        ).status,
      ).toBe(200)
      expect(String(fetchMock.mock.calls[0]![0])).toBe(
        'https://second.example.com/v1/images/generations',
      )
      expect(
        await new Response(fetchMock.mock.calls[0]![1]!.body).json(),
      ).toEqual({ model: 'vendor/image', prompt: 'a cat', n: 2 })
      const form = new FormData()
      form.set('model', 'Team/Second/vendor/image')
      form.set('prompt', 'make it blue')
      form.append(
        'image',
        new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
        'input.png',
      )
      form.append(
        'image',
        new Blob([new Uint8Array([4])], { type: 'image/png' }),
        'second.png',
      )
      expect(
        (
          await relay.raw('/relay/v1/images/edits', {
            method: 'POST',
            headers: auth,
            body: form,
          })
        ).status,
      ).toBe(200)
      const [url, init] = fetchMock.mock.calls[1]!
      expect(String(url)).toBe('https://second.example.com/v1/images/edits')
      const sent = await new Request(String(url), init).formData()
      expect(sent.get('model')).toBe('vendor/image')
      expect(sent.get('prompt')).toBe('make it blue')
      const images = sent.getAll('image') as File[]
      expect(images.map((file) => [file.name, file.type])).toEqual([
        ['input.png', 'image/png'],
        ['second.png', 'image/png'],
      ])
      expect(
        await Promise.all(
          images.map(async (file) => [
            ...new Uint8Array(await file.arrayBuffer()),
          ]),
        ),
      ).toEqual([[1, 2, 3], [4]])
    },
  )

  it(
    'bounds image requests and responses, rejects mal' +
      'formed input, and masks upstream errors',
    async () => {
      const { h, relay, auth } = await setup()
      await relay.request('PUT', '/api/relay', { enabled: true })
      await provider(
        h,
        'Image',
        'https://image.example.com',
        'sk-image-0123456789',
        ['image'],
        'openai-chat',
        true,
      )
      for (const path of [
        '/relay/v1/images/generations',
        '/relay/v1/images/edits',
      ]) {
        expect(
          (await relay.raw(path, { method: 'POST', headers: auth, body: '{' }))
            .status,
        ).toBe(400)
        expect(
          (
            await relay.request(
              'POST',
              path,
              {},
              { ...auth, 'content-length': String(10 * 1024 * 1024 + 1) },
            )
          ).status,
        ).toBe(413)
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
        })
        expect(
          (
            await relay.raw(path, {
              method: 'POST',
              headers: auth,
              body,
              duplex: 'half',
            } as RequestInit)
          ).status,
        ).toBe(413)
      }
      expect(
        (await relay.request('POST', '/relay/v1/images/generations', {}, auth))
          .status,
      ).toBe(400)
      expect(
        (
          await relay.request(
            'POST',
            '/relay/v1/images/generations',
            { model: 'missing' },
            auth,
          )
        ).status,
      ).toBe(404)
      expect(fetchMock).not.toHaveBeenCalled()
      fetchMock.mockResolvedValueOnce(
        new Response('bad sk-image-0123456789', {
          status: 400,
          headers: { 'content-type': 'text/plain' },
        }),
      )
      const rejected = await relay.request(
        'POST',
        '/relay/v1/images/generations',
        { model: 'image' },
        auth,
      )
      expect(rejected.status).toBe(400)
      expect(await rejected.text()).toBe('bad ***')
      fetchMock.mockResolvedValueOnce(
        new Response('x'.repeat(10 * 1024 * 1024 + 1)),
      )
      const oversized = await relay.request(
        'POST',
        '/relay/v1/images/generations',
        { model: 'image' },
        auth,
      )
      expect(oversized.status).toBe(502)
      expect(await oversized.json()).toMatchObject({
        error: { type: 'api_error', message: 'image response exceeds 10 MB' },
      })
      expect(fetchMock).toHaveBeenCalledTimes(2)
    },
  )
})
