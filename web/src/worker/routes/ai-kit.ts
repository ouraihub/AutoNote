import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { RunEvent } from '@ouraihub/aether-ui/ports'
import type { AppBindings } from '../env'
import { ApiError, errorResponse } from '../lib/errors'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { deleteConversation, editTurn, forkConversation, listConversations, loadConversation, removeTurn, renameConversation, selectTurn, toWire } from '../ai/history'
import { HTTP_STATUS, KitFailure, acquireSlot, checkLength, parseBody } from '../ai/kit'
import { EndpointKeySaveSchema, ModelFilterSchema, ProbeTargetSchema, ProviderSaveSchema, listProviders, modelOptions, probe, removeKey as removeEndpointKey, removeProvider, revealKey, saveKey as saveEndpointKey, saveProvider, setProviderEnabled } from '../ai/providers'
import { RunRequestSchema, executeRun, prepareRun } from '../ai/runs'
import { forgetImages, readImage } from '../ai/images'
import { check as checkSearch, fetchPage, getSettings as searchSettings, reveal as revealSearch, saveProvider as saveSearchProvider, search as searchWeb, setDefault as setSearchDefault, savePreferences, saveKey, removeKey } from '../ai/search'
import { z } from 'zod'

const RenameSchema = z.strictObject({ title: z.string() })
const TurnSchema = z.strictObject({ turnId: z.string().trim().min(1).max(128) })
const EditSchema = z.strictObject({ text: z.string(), expectedText: z.string() })

export const aiKitRoutes = new Hono<AppBindings>()

aiKitRoutes.onError((error, c) =>
  error instanceof KitFailure
    ? c.json({ error: error.toJSON() }, HTTP_STATUS[error.code] as ContentfulStatusCode)
    : errorResponse(c, error),
)
aiKitRoutes.use('*', requireAuth)
aiKitRoutes.use('*', async (c, next) => {
  if (c.get('user').role !== 'owner') throw ApiError.forbidden('AI is available to the owner only')
  await next()
})

aiKitRoutes.get('/providers', async (c) => c.json(await listProviders(c.env, c.get('userId'))))
aiKitRoutes.put('/providers', async (c) => {
  const input = parseBody(ProviderSaveSchema, await readJson(c, JSON_BODY_LIMITS.profile))
  return c.json(await saveProvider(c.env, c.get('userId'), input))
})
aiKitRoutes.patch('/providers/:id/enabled', async (c) => {
  const body = await readJson<{ enabled?: unknown }>(c, JSON_BODY_LIMITS.small)
  if (typeof body.enabled !== 'boolean') throw new KitFailure('bad_request', 'enabled must be boolean')
  return c.json(await setProviderEnabled(c.env, c.get('userId'), c.req.param('id'), body.enabled))
})
aiKitRoutes.delete('/providers/:id', async (c) => c.json(await removeProvider(c.env, c.get('userId'), c.req.param('id'))))
aiKitRoutes.put('/endpoint-keys', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    const input = parseBody(EndpointKeySaveSchema, await readJson(c, JSON_BODY_LIMITS.small))
    return c.json(await saveEndpointKey(c.env, c.get('userId'), input))
  } finally { release() }
})
aiKitRoutes.delete('/endpoint-keys/:keyId', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    const body = await readJson<{ endpointId?: unknown }>(c, JSON_BODY_LIMITS.small)
    if (typeof body.endpointId !== 'string') throw new KitFailure('bad_request', 'endpointId must be string')
    return c.json(await removeEndpointKey(c.env, c.get('userId'), body.endpointId, c.req.param('keyId')))
  } finally { release() }
})
aiKitRoutes.post('/endpoint-keys/:keyId/reveal', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    const body = await readJson<{ currentPassword?: unknown }>(c, JSON_BODY_LIMITS.small)
    return c.json({ key: await revealKey(c.env, c.get('userId'), c.req.param('keyId'), body.currentPassword) })
  } finally { release() }
})
aiKitRoutes.get('/search/settings', async (c) => c.json(await searchSettings(c.env, c.get('userId'), c.req.query('capability'))))
aiKitRoutes.put('/search/providers', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    return c.json(await saveSearchProvider(c.env, c.get('userId'), await readJson(c, JSON_BODY_LIMITS.profile)))
  } finally {
    release()
  }
})
aiKitRoutes.put('/search/default', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    return c.json(await setSearchDefault(c.env, c.get('userId'), await readJson(c, JSON_BODY_LIMITS.small)))
  } finally {
    release()
  }
})
aiKitRoutes.put('/search/preferences', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try { return c.json(await savePreferences(c.env, c.get('userId'), await readJson(c, JSON_BODY_LIMITS.profile))) }
  finally { release() }
})
aiKitRoutes.put('/search/keys', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try { return c.json(await saveKey(c.env, c.get('userId'), await readJson(c, JSON_BODY_LIMITS.profile))) }
  finally { release() }
})
aiKitRoutes.delete('/search/keys/:id', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    const body = await readJson<{ capability?: unknown; provider?: unknown }>(c, JSON_BODY_LIMITS.small)
    return c.json(await removeKey(c.env, c.get('userId'), { ...body, keyId: c.req.param('id') }))
  } finally { release() }
})
aiKitRoutes.post('/search/reveal', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    return c.json(await revealSearch(c.env, c.get('userId'), await readJson(c, JSON_BODY_LIMITS.small)))
  } finally {
    release()
  }
})
aiKitRoutes.post('/search/check', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    const body = await readJson<{ capability?: unknown; provider?: unknown }>(c, JSON_BODY_LIMITS.small)
    return c.json(await checkSearch(c.env, c.get('userId'), body.capability, body.provider, c.req.raw.signal))
  } finally {
    release()
  }
})
aiKitRoutes.post('/search/query', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    const body = await readJson<{ query?: unknown }>(c, JSON_BODY_LIMITS.small)
    if (typeof body.query !== 'string') throw new KitFailure('bad_request', 'invalid query')
    return c.json(await searchWeb(c.env, c.get('userId'), body.query, c.req.raw.signal))
  } finally {
    release()
  }
})
aiKitRoutes.post('/search/fetch', async (c) => {
  const release = acquireSlot(c.get('userId'))
  try {
    const body = await readJson<{ url?: unknown }>(c, JSON_BODY_LIMITS.small)
    if (typeof body.url !== 'string') throw new KitFailure('bad_request', 'invalid url')
    return c.json(await fetchPage(c.env, c.get('userId'), body.url, c.req.raw.signal))
  } finally {
    release()
  }
})
aiKitRoutes.get('/model-options', async (c) => {
  const filter = parseBody(ModelFilterSchema, c.req.query())
  return c.json(await modelOptions(c.env.DB, c.get('userId'), filter))
})
aiKitRoutes.post('/probe', async (c) => {
  const target = parseBody(ProbeTargetSchema, await readJson(c, JSON_BODY_LIMITS.small))
  const release = acquireSlot(c.get('userId'))
  try {
    return c.json(await probe(c.env, c.get('userId'), target, c.req.raw.signal))
  } finally {
    release()
  }
})

aiKitRoutes.post('/runs', async (c) => {
  const req = parseBody(RunRequestSchema, await readJson(c, JSON_BODY_LIMITS.run))
  const userId = c.get('userId')
  const release = acquireSlot(userId)
  const prepared = await prepareRun(c.env, userId, req).catch((error: unknown) => {
    release()
    throw error
  })
  const cancel = new AbortController()
  c.req.raw.signal.addEventListener('abort', () => cancel.abort(), { once: true })
  const encoder = new TextEncoder()
  let open = true
  let controller: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      open = false
      cancel.abort()
    },
  })
  const send = (frame: unknown): void => {
    if (!open) return
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`))
    } catch {
      open = false
      cancel.abort()
    }
  }
  send({ kind: 'accepted', runId: prepared.runId, conversationId: prepared.turn?.conversationId ?? null, turnId: prepared.turn?.turnId ?? null })
  const task = executeRun(c.env, userId, prepared, cancel.signal, (event: RunEvent) => {
    send(event)
    if (event.kind === 'end' && open) {
      open = false
      controller.close()
    }
  }).finally(release)
  try {
    c.executionCtx.waitUntil(task)
  } catch {
    task.catch(() => {})
  }
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } })
})

aiKitRoutes.get('/conversations', async (c) => {
  const scope = c.req.query('scope') ?? null
  checkLength('scope', scope, 200)
  return c.json(await listConversations(c.env.DB, c.get('userId'), scope))
})
aiKitRoutes.get('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  checkLength('id', id, 128)
  return c.json(toWire(await loadConversation(c.env.DB, c.get('userId'), id)))
})
aiKitRoutes.delete('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  checkLength('id', id, 128)
  const turnIds = (await loadConversation(c.env.DB, c.get('userId'), id)).turns.map((turn) => turn.id)
  await deleteConversation(c.env.DB, c.get('userId'), id)
  await forgetImages(c.env, c.get('userId'), turnIds)
  return c.json({ ok: true as const })
})
aiKitRoutes.patch('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  checkLength('id', id, 128)
  const { title } = parseBody(RenameSchema, await readJson(c, JSON_BODY_LIMITS.small))
  checkLength('title', title, 200)
  return c.json(await renameConversation(c.env.DB, c.get('userId'), id, title))
})

aiKitRoutes.patch('/conversations/:id/turns/:turnId', async (c) => {
  const { text, expectedText } = parseBody(EditSchema, await readJson(c, JSON_BODY_LIMITS.note))
  checkLength('id', c.req.param('id'), 128)
  checkLength('turnId', c.req.param('turnId'), 128)
  return c.json(await editTurn(c.env.DB, c.get('userId'), c.req.param('id'), c.req.param('turnId'), text, expectedText))
})
aiKitRoutes.delete('/conversations/:id/turns/:turnId', async (c) => {
  checkLength('id', c.req.param('id'), 128)
  checkLength('turnId', c.req.param('turnId'), 128)
  const result = await removeTurn(c.env.DB, c.get('userId'), c.req.param('id'), c.req.param('turnId'))
  await forgetImages(c.env, c.get('userId'), [c.req.param('turnId')])
  return c.json(result)
})
aiKitRoutes.get('/conversations/:id/turns/:turnId/images/:idx', async (c) => {
  checkLength('id', c.req.param('id'), 128)
  checkLength('turnId', c.req.param('turnId'), 128)
  const idx = Number(c.req.param('idx'))
  if (!Number.isInteger(idx) || idx < 0 || idx > 3) throw new KitFailure('not_found', 'image', { entity: 'image' })
  return readImage(c.env, c.get('userId'), c.req.param('id'), c.req.param('turnId'), idx)
})
aiKitRoutes.post('/conversations/:id/fork', async (c) => {
  const { turnId } = parseBody(TurnSchema, await readJson(c, JSON_BODY_LIMITS.small))
  checkLength('id', c.req.param('id'), 128)
  return c.json(await forkConversation(c.env.DB, c.get('userId'), c.req.param('id'), turnId))
})
aiKitRoutes.put('/conversations/:id/selection', async (c) => {
  const { turnId } = parseBody(TurnSchema, await readJson(c, JSON_BODY_LIMITS.small))
  checkLength('id', c.req.param('id'), 128)
  return c.json(await selectTurn(c.env.DB, c.get('userId'), c.req.param('id'), turnId))
})
