import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import type { AppBindings, Env } from '../../src/worker/env'
import { initializeDatabase } from '../../src/worker/db/schema'
import { aiKitRoutes } from '../../src/worker/routes/ai-kit'
import { createD1 } from './d1-sqlite'

const require = createRequire(import.meta.url)
export const fixture = (path: string): Buffer => readFileSync(require.resolve(`@ouraihub/aether-ui/fixtures/${path}`))

const vault = {
  idFromName: () => 'vault',
  get: () => ({
    async fetch(url: string, init: RequestInit) {
      const body = JSON.parse(String(init.body)) as { scope: string; value?: unknown; ciphertext?: string }
      if (url.endsWith('/encrypt')) return Response.json({ ciphertext: JSON.stringify({ scope: body.scope, value: body.value }) })
      const stored = JSON.parse(body.ciphertext ?? '{}') as { scope?: string; value?: unknown }
      return stored.scope === body.scope ? Response.json({ value: stored.value }) : new Response(null, { status: 422 })
    },
  }),
}

export interface Harness {
  env: Env
  call: (user: string, method: string, path: string, body?: unknown, signal?: AbortSignal) => Promise<Response>
  json: <T = unknown>(user: string, method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>
  settle: () => Promise<void>
  /** In-memory R2 objects backing `env.FILES`. */
  objects: Map<string, Uint8Array>
}

/** `shared` + `routes`: another Worker isolate (own module state) over the same D1/R2 bindings. */
export async function createHarness(shared?: { env: Env; objects: Map<string, Uint8Array> }, routes: typeof aiKitRoutes = aiKitRoutes): Promise<Harness> {
  const objects = shared?.objects ?? new Map<string, Uint8Array>()
  const FILES = {
    put: async (key: string, value: Uint8Array) => { objects.set(key, new Uint8Array(value)) },
    get: async (key: string) => {
      const bytes = objects.get(key)
      return bytes ? { body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.slice().buffer } : null
    },
    delete: async (key: string) => { objects.delete(key) },
  }
  const env = shared?.env ?? ({ DB: createD1(), CREDENTIAL_VAULT: vault, FILES } as unknown as Env)
  if (!shared) await initializeDatabase(env)
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user') ?? 'user-a'
    c.set('userId', userId)
    c.set('user', { id: userId, username: userId, login: userId, name: userId, avatarUrl: '', role: 'owner', createdAt: 0, settingsRaw: '{}' })
    await next()
  })
  app.route('/api/ai/kit', routes)
  const pending: Promise<unknown>[] = []
  const ctx = { waitUntil: (task: Promise<unknown>) => pending.push(task), passThroughOnException: () => {}, props: {} }
  const call = (user: string, method: string, path: string, body?: unknown, signal?: AbortSignal) =>
    app.request(
      `/api/ai/kit${path}`,
      {
        method,
        headers: { 'x-test-user': user, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      },
      env,
      ctx as unknown as ExecutionContext,
    )
  const json = async <T = unknown>(user: string, method: string, path: string, body?: unknown) => {
    const response = await call(user, method, path, body)
    return { status: response.status, body: (await response.json()) as T }
  }
  const settle = async () => {
    while (pending.length) await pending.shift()
  }
  return { env, call, json, settle, objects }
}

/** Adds one key to an endpoint through the key route; returns the key id. */
export async function addKey(h: Harness, user: string, endpointId: string, key: string): Promise<string> {
  const { status, body } = await h.json<{ endpoints: { id: string; keys: { id: string }[] }[] }[]>(user, 'PUT', '/endpoint-keys', { endpointId, key })
  if (status !== 200) throw new Error(`addKey failed: ${status}`)
  return body.flatMap((provider) => provider.endpoints).find((endpoint) => endpoint.id === endpointId)!.keys.at(-1)!.id
}

export function frames(text: string): Record<string, unknown>[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}

export function streamOf(bytes: Uint8Array, chunk = bytes.length): ReadableStream<Uint8Array> {
  let offset = 0
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close()
      controller.enqueue(bytes.slice(offset, offset + chunk))
      offset += chunk
    },
  })
}

export const chatModel = (id: string) => ({
  id,
  modelType: 'chat',
  typeSource: 'user',
  contextWindow: null,
  maxOutput: null,
  canVision: false,
  supportsTools: null,
  nativeWebSearch: false,
  name: null,
  groupName: null,
  pricing: null,
})
