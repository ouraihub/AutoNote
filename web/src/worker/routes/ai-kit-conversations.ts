import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { KitFailure, checkLength, parseBody } from '../ai/kit'
import { deleteConversation, editTurn, forkConversation, listConversations, loadConversation, removeTurn, renameConversation, selectTurn, toWire } from '../ai/history'
import { forgetImages, readImage } from '../ai/images'
import { z } from 'zod'
const RenameSchema = z.strictObject({ title: z.string() })
const TurnSchema = z.strictObject({ turnId: z.string().trim().min(1).max(128) })
const EditSchema = z.strictObject({ text: z.string(), expectedText: z.string() })
export const aiKitConversationRoutes = new Hono<AppBindings>()
aiKitConversationRoutes.get('/', async (c) => {
  const scope = c.req.query('scope') ?? null
  checkLength('scope', scope, 200)
  return c.json(await listConversations(c.env.DB, c.get('userId'), scope))
})
aiKitConversationRoutes.get('/:id', async (c) => {
  const id = c.req.param('id'); checkLength('id', id, 128)
  return c.json(toWire(await loadConversation(c.env.DB, c.get('userId'), id)))
})
aiKitConversationRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id'); checkLength('id', id, 128)
  const turnIds = (await loadConversation(c.env.DB, c.get('userId'), id)).turns.map((turn) => turn.id)
  await deleteConversation(c.env.DB, c.get('userId'), id); await forgetImages(c.env, c.get('userId'), turnIds)
  return c.json({ ok: true as const })
})
aiKitConversationRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id'); checkLength('id', id, 128)
  const { title } = parseBody(RenameSchema, await readJson(c, JSON_BODY_LIMITS.small)); checkLength('title', title, 200)
  return c.json(await renameConversation(c.env.DB, c.get('userId'), id, title))
})
aiKitConversationRoutes.patch('/:id/turns/:turnId', async (c) => {
  const { text, expectedText } = parseBody(EditSchema, await readJson(c, JSON_BODY_LIMITS.note)); const id = c.req.param('id'); const turnId = c.req.param('turnId')
  checkLength('id', id, 128); checkLength('turnId', turnId, 128)
  return c.json(await editTurn(c.env.DB, c.get('userId'), id, turnId, text, expectedText))
})
aiKitConversationRoutes.delete('/:id/turns/:turnId', async (c) => {
  const id = c.req.param('id'); const turnId = c.req.param('turnId'); checkLength('id', id, 128); checkLength('turnId', turnId, 128)
  const before = (await loadConversation(c.env.DB, c.get('userId'), id)).turns.map((turn) => turn.id)
  const result = await removeTurn(c.env.DB, c.get('userId'), id, turnId)
  await forgetImages(c.env, c.get('userId'), before.filter((value) => !result.turns.some((turn) => turn.id === value)))
  return c.json(result)
})
aiKitConversationRoutes.get('/:id/turns/:turnId/images/:idx', async (c) => {
  const id = c.req.param('id'); const turnId = c.req.param('turnId'); checkLength('id', id, 128); checkLength('turnId', turnId, 128)
  const idx = Number(c.req.param('idx')); if (!Number.isInteger(idx) || idx < 0 || idx > 3) throw new KitFailure('not_found', 'image', { entity: 'image' })
  return readImage(c.env, c.get('userId'), id, turnId, idx)
})
aiKitConversationRoutes.post('/:id/fork', async (c) => {
  const { turnId } = parseBody(TurnSchema, await readJson(c, JSON_BODY_LIMITS.small)); const id = c.req.param('id'); checkLength('id', id, 128)
  return c.json(await forkConversation(c.env.DB, c.get('userId'), id, turnId))
})
aiKitConversationRoutes.put('/:id/selection', async (c) => {
  const { turnId } = parseBody(TurnSchema, await readJson(c, JSON_BODY_LIMITS.small)); const id = c.req.param('id'); checkLength('id', id, 128)
  return c.json(await selectTurn(c.env.DB, c.get('userId'), id, turnId))
})
