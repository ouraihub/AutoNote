import { z } from 'zod'
import type {
  Endpoint,
  ModelFilter,
  ModelOption,
  ModelRef,
  ModelType,
  ProbeError,
  ProbeErrorKind,
  ProbeResult,
  ProbedModel,
  Protocol,
  Provider,
  ReasoningConfig,
} from '@ouraihub/aether-ui/ports'
import type { Env } from '../env'
import { decryptAiKey, encryptAiKey } from '../lib/crypto'
import { newId } from '../lib/id'
import { inferModel, inferReasoning } from './infer'
import {
  addressAllowed,
  apiBase,
  at,
  badRequest,
  cancelled,
  charCount,
  excerpt,
  isLoopback,
  maskSecret,
  needsConfig,
  notFound,
  parseTarget,
  readUpTo,
} from './kit'
import { authHeaders } from './protocol'

const PROTOCOLS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const
const MODEL_TYPES = ['chat', 'image', 'video', 'tts', 'stt', 'embedding', 'rerank', 'unknown'] as const
const EFFORTS = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const DIALECTS = ['openai', 'anthropic-budget', 'anthropic-adaptive'] as const
const tokenLimit = z.number().int().min(0).max(0xffff_ffff).nullable().default(null)
const ReasoningSchema = z.strictObject({
  dialect: z.enum(DIALECTS),
  efforts: z.array(z.enum(EFFORTS)).min(1),
  budgetTokens: z.number().int().min(0).max(0xffff_ffff).nullable().default(null),
}).transform(({ budgetTokens, ...config }) => budgetTokens === null ? config : { ...config, budgetTokens })

const ModelSchema = z.strictObject({
  id: z.string(),
  modelType: z.enum(MODEL_TYPES),
  typeSource: z.enum(['inferred', 'user']),
  contextWindow: tokenLimit,
  maxOutput: tokenLimit,
  canVision: z.boolean(),
  supportsTools: z.boolean().nullable().default(null),
  reasoning: ReasoningSchema.nullable().optional(),
  nativeWebSearch: z.boolean().default(false),
})

export const ProviderSaveSchema = z.strictObject({
  id: z.string().max(64).optional(),
  name: z.string(),
  endpoints: z.array(
    z.strictObject({
      id: z.string().max(64).optional(),
      slug: z.string(),
      baseUrl: z.string(),
      protocol: z.enum(PROTOCOLS),
      apiKey: z.string().optional(),
      models: z.array(ModelSchema),
    }),
  ),
})
export type ProviderSaveInput = z.infer<typeof ProviderSaveSchema>

export const ProbeTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), endpointId: z.string().max(64) }),
  z.strictObject({
    kind: z.literal('draft'),
    baseUrl: z.string().max(2048),
    protocol: z.enum(PROTOCOLS),
    apiKey: z.string().optional(),
    endpointId: z.string().max(64).optional(),
  }),
])
export type ProbeTargetInput = z.infer<typeof ProbeTargetSchema>

export const ModelFilterSchema = z.strictObject({
  modelType: z.enum(MODEL_TYPES).optional(),
  supportsTools: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
})

export function validateReasoning(config: ReasoningConfig, protocol: Protocol, modelType: ModelType, maxOutput: number | null): void {
  if (modelType !== 'chat' || !config.efforts.length || config.efforts.includes('default') || new Set(config.efforts).size !== config.efforts.length)
    throw badRequest('reasoning', 'invalid_efforts')
  if ((config.dialect === 'openai') === (protocol === 'anthropic-messages')) throw badRequest('reasoning', 'protocol_mismatch')
  const budget = config.budgetTokens
  if (config.dialect === 'anthropic-budget') {
    if (budget == null || budget < 1024 || (maxOutput !== null && budget >= maxOutput)) throw badRequest('reasoning', 'invalid_budget')
  } else if (budget != null) throw badRequest('reasoning', 'unexpected_budget')
}

function storedReasoning(raw: string | null): ReasoningConfig | null {
  return raw === null ? null : ReasoningSchema.parse(JSON.parse(raw))
}

export interface Connection {
  baseUrl: string
  protocol: Protocol
  apiKey: string | null
  modelId: string
  endpointId: string
  contextWindow: number | null
  maxOutput: number | null
  supportsTools: boolean | null
  reasoning: ReasoningConfig | null
  nativeWebSearch: boolean
  canVision: boolean
}

interface EndpointRow {
  id: string
  providerId: string
  slug: string
  baseUrl: string
  protocol: Protocol
  keyCiphertext: string | null
}

interface ModelRow {
  endpointId: string
  id: string
  modelType: ModelType
  typeSource: 'inferred' | 'user'
  contextWindow: number | null
  maxOutput: number | null
  canVision: number
  supportsTools: number | null
  reasoning: string | null
  nativeWebSearch: number
}

const flag = (value: number | null): boolean | null => (value === null ? null : value !== 0)

async function openKey(env: Env, endpointId: string, ciphertext: string | null): Promise<string | null> {
  if (!ciphertext) return null
  const key = await decryptAiKey(env, endpointId, ciphertext).catch(() => null)
  if (key === null) throw needsConfig('key_unreadable')
  return key
}

export async function listProviders(env: Env, userId: string): Promise<Provider[]> {
  const db = env.DB
  const [{ results: providers }, { results: endpoints }, { results: models }] = await Promise.all([
    db.prepare('SELECT id, name FROM ai_providers WHERE user_id = ?1 ORDER BY position, id').bind(userId).all<{ id: string; name: string }>(),
    db
      .prepare(
        'SELECT id, provider_id AS providerId, slug, base_url AS baseUrl, protocol, key_ciphertext AS keyCiphertext FROM ai_endpoints WHERE user_id = ?1 ORDER BY position, id',
      )
      .bind(userId)
      .all<EndpointRow>(),
    db
      .prepare(
        'SELECT endpoint_id AS endpointId, model_id AS id, model_type AS modelType, type_source AS typeSource, context_window AS contextWindow, max_output AS maxOutput, can_vision AS canVision, supports_tools AS supportsTools, reasoning, native_web_search AS nativeWebSearch FROM ai_models WHERE user_id = ?1 ORDER BY position',
      )
      .bind(userId)
      .all<ModelRow>(),
  ])
  const shown = await Promise.all(
    endpoints.map(async (row): Promise<[string, Endpoint]> => {
      const plain = row.keyCiphertext ? await decryptAiKey(env, row.id, row.keyCiphertext).catch(() => null) : null
      return [
        row.providerId,
        {
          id: row.id,
          slug: row.slug,
          baseUrl: row.baseUrl,
          protocol: row.protocol,
          hasKey: row.keyCiphertext !== null,
          keyMasked: plain === null ? null : maskSecret(plain),
          keyReadable: row.keyCiphertext === null || plain !== null,
          probeUrl: `${apiBase(row.baseUrl)}/models`,
          models: models
            .filter((model) => model.endpointId === row.id)
            .map((model) => ({
              id: model.id,
              modelType: model.modelType,
              typeSource: model.typeSource,
              contextWindow: model.contextWindow,
              maxOutput: model.maxOutput,
              canVision: model.canVision !== 0,
              supportsTools: flag(model.supportsTools),
              reasoning: storedReasoning(model.reasoning) ?? (model.modelType === 'chat' ? inferReasoning(model.id, row.protocol, model.maxOutput) : null),
              nativeWebSearch: model.nativeWebSearch !== 0,
            })),
        },
      ]
    }),
  )
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    endpoints: shown.filter(([providerId]) => providerId === provider.id).map(([, endpoint]) => endpoint),
  }))
}

function validateSave(input: ProviderSaveInput): void {
  const name = charCount(input.name.trim())
  if (name === 0 || name > 80) throw badRequest('name', 'out_of_range', 80)
  if (input.endpoints.length > 20) throw badRequest('endpoints', 'out_of_range', 20)
  const slugs = new Set<string>()
  const ids = new Set<string>()
  for (const endpoint of input.endpoints) {
    if (!/^[a-z0-9-]{1,40}$/.test(endpoint.slug)) throw badRequest('slug', 'invalid_slug')
    if (slugs.has(endpoint.slug)) throw badRequest('slug', 'duplicate')
    slugs.add(endpoint.slug)
    if (endpoint.id !== undefined) {
      if (ids.has(endpoint.id)) throw badRequest('id', 'duplicate')
      ids.add(endpoint.id)
    }
    const url = endpoint.baseUrl.trim()
    if (new TextEncoder().encode(url).length > 2048) throw badRequest('baseUrl', 'out_of_range', 2048)
    if (!url.startsWith('http://') && !url.startsWith('https://')) throw badRequest('baseUrl', 'invalid_url')
    if (endpoint.apiKey !== undefined && endpoint.apiKey.length > 4096) throw badRequest('apiKey', 'too_long', 4096)
    if (endpoint.models.length > 1000) throw badRequest('models', 'out_of_range', 1000)
    const models = new Set<string>()
    for (const model of endpoint.models) {
      if (!model.id) throw badRequest('models', 'empty_id')
      if (models.has(model.id)) throw badRequest('models', 'duplicate')
      models.add(model.id)
      if (model.reasoning) validateReasoning(model.reasoning, endpoint.protocol, model.modelType, model.maxOutput)
      if (model.nativeWebSearch && (model.modelType !== 'chat' || endpoint.protocol === 'openai-chat')) throw badRequest('nativeWebSearch', 'unsupported_protocol')
    }
  }
}

export async function saveProvider(env: Env, userId: string, input: ProviderSaveInput): Promise<Provider[]> {
  validateSave(input)
  const db = env.DB
  if (input.id !== undefined) {
    const existing = await db.prepare('SELECT 1 FROM ai_providers WHERE id = ?1 AND user_id = ?2').bind(input.id, userId).first()
    if (!existing) throw notFound('provider')
  }
  const providerId = input.id ?? newId()
  const { results: old } = await db
    .prepare('SELECT id, key_ciphertext AS keyCiphertext FROM ai_endpoints WHERE provider_id = ?1 AND user_id = ?2')
    .bind(providerId, userId)
    .all<{ id: string; keyCiphertext: string | null }>()
  const oldKeys = new Map(old.map((row) => [row.id, row.keyCiphertext]))
  const { results: priorModels } = await db.prepare('SELECT endpoint_id AS endpointId, model_id AS modelId, reasoning FROM ai_models WHERE user_id = ?1 AND endpoint_id IN (SELECT id FROM ai_endpoints WHERE provider_id = ?2 AND user_id = ?1)').bind(userId, providerId).all<{ endpointId: string; modelId: string; reasoning: string | null }>()
  const priorReasoning = new Map(priorModels.map((model) => [`${model.endpointId}\n${model.modelId}`, storedReasoning(model.reasoning)]))
  if (input.endpoints.some((endpoint) => endpoint.id !== undefined && !oldKeys.has(endpoint.id))) throw notFound('endpoint')
  const kept = new Set(input.endpoints.flatMap((endpoint) => (endpoint.id === undefined ? [] : [endpoint.id])))

  const planned = await Promise.all(
    input.endpoints.map(async (endpoint) => {
      const id = endpoint.id ?? newId()
      const previous = endpoint.id === undefined ? null : (oldKeys.get(endpoint.id) ?? null)
      const key =
        endpoint.apiKey === undefined ? previous : endpoint.apiKey === '' ? null : await encryptAiKey(env, id, endpoint.apiKey)
      const models = endpoint.models.map((model) => ({ ...model, reasoning: model.reasoning === undefined ? priorReasoning.get(`${id}\n${model.id}`) ?? null : model.reasoning }))
      for (const model of models) if (model.reasoning) validateReasoning(model.reasoning, endpoint.protocol, model.modelType, model.maxOutput)
      return { endpoint, id, key, models }
    }),
  )

  const now = Date.now()
  const statements: D1PreparedStatement[] = [
    input.id === undefined
      ? db
          .prepare(
            'INSERT INTO ai_providers (id, user_id, name, position, created_at, updated_at) VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position) + 1, 0) FROM ai_providers WHERE user_id = ?2), ?4, ?4)',
          )
          .bind(providerId, userId, input.name, now)
      : db.prepare('UPDATE ai_providers SET name = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4').bind(input.name, now, providerId, userId),
    db
      .prepare('DELETE FROM ai_models WHERE user_id = ?1 AND endpoint_id IN (SELECT id FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2)')
      .bind(userId, providerId),
  ]
  for (const id of oldKeys.keys()) {
    if (!kept.has(id)) statements.push(db.prepare('DELETE FROM ai_endpoints WHERE id = ?1 AND user_id = ?2').bind(id, userId))
  }
  statements.push(db.prepare('UPDATE ai_endpoints SET slug = id WHERE provider_id = ?1 AND user_id = ?2').bind(providerId, userId))
  planned.forEach(({ endpoint, id, key, models }, position) => {
    const values = [endpoint.slug, endpoint.baseUrl.trim(), endpoint.protocol, key, position, id, userId] as const
    statements.push(
      endpoint.id === undefined
        ? db
            .prepare(
              'INSERT INTO ai_endpoints (slug, base_url, protocol, key_ciphertext, position, id, user_id, provider_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
            )
            .bind(...values, providerId)
        : db
            .prepare('UPDATE ai_endpoints SET slug = ?1, base_url = ?2, protocol = ?3, key_ciphertext = ?4, position = ?5 WHERE id = ?6 AND user_id = ?7')
            .bind(...values),
      db
        .prepare(
          `INSERT INTO ai_models (user_id, endpoint_id, model_id, model_type, type_source, context_window, max_output, can_vision, supports_tools, reasoning, native_web_search, position)
           SELECT ?1, ?2, json_extract(value, '$.id'), json_extract(value, '$.modelType'), json_extract(value, '$.typeSource'),
             json_extract(value, '$.contextWindow'), json_extract(value, '$.maxOutput'), json_extract(value, '$.canVision'),
             json_extract(value, '$.supportsTools'), CASE WHEN json_type(value, '$.reasoning') = 'object' THEN json_extract(value, '$.reasoning') ELSE NULL END, json_extract(value, '$.nativeWebSearch'), key FROM json_each(?3)`,
        )
        .bind(userId, id, JSON.stringify(models)),
    )
  })
  statements.push(
    db
      .prepare(
        'DELETE FROM ai_roles WHERE user_id = ?1 AND NOT EXISTS (SELECT 1 FROM ai_models m WHERE m.user_id = ?1 AND m.endpoint_id = ai_roles.endpoint_id AND m.model_id = ai_roles.model_id)',
      )
      .bind(userId),
  )
  await db.batch(statements)
  return listProviders(env, userId)
}

export async function removeProvider(env: Env, userId: string, id: string): Promise<Provider[]> {
  const db = env.DB
  const existing = await db.prepare('SELECT 1 FROM ai_providers WHERE id = ?1 AND user_id = ?2').bind(id, userId).first()
  if (!existing) throw notFound('provider')
  const endpoints = 'SELECT id FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2'
  await db.batch([
    db.prepare(`DELETE FROM ai_roles WHERE user_id = ?1 AND endpoint_id IN (${endpoints})`).bind(userId, id),
    db.prepare(`DELETE FROM ai_models WHERE user_id = ?1 AND endpoint_id IN (${endpoints})`).bind(userId, id),
    db.prepare('DELETE FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2').bind(userId, id),
    db.prepare('DELETE FROM ai_providers WHERE id = ?1 AND user_id = ?2').bind(id, userId),
  ])
  return listProviders(env, userId)
}

export async function modelOptions(db: D1Database, userId: string, filter: ModelFilter): Promise<ModelOption[]> {
  const { results } = await db
    .prepare(
      `SELECT p.name AS provider, e.slug, e.protocol, m.endpoint_id AS endpointId, m.model_id AS modelId, m.model_type AS modelType, m.supports_tools AS supportsTools, m.context_window AS contextWindow, m.max_output AS maxOutput, m.reasoning, m.native_web_search AS nativeWebSearch, m.can_vision AS canVision
       FROM ai_models m
       JOIN ai_endpoints e ON e.id = m.endpoint_id AND e.user_id = m.user_id
       JOIN ai_providers p ON p.id = e.provider_id AND p.user_id = m.user_id
       WHERE m.user_id = ?1
       ORDER BY p.position, p.id, e.position, m.position`,
    )
    .bind(userId)
    .all<{ provider: string; slug: string; protocol: Protocol; endpointId: string; modelId: string; modelType: ModelType; supportsTools: number | null; contextWindow: number | null; maxOutput: number | null; reasoning: string | null; nativeWebSearch: number; canVision: number }>()
  return results
    .filter(
      (row) =>
        (filter.modelType === undefined || row.modelType === filter.modelType) &&
        (filter.supportsTools === undefined || flag(row.supportsTools) === filter.supportsTools),
    )
    .map((row) => ({
      endpointId: row.endpointId,
      modelId: row.modelId,
      label: `${row.provider} · ${row.slug} · ${row.modelId}`,
      modelType: row.modelType,
      supportsTools: flag(row.supportsTools),
      contextWindow: row.contextWindow,
      reasoning: storedReasoning(row.reasoning) ?? (row.modelType === 'chat' ? inferReasoning(row.modelId, row.protocol, row.maxOutput) : null),
      nativeWebSearch: row.nativeWebSearch !== 0,
      canVision: row.canVision !== 0,
    }))
}

export async function resolveModel(env: Env, userId: string, model: ModelRef): Promise<Connection> {
  const row = await env.DB.prepare(
    `SELECT e.id AS endpointId, e.base_url AS baseUrl, e.protocol, e.key_ciphertext AS keyCiphertext,
       m.model_type AS modelType, m.context_window AS contextWindow, m.max_output AS maxOutput, m.supports_tools AS supportsTools, m.reasoning, m.native_web_search AS nativeWebSearch, m.can_vision AS canVision
     FROM ai_models m JOIN ai_endpoints e ON e.id = m.endpoint_id AND e.user_id = m.user_id
     WHERE m.user_id = ?1 AND m.endpoint_id = ?2 AND m.model_id = ?3`,
  )
    .bind(userId, model.endpointId, model.modelId)
    .first<{
      endpointId: string
      baseUrl: string
      protocol: Protocol
      keyCiphertext: string | null
      modelType: ModelType
      contextWindow: number | null
      maxOutput: number | null
      supportsTools: number | null
      reasoning: string | null
      nativeWebSearch: number
      canVision: number
    }>()
  if (!row) throw notFound('model')
  return {
    baseUrl: apiBase(row.baseUrl),
    protocol: row.protocol,
    apiKey: await openKey(env, row.endpointId, row.keyCiphertext),
    modelId: model.modelId,
    endpointId: row.endpointId,
    reasoning: storedReasoning(row.reasoning) ?? (row.modelType === 'chat' ? inferReasoning(model.modelId, row.protocol, row.maxOutput) : null),
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    supportsTools: flag(row.supportsTools),
    nativeWebSearch: row.nativeWebSearch !== 0,
    canVision: row.canVision !== 0,
  }
}

async function storedEndpoint(env: Env, userId: string, id: string): Promise<{ baseUrl: string; protocol: Protocol; key: string | null }> {
  const row = await env.DB.prepare('SELECT base_url AS baseUrl, protocol, key_ciphertext AS keyCiphertext FROM ai_endpoints WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<{ baseUrl: string; protocol: Protocol; keyCiphertext: string | null }>()
  if (!row) throw notFound('endpoint')
  return { baseUrl: row.baseUrl, protocol: row.protocol, key: await openKey(env, id, row.keyCiphertext) }
}

const PROBE_TIMEOUT_MS = 20_000
const PROBE_MAX_BODY = 4 * 1024 * 1024

const failure = (kind: ProbeErrorKind, hint: string | null = null): ProbeError => ({ kind, status: null, message: null, hint })

export async function probe(env: Env, userId: string, target: ProbeTargetInput, signal: AbortSignal): Promise<ProbeResult> {
  let baseUrl: string
  let protocol: Protocol
  let key: string | null
  if (target.kind === 'saved') {
    ;({ baseUrl, protocol, key } = await storedEndpoint(env, userId, target.endpointId))
  } else {
    baseUrl = target.baseUrl
    protocol = target.protocol
    key = target.apiKey
      ? target.apiKey
      : target.apiKey === undefined && target.endpointId !== undefined
        ? (await storedEndpoint(env, userId, target.endpointId)).key
        : null
  }
  const probeUrl = `${apiBase(baseUrl)}/models`
  const done = (models: ProbedModel[], error: ProbeError | null): ProbeResult => ({ probeUrl, models, error })
  const url = parseTarget(probeUrl)
  if (!(await addressAllowed(env.DB, url))) return done([], failure('blocked_address'))
  if (!key && !isLoopback(url)) return done([], failure('missing_key'))
  const ipHost = /^\[.*\]$|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const transport = (): ProbeResult => {
    if (signal.aborted) throw cancelled()
    return done([], timeout.aborted ? failure('timeout') : failure('connect', ipHost ? 'providers.hint.check_network' : null))
  }
  let response: Response
  try {
    response = await fetch(url, { headers: authHeaders(protocol, key), redirect: 'manual', signal: AbortSignal.any([signal, timeout]) })
  } catch {
    return transport()
  }
  const declared = Number(response.headers.get('content-length') ?? '0')
  let body: { bytes: Uint8Array; overflow: boolean } | null
  try {
    body = declared > PROBE_MAX_BODY ? null : await readUpTo(response.body, PROBE_MAX_BODY)
  } catch {
    if (!response.ok) body = null
    else return transport()
  }
  if (body?.overflow) body = null
  if (!response.ok) {
    const status = response.status
    const message = body ? excerpt(new TextDecoder().decode(body.bytes), key ? [key] : []) || null : null
    const [kind, hint]: [ProbeErrorKind, string | null] =
      status === 401 || status === 403
        ? ['unauthorized', 'providers.hint.check_key']
        : status === 404
          ? ['not_found', baseUrl.includes('/v1') ? null : 'providers.hint.missing_v1']
          : status === 429
            ? ['rate_limited', null]
            : ['status', null]
    return done([], { kind, status, message, hint })
  }
  const ids = body ? modelIds(new TextDecoder().decode(body.bytes)) : null
  if (!ids?.length) return done([], failure('invalid_body'))
  return done(
    ids.map((id) => {
      const inferred = inferModel(id)
      return {
        group: inferred.group,
        id,
        modelType: inferred.modelType,
        typeSource: 'inferred',
        contextWindow: inferred.contextWindow,
        maxOutput: inferred.maxOutput,
        canVision: inferred.canVision,
        supportsTools: inferred.supportsTools,
        reasoning: inferred.modelType === 'chat' ? inferReasoning(id, protocol, inferred.maxOutput) : null,
        nativeWebSearch: false,
      }
    }),
    null,
  )
}

function modelIds(text: string): string[] | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const items = Array.isArray(value) ? value : (at(value, 'data') ?? at(value, 'models'))
  if (!Array.isArray(items)) return null
  const ids: string[] = []
  for (const item of items) {
    const id = typeof item === 'string' ? item : (at(item, 'id') ?? at(item, 'name'))
    if (typeof id !== 'string') return null
    ids.push(id)
  }
  return [...new Set(ids)].sort()
}
