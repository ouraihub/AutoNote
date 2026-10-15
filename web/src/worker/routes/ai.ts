import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings } from '../env'
import { decryptAiKey } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { readJson } from '../lib/request'
import { requireCurrentPassword } from '../lib/reauth'
import { requireAuth } from '../middleware/auth'

const ROLES = ['chat', 'writing', 'painting'] as const
type Role = (typeof ROLES)[number]
const RoleBody = z.strictObject({
  role: z.enum(ROLES),
  binding: z
    .strictObject({ endpointId: z.string().refine(isValidId), modelId: z.string().trim().min(1).max(200) })
    .nullable(),
})

export const aiRoutes = new Hono<AppBindings>()
aiRoutes.use('*', requireAuth)
aiRoutes.use('*', async (c, next) => {
  if (c.get('user').role !== 'owner') throw ApiError.forbidden('AI is available to the owner only')
  await next()
})

aiRoutes.post('/endpoints/:id/key', async (c) => {
  const id = c.req.param('id')
  const userId = c.get('userId')
  const endpoint = await c.env.DB.prepare('SELECT key_ciphertext AS keyCiphertext FROM ai_endpoints WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<{ keyCiphertext: string | null }>()
  if (!endpoint) throw ApiError.notFound('Endpoint not found')
  const body = await readJson<{ currentPassword?: unknown }>(c, 4096)
  await requireCurrentPassword(c.env.DB, userId, body.currentPassword)
  if (!endpoint.keyCiphertext) throw ApiError.notFound('API key not configured')
  const key = await decryptAiKey(c.env, id, endpoint.keyCiphertext)
  if (!key) throw ApiError.conflict('Stored API key is unavailable')
  return c.json({ key })
})

aiRoutes.get('/roles', async (c) => listRoles(c.env.DB, c.get('userId')))
aiRoutes.put('/roles', async (c) => {
  const userId = c.get('userId')
  const parsed = RoleBody.safeParse(await readJson(c, 4096))
  if (!parsed.success) throw ApiError.badRequest('Invalid role binding')
  const { role, binding } = parsed.data
  if (binding) {
    const saved = await c.env.DB.prepare('SELECT 1 FROM ai_models WHERE user_id = ?1 AND endpoint_id = ?2 AND model_id = ?3 AND model_type = ?4')
      .bind(userId, binding.endpointId, binding.modelId, role === 'painting' ? 'image' : 'chat')
      .first()
    if (!saved) throw ApiError.badRequest(role === 'painting' ? 'Binding must reference a saved image model' : 'Binding must reference a saved chat model')
    await c.env.DB.prepare('INSERT INTO ai_roles (user_id,role,endpoint_id,model_id) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id,role) DO UPDATE SET endpoint_id=?3, model_id=?4')
      .bind(userId, role, binding.endpointId, binding.modelId)
      .run()
  } else await c.env.DB.prepare('DELETE FROM ai_roles WHERE user_id = ?1 AND role = ?2').bind(userId, role).run()
  return listRoles(c.env.DB, userId)
})

async function listRoles(db: D1Database, userId: string): Promise<Response> {
  const { results } = await db.prepare('SELECT role,endpoint_id AS endpointId,model_id AS modelId FROM ai_roles WHERE user_id = ?1').bind(userId).all<{ role: Role; endpointId: string; modelId: string }>()
  const chat = results.find((row) => row.role === 'chat')
  return Response.json(
    ROLES.map((role) => {
      const own = results.find((row) => row.role === role)
      const row = own ?? (role === 'writing' ? chat : undefined)
      return {
        role,
        binding: row ? { endpointId: row.endpointId, modelId: row.modelId, label: row.modelId } : null,
        isFallback: role === 'writing' && !own && Boolean(chat),
      }
    }),
  )
}

