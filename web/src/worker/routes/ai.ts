import { Hono } from 'hono'
import type { Context } from 'hono'
import type { AiChatRequest, AiWriteRequest } from '@shared/ai-types'
import { aiModelGroup, inferAiModel, type AiModelType, type AiProtocol } from '@shared/ai-classify'
import type { AppBindings, Env } from '../env'
import { decryptAiKey, encryptAiKey } from '../lib/crypto'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireCurrentPassword } from '../lib/reauth'
import { requireAuth } from '../middleware/auth'

const PROTOCOLS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const
const ROLES = ['chat', 'writing'] as const
const ACTIONS = ['polish', 'rewrite', 'shorten', 'expand', 'continue'] as const
const active = new Map<string, number>()
const requests = new Map<string, { at: number; count: number }>()

type Role = (typeof ROLES)[number]
type RouteContext = Context<AppBindings>
type Model = { endpointId: string; baseUrl: string; protocol: AiProtocol; modelId: string; key: string; isFallback: boolean }
type Message = { role: 'system' | 'user' | 'assistant'; content: string }

export const aiRoutes = new Hono<AppBindings>()
aiRoutes.use('*', requireAuth)
aiRoutes.use('*', async (c, next) => {
  if (c.get('user').role !== 'owner') throw ApiError.forbidden('AI is available to the owner only')
  await next()
})

aiRoutes.get('/providers', async (c) => listProviders(c.env.DB, c.get('userId')))
aiRoutes.put('/providers', async (c) => {
  const raw = await readJson<Record<string, unknown>>(c, JSON_BODY_LIMITS.settings)
  const provider = objectValue(raw.provider) ?? raw
  const name = stringValue(provider.name, 120)
  const endpointInputs = Array.isArray(provider.endpoints) ? provider.endpoints : null
  if (!name || !endpointInputs || endpointInputs.length > 20) throw ApiError.badRequest('Invalid provider')
  const userId = c.get('userId')
  const providerId = validId(provider.id) ?? newId()
  const now = Date.now()
  const oldKeys = Object.fromEntries(
    (await c.env.DB.prepare('SELECT id,key_ciphertext AS keyCiphertext FROM ai_endpoints WHERE provider_id = ?1 AND user_id = ?2').bind(providerId, userId).all<{ id: string; keyCiphertext: string | null }>()).results.map((row) => [row.id, row.keyCiphertext]),
  ) as Record<string, string | null>
  const existing = await c.env.DB.prepare('SELECT id FROM ai_providers WHERE id = ?1 AND user_id = ?2').bind(providerId, userId).first()
  const statements: D1PreparedStatement[] = [
    existing
      ? c.env.DB.prepare('UPDATE ai_providers SET name = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4').bind(name, now, providerId, userId)
      : c.env.DB.prepare('INSERT INTO ai_providers (id,user_id,name,position,created_at,updated_at) VALUES (?1,?2,?3,0,?4,?4)').bind(providerId, userId, name, now),
    c.env.DB.prepare('DELETE FROM ai_endpoints WHERE provider_id = ?1 AND user_id = ?2').bind(providerId, userId),
  ]
  for (let i = 0; i < endpointInputs.length; i++) {
    const endpoint = objectValue(endpointInputs[i])
    if (!endpoint) throw ApiError.badRequest('Invalid endpoint')
    const id = validId(endpoint.id) ?? newId()
    const slug = stringValue(endpoint.slug, 80)
    const baseUrl = normalizeBaseUrl(endpoint.baseUrl)
    const protocol = endpoint.protocol
    if (!slug || !baseUrl || !isProtocol(protocol)) throw ApiError.badRequest('Invalid endpoint')
    await assertSafeUrl(c.env.DB, baseUrl)
    const modelInputs = Array.isArray(endpoint.models) ? endpoint.models : []
    if (modelInputs.length > 1000) throw ApiError.badRequest('Too many models')
    let ciphertext: string | null = null
    if (typeof endpoint.apiKey === 'string' && endpoint.apiKey.length > 0) ciphertext = await encryptAiKey(c.env, id, endpoint.apiKey)
    if (ciphertext === null) ciphertext = oldKeys[id] ?? null
    statements.push(c.env.DB.prepare('INSERT INTO ai_endpoints (id,user_id,provider_id,slug,base_url,protocol,key_ciphertext,position) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)').bind(id, userId, providerId, slug, baseUrl, protocol, ciphertext, i))
    for (let j = 0; j < modelInputs.length; j++) {
      const model = objectValue(modelInputs[j])
      const modelId = model ? stringValue(model.id, 200) : null
      if (!model || !modelId) throw ApiError.badRequest('Invalid model')
      const inferred = inferAiModel(modelId, protocol)
      const modelType = isModelType(model.modelType) ? model.modelType : inferred.modelType
      statements.push(c.env.DB.prepare('INSERT INTO ai_models (user_id,endpoint_id,model_id,model_type,type_source,context_window,can_vision,position) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)').bind(userId, id, modelId, modelType, model.typeSource === 'user' ? 'user' : 'inferred', typeof model.contextWindow === 'number' ? model.contextWindow : inferred.contextWindow, model.canVision === true || (model.canVision === undefined && inferred.canVision) ? 1 : 0, j))
    }
  }
  statements.push(c.env.DB.prepare('DELETE FROM ai_roles WHERE user_id = ?1 AND (endpoint_id NOT IN (SELECT id FROM ai_endpoints WHERE user_id = ?1) OR model_id NOT IN (SELECT model_id FROM ai_models WHERE user_id = ?1 AND endpoint_id = ai_roles.endpoint_id))').bind(userId))
  await c.env.DB.batch(statements)
  return listProviders(c.env.DB, userId)
})
aiRoutes.delete('/providers/:id', async (c) => {
  const id = c.req.param('id')
  const userId = c.get('userId')
  const existing = await c.env.DB.prepare('SELECT id FROM ai_providers WHERE id = ?1 AND user_id = ?2').bind(id, userId).first()
  if (!existing) throw ApiError.notFound('Provider not found')
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM ai_roles WHERE user_id = ?1 AND endpoint_id IN (SELECT id FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2)').bind(userId, id),
    c.env.DB.prepare('DELETE FROM ai_models WHERE user_id = ?1 AND endpoint_id IN (SELECT id FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2)').bind(userId, id),
    c.env.DB.prepare('DELETE FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2').bind(userId, id),
    c.env.DB.prepare('DELETE FROM ai_providers WHERE id = ?1 AND user_id = ?2').bind(id, userId),
  ])
  return c.json({ ok: true as const })
})

aiRoutes.post('/endpoints/:id/key', async (c) => {
  const id = c.req.param('id')
  const endpoint = await loadEndpoint(c.env.DB, c.get('userId'), id)
  const body = await readJson<{ currentPassword?: unknown }>(c, 4096)
  await requireCurrentPassword(c.env.DB, c.get('userId'), body.currentPassword)
  if (!endpoint.keyCiphertext) throw ApiError.notFound('API key not configured')
  const key = await decryptAiKey(c.env, id, endpoint.keyCiphertext)
  if (!key) throw ApiError.conflict('Stored API key is unavailable')
  return c.json({ key })
})
aiRoutes.post('/endpoints/:id/probe', async (c) => {
  const endpoint = await loadEndpoint(c.env.DB, c.get('userId'), c.req.param('id'))
  const probeUrl = `${endpoint.baseUrl}/models`
  const key = endpoint.keyCiphertext ? await decryptAiKey(c.env, endpoint.id, endpoint.keyCiphertext) : null
  if (!key) return c.json({ probeUrl, models: [], error: { kind: 'missing_key', status: null, message: null } })
  let response: Response
  try {
    response = await fetch(probeUrl, { headers: providerHeaders(endpoint.protocol, key), signal: AbortSignal.timeout(20_000), redirect: 'manual' })
  } catch (error) {
    return c.json({ probeUrl, models: [], error: { kind: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'connect', status: null, message: null } })
  }
  if (!response.ok) return c.json({ probeUrl, models: [], error: probeError(response.status) })
  try {
    const ids = modelIds(await response.json())
    if (ids.length) return c.json({ probeUrl, models: ids.map((id) => ({ id, ...inferAiModel(id, endpoint.protocol), typeSource: 'inferred', group: aiModelGroup(id) })), error: null })
  } catch {
  }
  return c.json({ probeUrl, models: [], error: { kind: 'invalid_body', status: null, message: null } })
})

aiRoutes.get('/roles', async (c) => listRoles(c.env.DB, c.get('userId')))
aiRoutes.put('/roles', async (c) => {
  const body = await readJson<{ role?: unknown; binding?: unknown }>(c, 4096)
  if (!isRole(body.role) || (body.binding !== null && !objectValue(body.binding))) throw ApiError.badRequest('Invalid role binding')
  const binding = objectValue(body.binding)
  if (binding) {
    const endpointId = validId(binding.endpointId)
    const modelId = stringValue(binding.modelId, 200)
    if (!endpointId || !modelId || !(await c.env.DB.prepare("SELECT 1 FROM ai_models WHERE user_id = ?1 AND endpoint_id = ?2 AND model_id = ?3 AND model_type = 'chat'").bind(c.get('userId'), endpointId, modelId).first())) throw ApiError.badRequest('Binding must reference a saved chat model')
    await c.env.DB.prepare('INSERT INTO ai_roles (user_id,role,endpoint_id,model_id) VALUES (?1,?2,?3,?4) ON CONFLICT(user_id,role) DO UPDATE SET endpoint_id=?3, model_id=?4').bind(c.get('userId'), body.role, endpointId, modelId).run()
  } else await c.env.DB.prepare('DELETE FROM ai_roles WHERE user_id = ?1 AND role = ?2').bind(c.get('userId'), body.role).run()
  return listRoles(c.env.DB, c.get('userId'))
})

aiRoutes.get('/conversations', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id,title,updated_at AS updatedAt FROM ai_conversations WHERE user_id = ?1 ORDER BY updated_at DESC,id DESC LIMIT 100').bind(c.get('userId')).all()
  return c.json(results)
})
aiRoutes.get('/conversations/:id', async (c) => {
  const id = c.req.param('id')
  const conversation = await c.env.DB.prepare('SELECT id,title FROM ai_conversations WHERE id = ?1 AND user_id = ?2').bind(id, c.get('userId')).first()
  if (!conversation) throw ApiError.notFound('Conversation not found')
  const { results } = await c.env.DB.prepare("SELECT id,role,content,status,model_id AS modelId,created_at AS createdAt FROM ai_messages WHERE conversation_id = ?1 AND user_id = ?2 AND status = 'done' ORDER BY created_at,id").bind(id, c.get('userId')).all()
  return c.json({ ...conversation, messages: results })
})
aiRoutes.delete('/conversations/:id', async (c) => {
  const result = await c.env.DB.prepare('DELETE FROM ai_conversations WHERE id = ?1 AND user_id = ?2').bind(c.req.param('id'), c.get('userId')).run()
  if (!result.meta.changes) throw ApiError.notFound('Conversation not found')
  return c.json({ ok: true as const })
})

aiRoutes.post('/chat', async (c) => {
  const body = await readJson<AiChatRequest>(c, JSON_BODY_LIMITS.note)
  if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 24_000) throw ApiError.badRequest('Invalid chat content')
  const role: Role = body.role === 'writing' ? 'writing' : 'chat'
  const model = await resolveModel(c.env, c.env.DB, c.get('userId'), role, body.model)
  const conversationId = validId(body.conversationId) ?? newId()
  const existing = await c.env.DB.prepare('SELECT id FROM ai_conversations WHERE id = ?1 AND user_id = ?2').bind(conversationId, c.get('userId')).first()
  if (body.conversationId && !existing) throw ApiError.notFound('Conversation not found')
  const now = Date.now()
  if (!existing) await c.env.DB.prepare('INSERT INTO ai_conversations (id,user_id,title,created_at,updated_at) VALUES (?1,?2,?3,?4,?4)').bind(conversationId, c.get('userId'), body.content.slice(0, 40), now).run()
  await c.env.DB.prepare("INSERT INTO ai_messages (id,conversation_id,user_id,role,content,status,model_id,created_at) VALUES (?1,?2,?3,'user',?4,'done',NULL,?5)").bind(newId(), conversationId, c.get('userId'), body.content, now).run()
  const messages: Message[] = [{ role: 'user', content: body.content }]
  if (body.note && typeof body.note.content === 'string') messages.unshift({ role: 'system', content: body.note.content.slice(0, 24_000) })
  return stream(c, model, messages, body.maxTokens, conversationId)
})
aiRoutes.post('/write', async (c) => {
  const body = await readJson<AiWriteRequest>(c, JSON_BODY_LIMITS.note)
  const context = `${body.beforeText}${body.afterText}`
  if (!isAction(body.action) || typeof body.noteId !== 'string' || !body.noteId || typeof body.selectedText !== 'string' || typeof body.beforeText !== 'string' || typeof body.afterText !== 'string' || typeof body.cursorOffset !== 'number' || !Number.isSafeInteger(body.cursorOffset) || typeof body.title !== 'string' || typeof body.language !== 'string' || (body.language !== 'zh-CN' && body.language !== 'en-US') || body.selectedText.length + context.length > 24_000 || (body.action !== 'continue' && !body.selectedText.trim()) || (body.action === 'continue' && !context.trim())) throw ApiError.badRequest('Invalid write request')
  const model = await resolveModel(c.env, c.env.DB, c.get('userId'), 'writing')
  const user = body.selectedText ? `Text:\n${body.selectedText}${context ? `\n\nContext:\n${context}` : ''}` : `Context:\n${context}`
  return stream(c, model, [
    { role: 'system', content: writeSystem(body) },
    { role: 'user', content: user },
  ], 2048, null)
})

async function listProviders(db: D1Database, userId: string): Promise<Response> {
  const { results: providers } = await db.prepare('SELECT id,name FROM ai_providers WHERE user_id = ?1 ORDER BY position,id').bind(userId).all<{ id: string; name: string }>()
  const { results: endpoints } = await db.prepare('SELECT id,provider_id AS providerId,slug,base_url AS baseUrl,protocol,key_ciphertext AS keyCiphertext FROM ai_endpoints WHERE user_id = ?1 ORDER BY position,id').bind(userId).all<{ id: string; providerId: string; slug: string; baseUrl: string; protocol: AiProtocol; keyCiphertext: string | null }>()
  const { results: models } = await db.prepare('SELECT endpoint_id AS endpointId,model_id AS id,model_type AS modelType,type_source AS typeSource,context_window AS contextWindow,can_vision AS canVision FROM ai_models WHERE user_id = ?1 ORDER BY position,id').bind(userId).all<{ endpointId: string; id: string; modelType: AiModelType; typeSource: string; contextWindow: number | null; canVision: number }>()
  return Response.json(providers.map((provider) => ({ id: provider.id, name: provider.name, endpoints: endpoints.filter((endpoint) => endpoint.providerId === provider.id).map((endpoint) => ({ id: endpoint.id, slug: endpoint.slug, baseUrl: normalizeBaseUrl(endpoint.baseUrl) ?? endpoint.baseUrl, protocol: endpoint.protocol, keyMasked: endpoint.keyCiphertext ? '****' : null, probeUrl: `${normalizeBaseUrl(endpoint.baseUrl) ?? endpoint.baseUrl}/models`, models: models.filter((model) => model.endpointId === endpoint.id).map((model) => ({ id: model.id, modelType: model.modelType, typeSource: model.typeSource, contextWindow: model.contextWindow, canVision: Boolean(model.canVision) })) })) })))
}

async function listRoles(db: D1Database, userId: string): Promise<Response> {
  const { results } = await db.prepare('SELECT role,endpoint_id AS endpointId,model_id AS modelId FROM ai_roles WHERE user_id = ?1').bind(userId).all<{ role: Role; endpointId: string; modelId: string }>()
  const chat = results.find((row) => row.role === 'chat')
  return Response.json(ROLES.map((role) => { const row = results.find((candidate) => candidate.role === role) ?? (role === 'writing' ? chat : undefined); return { role, binding: row ? { endpointId: row.endpointId, modelId: row.modelId, label: row.modelId } : null, isFallback: role === 'writing' && !results.some((candidate) => candidate.role === role) && Boolean(chat) } }))
}

async function loadEndpoint(db: D1Database, userId: string, id: string): Promise<{ id: string; baseUrl: string; protocol: AiProtocol; keyCiphertext: string | null }> {
  const row = await db.prepare('SELECT id,base_url AS baseUrl,protocol,key_ciphertext AS keyCiphertext FROM ai_endpoints WHERE id = ?1 AND user_id = ?2').bind(id, userId).first<{ id: string; baseUrl: string; protocol: AiProtocol; keyCiphertext: string | null }>()
  if (!row) throw ApiError.notFound('Endpoint not found')
  row.baseUrl = normalizeBaseUrl(row.baseUrl) ?? row.baseUrl
  return row
}

async function resolveModel(env: Env, db: D1Database, userId: string, role: Role, requested?: { endpointId: string; modelId: string }): Promise<Model> {
  const row = requested
    ? await db.prepare("SELECT e.id AS endpointId,e.base_url AS baseUrl,e.protocol,e.key_ciphertext AS keyCiphertext,m.model_id AS modelId FROM ai_endpoints e JOIN ai_models m ON m.user_id=e.user_id AND m.endpoint_id=e.id WHERE e.user_id=?1 AND e.id=?2 AND m.model_id=?3 AND m.model_type='chat'").bind(userId, requested.endpointId, requested.modelId).first<{ endpointId: string; baseUrl: string; protocol: AiProtocol; keyCiphertext: string | null; modelId: string }>()
    : await db.prepare("SELECT e.id AS endpointId,e.base_url AS baseUrl,e.protocol,e.key_ciphertext AS keyCiphertext,m.model_id AS modelId,r.role FROM ai_roles r JOIN ai_models m ON m.user_id=r.user_id AND m.endpoint_id=r.endpoint_id AND m.model_id=r.model_id JOIN ai_endpoints e ON e.user_id=r.user_id AND e.id=r.endpoint_id WHERE r.user_id=?1 AND r.role IN (?2,'chat') AND m.model_type='chat' ORDER BY CASE WHEN r.role=?2 THEN 0 ELSE 1 END LIMIT 1").bind(userId, role).first<{ endpointId: string; baseUrl: string; protocol: AiProtocol; keyCiphertext: string | null; modelId: string; role: Role }>()
  if (!row) throw ApiError.conflict('No AI model is configured')
  if (!row.keyCiphertext) throw ApiError.conflict('AI API key is not configured')
  const key = await decryptAiKey(env, row.endpointId, row.keyCiphertext)
  if (!key) throw ApiError.conflict('AI API key is unavailable')
  return { endpointId: row.endpointId, baseUrl: normalizeBaseUrl(row.baseUrl) ?? row.baseUrl, protocol: row.protocol, modelId: row.modelId, key, isFallback: 'role' in row && row.role === 'chat' && role === 'writing' }
}

function stream(c: RouteContext, model: Model, messages: Message[], maxTokens: number | undefined, conversationId: string | null): Response {
  const userId = c.get('userId')
  const now = Date.now()
  const budget = requests.get(userId)
  if (budget && now - budget.at < 60_000 && budget.count >= 20) throw new ApiError(429, 'too_many_attempts', 'Too many AI requests')
  requests.set(userId, !budget || now - budget.at >= 60_000 ? { at: now, count: 1 } : { at: budget.at, count: budget.count + 1 })
  const running = active.get(userId) ?? 0
  if (running >= 2) throw new ApiError(429, 'too_many_attempts', 'Too many AI requests')
  active.set(userId, running + 1)
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({ async start(controller) {
    let output = ''
    try {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: 'meta', ...(conversationId ? { conversationId } : {}), model: { endpointId: model.endpointId, modelId: model.modelId }, isFallback: model.isFallback })}\n\n`))
      const upstream = await fetch(`${model.baseUrl}/${model.protocol === 'anthropic-messages' ? 'messages' : model.protocol === 'openai-chat' ? 'chat/completions' : 'responses'}`, { method: 'POST', headers: { ...providerHeaders(model.protocol, model.key), 'content-type': 'application/json' }, body: JSON.stringify(buildBody(model.protocol, model.modelId, messages, maxTokens)), signal: c.req.raw.signal, redirect: 'manual' })
      if (!upstream.ok) { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: 'error', code: upstream.status === 401 || upstream.status === 403 ? 'unauthenticated' : upstream.status === 429 ? 'too_many_attempts' : 'internal', message: 'AI provider request failed' })}\n\n`)); controller.close(); return }
      if (!upstream.body) throw new Error('empty')
      const reader = upstream.body.getReader(); const decoder = new TextDecoder(); let buffer = ''
      while (true) { const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true }); const lines = buffer.split('\n'); buffer = lines.pop() ?? ''; for (const line of lines) { const text = extractDelta(model.protocol, line); if (text) { output += text; controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: 'delta', text })}\n\n`)) } } }
      if (conversationId && output) await c.env.DB.prepare("INSERT INTO ai_messages (id,conversation_id,user_id,role,content,status,model_id,created_at) VALUES (?1,?2,?3,'assistant',?4,'done',?5,?6)").bind(newId(), conversationId, userId, output, model.modelId, Date.now()).run()
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: 'done', inputTokens: null, outputTokens: null })}\n\n`)); controller.close()
    } catch { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify({ kind: 'error', code: 'internal', message: 'AI request failed' })}\n\n`)); controller.close() } catch { /* client disconnected */ } }
    finally { active.set(userId, Math.max(0, (active.get(userId) ?? 1) - 1)) }
  }})
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' } })
}

export function writeSystem(request: AiWriteRequest): string {
  const actions = {
    polish: 'Polish the selected text while preserving its meaning.',
    rewrite: 'Rewrite the selected text clearly while preserving its meaning.',
    shorten: 'Shorten the selected text while preserving its key meaning.',
    expand: 'Expand the selected text with useful detail while preserving its meaning.',
    continue: 'Continue writing naturally from the provided context.',
  }
  return `${actions[request.action]} Return only the resulting text, with no preamble or title. Write in ${request.language === 'zh-CN' ? 'Simplified Chinese' : 'English'}.${request.title ? ` The note is titled ${JSON.stringify(request.title)}.` : ''}`
}

function providerHeaders(protocol: AiProtocol, key: string): Record<string, string> { return protocol === 'anthropic-messages' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${key}` } }
function buildBody(protocol: AiProtocol, model: string, messages: Message[], maxTokens?: number): unknown { const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n'); const turns = messages.filter((message) => message.role !== 'system'); if (protocol === 'anthropic-messages') return { model, max_tokens: maxTokens ?? 4096, stream: true, messages: turns, ...(system ? { system } : {}) }; if (protocol === 'openai-responses') return { model, stream: true, input: turns, ...(system ? { instructions: system } : {}) }; return { model, stream: true, stream_options: { include_usage: true }, messages, ...(maxTokens ? { max_tokens: maxTokens } : {}) } }
export function extractDelta(protocol: AiProtocol, line: string): string | null {
  const data = line.startsWith('data:') ? line.slice(5).trimStart() : line.trim()
  if (!data || data === '[DONE]') return null
  try {
    const value: unknown = JSON.parse(data)
    const object = objectValue(value)
    if (!object) return null
    const delta = protocol === 'anthropic-messages'
      ? objectValue(object.delta)?.text
      : protocol === 'openai-responses'
        ? object.type === 'response.output_text.delta' ? object.delta : null
        : objectValue(objectValue((Array.isArray(object.choices) ? object.choices : [])[0])?.delta)?.content
    return typeof delta === 'string' ? delta : null
  } catch { return null }
}
function modelIds(value: unknown): string[] { const object = objectValue(value); const values = Array.isArray(value) ? value : Array.isArray(object?.data) ? object.data : Array.isArray(object?.models) ? object.models : []; const ids: string[] = []; for (const item of values) { const id = typeof item === 'string' ? item.trim() : stringValue(objectValue(item)?.id, 200); if (id && !ids.includes(id)) ids.push(id) } return ids }
export function normalizeBaseUrl(raw: unknown): string | null { if (typeof raw !== 'string') return null; try { const url = new URL(raw.trim()); if (url.protocol !== 'https:' || url.username || url.password) return null; url.hash = ''; url.search = ''; const path = url.pathname.replace(/\/+/g, '/').replace(/\/$/, ''); url.pathname = path.endsWith('/v1') ? path : `${path}/v1`; return url.toString().replace(/\/$/, '') } catch { return null } }
async function assertSafeUrl(db: D1Database, value: string): Promise<void> { const host = new URL(value).hostname.toLowerCase(); const allow = await db.prepare("SELECT value FROM app_meta WHERE key='setting:ai_allow_private'").first<{ value: string }>(); if (allow?.value === '1') return; if (host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host === '127.0.0.1' || host.startsWith('10.') || host.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.startsWith('169.254.') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) throw ApiError.forbidden('Private AI endpoints are disabled') }
function probeError(status: number) { return { kind: status === 401 || status === 403 ? 'unauthorized' : status === 404 ? 'not_found' : status === 429 ? 'rate_limited' : 'status', status, message: null } }
function objectValue(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null }
function stringValue(value: unknown, max: number): string | null { return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null }
function validId(value: unknown): string | undefined { return isValidId(value) ? value : undefined }
function isProtocol(value: unknown): value is AiProtocol { return typeof value === 'string' && PROTOCOLS.includes(value as AiProtocol) }
function isModelType(value: unknown): value is AiModelType { return typeof value === 'string' && ['chat', 'image', 'video', 'tts', 'stt', 'embedding', 'rerank', 'unknown'].includes(value) }
function isRole(value: unknown): value is Role { return typeof value === 'string' && ROLES.includes(value as Role) }
function isAction(value: unknown): value is AiWriteRequest['action'] { return typeof value === 'string' && ACTIONS.includes(value as AiWriteRequest['action']) }
