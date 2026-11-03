import { Hono } from 'hono'
import { expect, it } from 'vitest'
import { createHarness } from './support/ai-kit-harness'
import { notesRoutes } from '../src/worker/routes/notes'
import type { AppBindings } from '../src/worker/env'
import { ApiError } from '../src/worker/lib/errors'

it('archives and unarchives through revision-guarded note writes', async () => {
  const h = await createHarness()
  const app = new Hono<AppBindings>()
  app.onError((error, c) => {
    if (error instanceof ApiError)
      return c.json({ error: { code: error.code } }, error.status)
    throw error
  })
  app.use('*', async (c, next) => {
    c.set('userId', 'user-a')
    c.set('database', { ftsEnabled: false })
    await next()
  })
  app.route('/notes', notesRoutes)
  const json = async <T>(path: string, body: object, method = 'PATCH') => {
    const response = await app.request(
      `/notes${path}`,
      {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      h.env,
      { waitUntil: () => {} } as unknown as ExecutionContext,
    )
    return { status: response.status, body: (await response.json()) as T }
  }
  const created = await json<{ id: string; rev: number }>(
    '',
    { title: 'Archive fixture', content: 'Body' },
    'POST',
  )
  expect(created.status).toBe(201)
  const archived = await json<{ rev: number; isArchived: boolean }>(
    `/${created.body.id}`,
    { rev: created.body.rev, isArchived: true },
  )
  expect(archived.status).toBe(200)
  expect(archived.body.isArchived).toBe(true)
  expect(archived.body.rev).toBe(created.body.rev + 1)
  const stale = await json(`/${created.body.id}`, {
    rev: created.body.rev,
    isArchived: false,
  })
  expect(stale.status).toBe(409)
  const restored = await json<{ rev: number; isArchived: boolean }>(
    `/${created.body.id}`,
    { rev: archived.body.rev, isArchived: false },
  )
  expect(restored.status).toBe(200)
  expect(restored.body.isArchived).toBe(false)
  expect(restored.body.rev).toBe(archived.body.rev + 1)
})
