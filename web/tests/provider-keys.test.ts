import { describe, expect, it, vi } from 'vitest'

import { hashPassword } from '../src/worker/lib/password'

import { addKey, chatModel, createHarness } from './support/ai-kit-harness'
import {
  KEY,
  fetchMock,
  testClock,
  saveProvider,
  run,
  ProviderDto,
} from './support/ai-kit-test-setup'

describe('provider routes', () => {
  it(
    'adds, edits, toggles and removes endpoint keys w' + 'ith masked output',
    async () => {
      const h = await createHarness()
      const { providerId, endpointId } = await saveProvider(h)
      let { body } = await h.json<ProviderDto[]>('user-a', 'GET', '/providers')
      expect(body).toMatchObject([
        {
          id: providerId,
          name: 'Acme',
          endpoints: [
            {
              id: endpointId,
              slug: 'main',
              baseUrl: 'https://api.example.com',
              protocol: 'openai-chat',
              keys: [
                {
                  label: '',
                  enabled: true,
                  masked: 'sk-t****************mnop',
                  readable: true,
                },
              ],
              models: [chatModel('m1')],
            },
          ],
        },
      ])
      expect(JSON.stringify(body)).not.toContain(KEY)
      const firstId = body[0]!.endpoints[0]!.keys[0]!.id
      // Provider saves never touch keys.
      const endpoint = {
        id: endpointId,
        slug: 'main',
        baseUrl: 'https://api.example.com',
        protocol: 'openai-chat',
        models: [chatModel('m1')],
      }
      ;({ body } = await h.json<ProviderDto[]>('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'Acme',
        endpoints: [endpoint],
      }))
      expect(body[0]!.endpoints[0]!.keys).toHaveLength(1)
      expect(
        (
          await h.json('user-a', 'PUT', '/providers', {
            id: providerId,
            name: 'Acme',
            endpoints: [{ ...endpoint, apiKey: 'x' }],
          })
        ).status,
      ).toBe(400)
      ;({ body } = await h.json<ProviderDto[]>(
        'user-a',
        'PUT',
        '/endpoint-keys',
        {
          endpointId,
          key: '  sk-other-0123456789 ',
          label: ' backup ',
        },
      ))
      expect(body[0]!.endpoints[0]!.keys).toMatchObject([
        { id: firstId },
        { label: 'backup', enabled: true, masked: 'sk-o***********6789' },
      ])
      const secondId = body[0]!.endpoints[0]!.keys[1]!.id
      ;({ body } = await h.json<ProviderDto[]>(
        'user-a',
        'PUT',
        '/endpoint-keys',
        {
          endpointId,
          id: secondId,
          label: 'spare',
        },
      ))
      expect(body[0]!.endpoints[0]!.keys[1]).toMatchObject({
        label: 'spare',
        masked: 'sk-o***********6789',
      })
      ;({ body } = await h.json<ProviderDto[]>(
        'user-a',
        'PUT',
        '/endpoint-keys',
        {
          endpointId,
          id: firstId,
          enabled: false,
        },
      ))
      expect(body[0]!.endpoints[0]!.keys[0]).toMatchObject({
        enabled: false,
        masked: 'sk-t****************mnop',
      })
      const error = async (input: unknown) =>
        (
          await h.json<{
            error: {
              code: string
              details: unknown
            }
          }>('user-a', 'PUT', '/endpoint-keys', input)
        ).body.error
      expect(await error({ endpointId, key: KEY })).toMatchObject({
        code: 'bad_request',
        details: { field: 'apiKey', reason: 'duplicate' },
      })
      expect(
        await error({ endpointId, id: secondId, key: ` ${KEY}` }),
      ).toMatchObject({
        details: { field: 'apiKey', reason: 'duplicate' },
      })
      expect(await error({ endpointId, key: '   ' })).toMatchObject({
        details: { field: 'apiKey', reason: 'empty' },
      })
      expect(await error({ endpointId })).toMatchObject({
        details: { field: 'apiKey', reason: 'empty' },
      })
      expect(await error({ endpointId, key: 'x'.repeat(4097) })).toMatchObject({
        details: { field: 'apiKey', reason: 'too_long' },
      })
      expect(
        await error({ endpointId, key: 'sk-label', label: 'x'.repeat(41) }),
      ).toMatchObject({
        details: { field: 'label', reason: 'too_long' },
      })
      expect(
        await error({ endpointId, id: 'missing', label: 'a' }),
      ).toMatchObject({
        code: 'not_found',
        details: { entity: 'key' },
      })
      expect(await error({ endpointId: 'missing', key: 'sk-x' })).toMatchObject(
        {
          code: 'not_found',
          details: { entity: 'endpoint' },
        },
      )
      // Each key route takes a slot (20 per minute); move the faked
      // clock past the window.
      vi.setSystemTime((testClock.now += 60000))
      for (let index = 2; index < 16; index++)
        await addKey(h, 'user-a', endpointId, `sk-many-${index}`)
      vi.setSystemTime((testClock.now += 60000))
      expect(await error({ endpointId, key: 'sk-many-16' })).toMatchObject({
        details: { field: 'keys', reason: 'too_many' },
      })
      expect(
        (
          await h.json('user-b', 'PUT', '/endpoint-keys', {
            endpointId,
            key: 'sk-b',
          })
        ).status,
      ).toBe(404)
      expect(
        (
          await h.json('user-b', 'DELETE', `/endpoint-keys/${firstId}`, {
            endpointId,
          })
        ).status,
      ).toBe(404)
      ;({ body } = await h.json<ProviderDto[]>(
        'user-a',
        'DELETE',
        `/endpoint-keys/${firstId}`,
        { endpointId },
      ))
      expect(body[0]!.endpoints[0]!.keys.map((key) => key.id)).not.toContain(
        firstId,
      )
      expect(
        (
          await h.json('user-a', 'DELETE', `/endpoint-keys/${firstId}`, {
            endpointId,
          })
        ).status,
      ).toBe(404)
    },
  )

  it('reveals a key only with the current password', async () => {
    const h = await createHarness()
    await h.env.DB.prepare(
      'INSERT INTO users (id, username, password_hash, ' +
        "login, created_at, last_seen_at) VALUES ('user-a" +
        "', 'user-a', ?1, 'user-a', 0, 0)",
    )
      .bind(await hashPassword('correct-password'))
      .run()
    await saveProvider(h)
    const { body } = await h.json<ProviderDto[]>('user-a', 'GET', '/providers')
    const keyId = body[0]!.endpoints[0]!.keys[0]!.id
    expect(
      (
        await h.json('user-a', 'POST', `/endpoint-keys/${keyId}/reveal`, {
          currentPassword: 'wrong',
        })
      ).status,
    ).toBe(401)
    expect(
      (await h.json('user-a', 'POST', `/endpoint-keys/${keyId}/reveal`, {}))
        .status,
    ).toBe(401)
    expect(
      (
        await h.json('user-b', 'POST', `/endpoint-keys/${keyId}/reveal`, {
          currentPassword: 'correct-password',
        })
      ).status,
    ).toBe(404)
    expect(
      await h.json('user-a', 'POST', `/endpoint-keys/${keyId}/reveal`, {
        currentPassword: 'correct-password',
      }),
    ).toEqual({ status: 200, body: { key: KEY } })
  })

  it(
    'deletes keys with their provider and with droppe' + 'd endpoints',
    async () => {
      const h = await createHarness()
      const { providerId } = await saveProvider(h)
      const count = async () =>
        (await h.env.DB.prepare(
          'SELECT COUNT(*) AS n FROM ai_endpoint_keys',
        ).first<{
          n: number
        }>())!.n
      expect(await count()).toBe(1)
      await h.json('user-a', 'PUT', '/providers', {
        id: providerId,
        name: 'Acme',
        endpoints: [],
      })
      expect(await count()).toBe(0)
      const other = await saveProvider(h)
      expect(await count()).toBe(1)
      expect(
        (await h.json('user-a', 'DELETE', `/providers/${other.providerId}`))
          .status,
      ).toBe(200)
      expect(await count()).toBe(0)
    },
  )

  it(
    'saves an endpoint with an empty address and repo' +
      'rts missing_url on use',
    async () => {
      const h = await createHarness()
      const { body } = await h.json<ProviderDto[]>(
        'user-a',
        'PUT',
        '/providers',
        {
          name: 'Blank',
          endpoints: [
            {
              slug: 'main',
              baseUrl: '',
              protocol: 'openai-chat',
              models: [chatModel('m1')],
            },
          ],
        },
      )
      const endpointId = body[0]!.endpoints[0]!.id
      await addKey(h, 'user-a', endpointId, KEY)
      const { text } = await run(h, { model: { endpointId, modelId: 'm1' } })
      expect(text).toContain('missing_url')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('toggles enabled without replacing the provider d' + 'raft', async () => {
    const h = await createHarness()
    const { providerId, endpointId } = await saveProvider(h)
    const response = await h.json<ProviderDto[]>(
      'user-a',
      'PATCH',
      `/providers/${providerId}/enabled`,
      {
        enabled: false,
      },
    )
    expect(response.body[0]).toMatchObject({
      id: providerId,
      enabled: false,
      name: 'Acme',
    })
    expect(response.body[0]!.endpoints[0]).toMatchObject({
      id: endpointId,
      slug: 'main',
      models: [chatModel('m1')],
    })
    expect(
      (await h.json<ProviderDto[]>('user-a', 'GET', '/providers')).body[0]!
        .enabled,
    ).toBe(false)
    const invalid = await h.json(
      'user-a',
      'PATCH',
      `/providers/${providerId}/enabled`,
      { enabled: 'false' },
    )
    expect(invalid).toMatchObject({
      status: 400,
      body: { error: { code: 'bad_request' } },
    })
  })

  it('validates with Aether reasons', async () => {
    const h = await createHarness()
    const bad = (endpoints: unknown[], name = 'Acme') =>
      h.json('user-a', 'PUT', '/providers', { name, endpoints })
    const ep = {
      slug: 'main',
      baseUrl: 'https://a.example.com',
      protocol: 'openai-chat',
      models: [],
    }
    expect(await bad([], ' ')).toMatchObject({
      status: 400,
      body: {
        error: {
          code: 'bad_request',
          details: { field: 'name', reason: 'out_of_range', limit: 80 },
        },
      },
    })
    expect(await bad([{ ...ep, slug: 'Main' }])).toMatchObject({
      body: { error: { details: { field: 'slug', reason: 'invalid_slug' } } },
    })
    expect(await bad([ep, ep])).toMatchObject({
      body: { error: { details: { field: 'slug', reason: 'duplicate' } } },
    })
    expect(await bad([{ ...ep, baseUrl: 'ftp://x' }])).toMatchObject({
      body: { error: { details: { field: 'baseUrl', reason: 'invalid_url' } } },
    })
    expect(
      await bad([{ ...ep, models: [chatModel('a'), chatModel('a')] }]),
    ).toMatchObject({
      body: { error: { details: { field: 'models', reason: 'duplicate' } } },
    })
    expect(await bad([{ ...ep, id: 'unknown' }])).toMatchObject({
      status: 404,
      body: { error: { code: 'not_found', details: { entity: 'endpoint' } } },
    })
  })

  it(
    'deletes providers, returns remaining and clears ' + 'role bindings',
    async () => {
      const h = await createHarness()
      const first = await saveProvider(h)
      const second = await saveProvider(h)
      await h.env.DB.prepare(
        'INSERT INTO ai_roles (user_id, role, endpoint_id' +
          ", model_id) VALUES ('user-a', 'chat', ?1, 'm1')",
      )
        .bind(first.endpointId)
        .run()
      const { body } = await h.json<ProviderDto[]>(
        'user-a',
        'DELETE',
        `/providers/${first.providerId}`,
      )
      expect(body.map((provider) => provider.id)).toEqual([second.providerId])
      expect(
        await h.env.DB.prepare('SELECT COUNT(*) AS n FROM ai_roles').first('n'),
      ).toBe(0)
      expect(
        await h.json('user-a', 'DELETE', `/providers/${first.providerId}`),
      ).toMatchObject({
        status: 404,
        body: { error: { details: { entity: 'provider' } } },
      })
    },
  )

  it('filters model options and labels them', async () => {
    const h = await createHarness()
    await h.json('user-a', 'PUT', '/providers', {
      name: 'Acme',
      endpoints: [
        {
          slug: 'main',
          baseUrl: 'https://a.example.com',
          protocol: 'openai-chat',
          models: [
            { ...chatModel('m1'), supportsTools: true },
            { ...chatModel('e1'), modelType: 'embedding' },
            chatModel('m2'),
          ],
        },
      ],
    })
    const all = await h.json<
      {
        modelId: string
        label: string
      }[]
    >('user-a', 'GET', '/model-options')
    expect(all.body.map((option) => option.label)).toEqual([
      'Acme · main · m1',
      'Acme · main · e1',
      'Acme · main · m2',
    ])
    const chat = await h.json<
      {
        modelId: string
      }[]
    >('user-a', 'GET', '/model-options?modelType=chat&supportsTools=true')
    expect(chat.body.map((option) => option.modelId)).toEqual(['m1'])
    const untooled = await h.json<
      {
        modelId: string
      }[]
    >('user-a', 'GET', '/model-options?supportsTools=false')
    expect(untooled.body).toEqual([])
  })
})
