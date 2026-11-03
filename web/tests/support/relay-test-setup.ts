import { Hono } from 'hono'

import { afterEach, beforeEach, vi } from 'vitest'

import type { AppBindings } from '../../src/worker/env'

import { relayRoutes, relaySettingsRoutes } from '../../src/worker/routes/relay'

import {
  addKey,
  chatModel,
  createHarness,
  type Harness,
} from './ai-kit-harness'

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

export function relayApp(h: Harness) {
  const app = new Hono<AppBindings>()
  app.use('/api/*', async (c, next) => {
    c.set('userId', 'user-a')
    c.set('user', {
      id: 'user-a',
      username: 'user-a',
      login: 'user-a',
      name: 'user-a',
      avatarUrl: '',
      role: 'owner',
      createdAt: 0,
      settingsRaw: '{}',
    })
    await next()
  })
  app.route('/api/relay', relaySettingsRoutes)
  app.route('/relay', relayRoutes)
  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(
      path,
      {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      h.env,
    )
  const raw = (path: string, init: RequestInit) =>
    app.request(path, init, h.env)
  return {
    request,
    raw,
    json: async <T>(method: string, path: string, body?: unknown) =>
      (await (await request(method, path, body)).json()) as T,
  }
}

export async function provider(
  h: Harness,
  name: string,
  baseUrl: string,
  key: string,
  models = ['m1'],
  protocol = 'openai-chat',
  image = false,
) {
  const { body } = await h.json<
    {
      name: string
      endpoints: {
        id: string
      }[]
    }[]
  >('user-a', 'PUT', '/providers', {
    name,
    endpoints: [
      {
        slug: 'main',
        baseUrl,
        protocol,
        models: models.map((id) => ({
          ...chatModel(id),
          ...(image ? { modelType: 'image' } : {}),
        })),
      },
    ],
  })
  const endpointId = body.find((item) => item.name === name)!.endpoints[0]!.id
  await addKey(h, 'user-a', endpointId, key)
  return endpointId
}

export async function setup() {
  const h = await createHarness()
  const relay = relayApp(h)
  const { token } = await relay.json<{
    token: string
  }>('POST', '/api/relay/keys', { name: 'omp' })
  const auth = { authorization: `Bearer ${token}` }
  return { h, relay, token, auth }
}

export const sentAuth = (index: number) =>
  (fetchMock.mock.calls[index]![1]!.headers as Record<string, string>)
    .authorization
