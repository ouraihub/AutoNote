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

export async function createHarness() {
  const env = { DB: createD1(), CREDENTIAL_VAULT: vault } as unknown as Env
  await initializeDatabase(env)
  const app = new Hono<AppBindings>()
  app.use('*', async (c, next) => {
    const userId = c.req.header('x-test-user') ?? 'user-a'
    c.set('userId', userId)
    c.set('user', { id: userId, username: userId, login: userId, name: userId, avatarUrl: '', role: 'owner', createdAt: 0, settingsRaw: '{}' })
    await next()
  })
  app.route('/api/ai/kit', aiKitRoutes)
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
  return { env, call, json, settle }
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
  reasoning: null,
  nativeWebSearch: false,
})
