import { z } from 'zod'
import type {
  Endpoint,
  ModelFilter,
  ModelOption,
  ModelRef,
  ModelPricing,
  ModelType,
  ProbeError,
  ProbeErrorKind,
  ProbeResult,
  ProbedModel,
  Protocol,
  Provider,
  ReasoningConfig,
  KeyStrategy,
} from '@ouraihub/aether-ui/ports'
import type { Env } from '../env'
import { decryptAiKey, encryptAiKey } from '../lib/crypto'
import { newId } from '../lib/id'
import { requireCurrentPassword } from '../lib/reauth'
import { inferModel, inferReasoning } from './infer'
import {
  KitFailure,
  addressAllowed,
  apiBase,
  at,
  badRequest,
  cancelled,
  conflict,
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
const EFFORTS = ['default', 'none', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const DIALECTS = ['openai', 'anthropic-budget', 'anthropic-adaptive', 'thinking-type', 'qwen'] as const
const tokenLimit = z.number().int().min(0).max(0xffff_ffff).nullable().default(null)
const ReasoningSchema = z
  .strictObject({
    dialect: z.enum(DIALECTS),
    efforts: z.array(z.enum(EFFORTS)).min(1),
    budgetTokens: z.number().int().min(0).max(0xffff_ffff).nullable().default(null),
  })
  .transform(({ budgetTokens, ...config }) => (budgetTokens === null ? config : { ...config, budgetTokens }))

const PricingSchema = z.strictObject({
  currency: z.enum(['USD', 'CNY']),
  tiers: z.array(
    z.strictObject({
      minInputTokens: z.number(),
      input: z.number(),
      output: z.number(),
      cacheRead: z.number().nullable().default(null),
      cacheWrite: z.number().nullable().default(null),
    }),
  ),
})

const ModelSchema = z.strictObject({
  id: z.string(),
  name: z.string().nullable().default(null),
  groupName: z.string().nullable().default(null),
  modelType: z.enum(MODEL_TYPES),
  typeSource: z.enum(['inferred', 'user']),
  contextWindow: tokenLimit,
  maxOutput: tokenLimit,
  canVision: z.boolean(),
  supportsTools: z.boolean().nullable().default(null),
  reasoning: ReasoningSchema.nullable().optional(),
  nativeWebSearch: z.boolean().default(false),
  pricing: PricingSchema.nullable().default(null),
})

export const ProviderSaveSchema = z.strictObject({
  id: z.string().max(64).optional(),
  name: z.string(),
  enabled: z.boolean().optional(),
  notes: z.string().optional(),
  presetId: z.string().min(1).max(64).optional(),
  endpoints: z.array(
    z.strictObject({
      id: z.string().max(64).optional(),
      slug: z.string(),
      baseUrl: z.string(),
      protocol: z.enum(PROTOCOLS),
      imageBaseUrl: z.string().nullable().optional(),
      imageEditBaseUrl: z.string().nullable().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      keyStrategy: z.enum(['round_robin', 'fill_first']).optional(),
      models: z.array(ModelSchema),
    }),
  ),
})
export type ProviderSaveInput = z.infer<typeof ProviderSaveSchema>

export const EndpointKeySaveSchema = z.strictObject({
  endpointId: z.string().max(64),
  id: z.string().max(64).optional(),
  key: z.string().optional(),
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  restore: z.boolean().optional(),
})
export type EndpointKeySaveInput = z.infer<typeof EndpointKeySaveSchema>
const MAX_KEYS = 16

export const ProbeTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('saved'), endpointId: z.string().max(64) }),
  z.strictObject({
    kind: z.literal('draft'),
    baseUrl: z.string().max(2048),
    protocol: z.enum(PROTOCOLS),
    endpointId: z.string().max(64).optional(),
    keyId: z.string().max(64).optional(),
  }),
])
export type ProbeTargetInput = z.infer<typeof ProbeTargetSchema>

export const ModelFilterSchema = z.strictObject({
  modelType: z.enum(MODEL_TYPES).optional(),
  supportsTools: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
})

export function validateReasoning(
  config: ReasoningConfig,
  protocol: Protocol,
  modelType: ModelType,
  maxOutput: number | null,
): void {
  const switchStyle = config.dialect === 'thinking-type' || config.dialect === 'qwen'
  if (
    modelType !== 'chat' ||
    !config.efforts.length ||
    config.efforts.includes('default') ||
    (config.efforts.includes('auto') && !switchStyle) ||
    new Set(config.efforts).size !== config.efforts.length
  )
    throw badRequest('reasoning', 'invalid_efforts')
  const fits = config.dialect === 'anthropic-budget' || config.dialect === 'anthropic-adaptive'
    ? protocol === 'anthropic-messages'
    : config.dialect === 'openai' ? protocol !== 'anthropic-messages' : protocol === 'openai-chat'
  if (!fits) throw badRequest('reasoning', 'protocol_mismatch')
  const budget = config.budgetTokens
  if (config.dialect === 'anthropic-budget') {
    if (budget == null || budget < 1024 || budget >= (maxOutput ?? 4096))
      throw badRequest('reasoning', 'invalid_budget')
  } else if (config.dialect === 'qwen') {
    if (budget === 0) throw badRequest('reasoning', 'invalid_budget')
  } else if (budget != null) throw badRequest('reasoning', 'unexpected_budget')
}

function readReasoning(
  raw: string | null,
  modelId: string,
  modelType: ModelType,
  protocol: Protocol,
  baseUrl: string,
  maxOutput: number | null,
): ReasoningConfig | null {
  if (raw === 'none') return null
  if (raw !== null) return ReasoningSchema.parse(JSON.parse(raw))
  return modelType === 'chat' ? inferReasoning(modelId, protocol, baseUrl, maxOutput) : null
}

const label80 = (field: string, raw: string | null): string | null => {
  const value = raw?.trim() || null
  if (value !== null && charCount(value) > 80) throw badRequest(field, 'too_long', 80)
  return value
}

function validatePricing(pricing: ModelPricing | null, modelType: ModelType): void {
  if (pricing === null) return
  const { tiers } = pricing
  const price = (value: number | null) => value === null || (Number.isFinite(value) && value >= 0 && value <= 1e6)
  if (
    modelType !== 'chat' ||
    !tiers.length ||
    tiers.length > 8 ||
    tiers[0]!.minInputTokens !== 0 ||
    tiers.some(
      (tier, index) =>
        !Number.isSafeInteger(tier.minInputTokens) ||
        (index > 0 && tier.minInputTokens <= tiers[index - 1]!.minInputTokens) ||
        ![tier.input, tier.output, tier.cacheRead, tier.cacheWrite].every(price),
    )
  )
    throw badRequest('pricing', 'invalid')
}

function validateModel(model: z.infer<typeof ModelSchema>, protocol: Protocol): void {
  label80('name', model.name)
  label80('groupName', model.groupName)
  if (model.contextWindow !== null && model.contextWindow < 1) throw badRequest('contextWindow', 'invalid')
  if (model.maxOutput !== null && model.maxOutput < 1) throw badRequest('maxOutput', 'invalid')
  if (
    model.modelType === 'chat' &&
    model.contextWindow !== null &&
    model.maxOutput !== null &&
    model.maxOutput >= model.contextWindow
  )
    throw badRequest('maxOutput', 'exceeds_context')
  validatePricing(model.pricing, model.modelType)
  if (model.nativeWebSearch && (model.modelType !== 'chat' || protocol === 'openai-chat'))
    throw badRequest('nativeWebSearch', 'unsupported_protocol')
}

export interface Connection {
  baseUrl: string
  imageBaseUrl: string | null
  imageEditBaseUrl: string | null
  headers: Record<string, string>
  protocol: Protocol
  // Enabled keys in order for this request; empty = no key.
  apiKeys: string[]
  // Fill-first only: skips `key` until `until` (docs/43 §3.1) in D1 and for the rest of this request.
  setAside: ((key: string, until: number, reason: string) => Promise<void>) | null
  modelId: string
  endpointId: string
  contextWindow: number | null
  maxOutput: number | null
  supportsTools: boolean | null
  reasoning: ReasoningConfig | null
  nativeWebSearch: boolean
  canVision: boolean
  pricing: ModelPricing | null
}

interface EndpointRow {
  id: string
  providerId: string
  slug: string
  baseUrl: string
  protocol: Protocol
  imageBaseUrl: string | null
  imageEditBaseUrl: string | null
  headers: string
  keyStrategy: KeyStrategy
}

interface KeyRow {
  id: string
  endpointId: string
  label: string
  enabled: number
  keyCiphertext: string
  exhaustedUntil: number | null
  exhaustedReason: string | null
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
  name: string | null
  groupName: string | null
  pricing: string | null
}

const flag = (value: number | null): boolean | null => (value === null ? null : value !== 0)

const KEY_COLUMNS =
  'id, endpoint_id AS endpointId, label, enabled, key_ciphertext AS keyCiphertext, exhausted_until AS exhaustedUntil, exhausted_reason AS exhaustedReason'
const plainKey = (env: Env, row: { id: string; keyCiphertext: string }): Promise<string | null> =>
  decryptAiKey(env, row.id, row.keyCiphertext).catch(() => null)

async function openKey(env: Env, row: { id: string; keyCiphertext: string }): Promise<string> {
  const key = await plainKey(env, row)
  if (key === null) throw needsConfig('key_unreadable')
  return key
}

async function endpointKeys(db: D1Database, userId: string, endpointId: string): Promise<KeyRow[]> {
  return (
    await db
      .prepare(`SELECT ${KEY_COLUMNS} FROM ai_endpoint_keys WHERE user_id = ?1 AND endpoint_id = ?2 ORDER BY position, id`)
      .bind(userId, endpointId)
      .all<KeyRow>()
  ).results
}

// ponytail: per-isolate cursor (docs/34 §3.4); restarts from the first key on a cold isolate.
const rotations = new WeakMap<D1Database, Map<string, number>>()

/** Enabled keys of an endpoint, decrypted, starting one step further on every call. */
async function rotatedKeys(env: Env, userId: string, endpointId: string): Promise<string[]> {
  const rows = (await endpointKeys(env.DB, userId, endpointId)).filter((row) => row.enabled !== 0)
  const keys = await Promise.all(rows.map((row) => openKey(env, row)))
  if (!keys.length) return []
  let counters = rotations.get(env.DB)
  if (!counters) {
    counters = new Map()
    rotations.set(env.DB, counters)
  }
  const scope = JSON.stringify([userId, endpointId])
  const start = (counters.get(scope) ?? 0) % keys.length
  counters.set(scope, (start + 1) % keys.length)
  return [...keys.slice(start), ...keys.slice(0, start)]
}

const DAY_MS = 86_400_000
const COOLDOWN_MS = 60_000

/** Keys for one request by the endpoint's strategy (docs/43 §3); `name` labels the all-used-up error. */
export async function requestKeys(
  env: Env,
  userId: string,
  endpointId: string,
  strategy: KeyStrategy,
  name: string,
  // The painting line is resolved up front for a chat run: an all-paused painting line must fail the tool call, not the chat.
  deferExhausted = false,
): Promise<Pick<Connection, 'apiKeys' | 'setAside'>> {
  if (strategy === 'round_robin') return { apiKeys: await rotatedKeys(env, userId, endpointId), setAside: null }
  const rows = (await endpointKeys(env.DB, userId, endpointId)).filter((row) => row.enabled !== 0)
  const now = Date.now()
  const usable = rows.filter((row) => row.exhaustedUntil === null || row.exhaustedUntil <= now)
  if (rows.length && !usable.length) {
    const resumeAt = Math.min(...rows.map((row) => row.exhaustedUntil ?? now))
    const failure = new KitFailure('rate_limited', `线路 ${name} 的密钥全部用完，最早 ${new Date(resumeAt).toISOString()} 恢复`, { reason: 'keys_exhausted' })
    failure.resumeAt = resumeAt
    if (!deferExhausted) throw failure
    return { apiKeys: [], setAside: async () => { throw failure } }
  }
  const apiKeys = await Promise.all(usable.map((row) => openKey(env, row)))
  if (!apiKeys.length) return { apiKeys, setAside: null }
  const ids = usable.map((row) => row.id)
  return {
    apiKeys,
    setAside: async (key, until, reason) => {
      const index = apiKeys.indexOf(key)
      await env.DB.prepare('UPDATE ai_endpoint_keys SET exhausted_until = ?1, exhausted_reason = ?2 WHERE id = ?3 AND user_id = ?4')
        .bind(until, reason, ids[index]!, userId)
        .run()
      // Later tool rounds of the same run reuse this pool.
      apiKeys.splice(index, 1)
      ids.splice(index, 1)
    },
  }
}

const FAILOVER_STATUS = [401, 403, 429]

/**
 * Calls `attempt` with each key in order (once with `null` when there is none). Rotation moves on only when the
 * upstream rejects the key; fill-first also sets used-up or rate-limited keys aside and retries a network failure once.
 */
export async function withKeys<T>(
  pool: Pick<Connection, 'apiKeys' | 'setAside'>,
  attempt: (key: string | null) => Promise<T>,
): Promise<T> {
  // A fill-first pool emptied by earlier rounds of this run must not fall back to a keyless request.
  if (pool.setAside && !pool.apiKeys.length) throw new KitFailure('rate_limited', 'every key of this line is set aside', { reason: 'keys_exhausted' })
  const candidates = pool.apiKeys.length ? [...pool.apiKeys] : [null]
  let retried = false
  for (let index = 0; ; index++) {
    try {
      return await attempt(candidates[index] ?? null)
    } catch (error) {
      if (!(error instanceof KitFailure)) throw error
      const next = index + 1 < candidates.length
      const status = Number(error.details.status)
      if (!pool.setAside) {
        if (next && FAILOVER_STATUS.includes(status)) continue
        throw error
      }
      if (error.code === 'network' || error.code === 'timeout') {
        if (next && !retried) {
          retried = true
          continue
        }
        throw error
      }
      const facts = error.upstream
      const limited = status === 429 && facts?.usedUp === false
      if (!facts || (!limited && !facts.usedUp)) throw error
      await pool.setAside(candidates[index]!, Date.now() + (limited ? (facts.retryAfterMs ?? COOLDOWN_MS) : DAY_MS), facts.reason)
      if (!next) throw error
    }
  }
}

async function ownedEndpoint(
  db: D1Database,
  userId: string,
  id: string,
): Promise<{ baseUrl: string; protocol: Protocol; headers: Record<string, string> }> {
  const row = await db
    .prepare('SELECT base_url AS baseUrl, protocol, headers FROM ai_endpoints WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<{ baseUrl: string; protocol: Protocol; headers: string }>()
  if (!row) throw notFound('endpoint')
  return { ...row, headers: JSON.parse(row.headers) as Record<string, string> }
}

export async function listProviders(env: Env, userId: string): Promise<Provider[]> {
  const db = env.DB
  const [{ results: providers }, { results: endpoints }, { results: models }, { results: keys }] = await Promise.all([
    db
      .prepare('SELECT id, name, enabled, notes, preset_id AS presetId FROM ai_providers WHERE user_id = ?1 ORDER BY position, id')
      .bind(userId)
      .all<{ id: string; name: string; enabled: number; notes: string; presetId: string | null }>(),
    db
      .prepare(
        'SELECT id, provider_id AS providerId, slug, base_url AS baseUrl, protocol, image_base_url AS imageBaseUrl, image_edit_base_url AS imageEditBaseUrl, headers, key_strategy AS keyStrategy FROM ai_endpoints WHERE user_id = ?1 ORDER BY position, id',
      )
      .bind(userId)
      .all<EndpointRow>(),
    db
      .prepare(
        'SELECT endpoint_id AS endpointId, model_id AS id, model_type AS modelType, type_source AS typeSource, context_window AS contextWindow, max_output AS maxOutput, can_vision AS canVision, supports_tools AS supportsTools, reasoning, native_web_search AS nativeWebSearch, name, group_name AS groupName, pricing FROM ai_models WHERE user_id = ?1 ORDER BY position',
      )
      .bind(userId)
      .all<ModelRow>(),
    db
      .prepare(`SELECT ${KEY_COLUMNS} FROM ai_endpoint_keys WHERE user_id = ?1 ORDER BY position, id`)
      .bind(userId)
      .all<KeyRow>(),
  ])
  const shown = await Promise.all(
    endpoints.map(async (row): Promise<[string, Endpoint]> => {
      const shownKeys = await Promise.all(
        keys
          .filter((key) => key.endpointId === row.id)
          .map(async (key) => {
            const plain = await plainKey(env, key)
            // Set-aside marks only matter, and are only shown, under fill-first.
            const fill = row.keyStrategy === 'fill_first'
            return {
              id: key.id,
              label: key.label,
              enabled: key.enabled !== 0,
              masked: plain === null ? null : maskSecret(plain),
              readable: plain !== null,
              exhaustedUntil: fill ? key.exhaustedUntil : null,
              exhaustedReason: fill ? key.exhaustedReason : null,
            }
          }),
      )
      return [
        row.providerId,
        {
          id: row.id,
          slug: row.slug,
          baseUrl: row.baseUrl,
          protocol: row.protocol,
          imageBaseUrl: row.imageBaseUrl,
          imageEditBaseUrl: row.imageEditBaseUrl,
          headers: JSON.parse(row.headers) as Record<string, string>,
          keyStrategy: row.keyStrategy,
          keys: shownKeys,
          probeUrl: `${apiBase(row.baseUrl)}/models`,
          models: models
            .filter((model) => model.endpointId === row.id)
            .map((model) => ({
              id: model.id,
              name: model.name,
              groupName: model.groupName,
              modelType: model.modelType,
              typeSource: model.typeSource,
              contextWindow: model.contextWindow,
              maxOutput: model.maxOutput,
              canVision: model.canVision !== 0,
              supportsTools: flag(model.supportsTools),
              reasoning: readReasoning(model.reasoning, model.id, model.modelType, row.protocol, row.baseUrl, model.maxOutput),
              nativeWebSearch: model.nativeWebSearch !== 0,
              pricing: model.pricing === null ? null : (JSON.parse(model.pricing) as ModelPricing),
            })),
        },
      ]
    }),
  )
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name,
    enabled: provider.enabled !== 0,
    notes: provider.notes,
    presetId: provider.presetId,
    endpoints: shown.filter(([providerId]) => providerId === provider.id).map(([, endpoint]) => endpoint),
  }))
}

const RESERVED_HEADERS: Record<string, true> = {
  authorization: true,
  'x-api-key': true,
  'anthropic-version': true,
  host: true,
  'content-type': true,
  'content-length': true,
  accept: true,
  connection: true,
  'transfer-encoding': true,
  cookie: true,
}

function imageBase(raw: string | null | undefined): string | null | undefined {
  const url = raw?.trim() ?? ''
  if (!url) return null
  return new TextEncoder().encode(url).length <= 2048 && /^https?:\/\//.test(url) ? url : undefined
}

function cleanHeaders(raw: Record<string, string>): Record<string, string> {
  const entries = Object.entries(raw)
  if (entries.length > 20) throw badRequest('headers', 'too_many')
  const headers: [string, string][] = []
  const seen = new Set<string>()
  for (const [rawName, value] of entries) {
    const name = rawName.trim()
    const lower = name.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(name) || seen.has(lower) || charCount(value) > 2048 || /[\r\n]/.test(value))
      throw badRequest('headers', 'invalid')
    if (Object.hasOwn(RESERVED_HEADERS, lower)) throw badRequest('headers', 'reserved')
    seen.add(lower)
    headers.push([name, value])
  }
  return Object.fromEntries(headers)
}

function validateSave(input: ProviderSaveInput): void {
  const name = charCount(input.name.trim())
  if (name === 0 || name > 80) throw badRequest('name', 'out_of_range', 80)
  if (input.notes !== undefined && charCount(input.notes) > 10_000) throw badRequest('notes', 'out_of_range', 10_000)
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
    if (url && !url.startsWith('http://') && !url.startsWith('https://')) throw badRequest('baseUrl', 'invalid_url')
    if (imageBase(endpoint.imageBaseUrl) === undefined) throw badRequest('imageBaseUrl', 'invalid_url')
    if (imageBase(endpoint.imageEditBaseUrl) === undefined) throw badRequest('imageEditBaseUrl', 'invalid_url')
    if (endpoint.headers !== undefined) cleanHeaders(endpoint.headers)
    if (endpoint.models.length > 1000) throw badRequest('models', 'out_of_range', 1000)
    const models = new Set<string>()
    for (const model of endpoint.models) {
      if (!model.id) throw badRequest('models', 'empty_id')
      if (models.has(model.id)) throw badRequest('models', 'duplicate')
      models.add(model.id)
      validateModel(model, endpoint.protocol)
    }
  }
}

export async function setProviderEnabled(env: Env, userId: string, id: string, enabled: boolean): Promise<Provider[]> {
  const result = await env.DB.prepare(
    'UPDATE ai_providers SET enabled = ?1, updated_at = ?2 WHERE id = ?3 AND user_id = ?4',
  )
    .bind(enabled ? 1 : 0, Date.now(), id, userId)
    .run()
  if (result.meta.changes !== 1) throw notFound('provider')
  return listProviders(env, userId)
}

export async function saveProvider(env: Env, userId: string, input: ProviderSaveInput): Promise<Provider[]> {
  validateSave(input)
  const db = env.DB
  let priorEnabled: boolean | undefined
  if (input.id !== undefined) {
    const existing = await db
      .prepare('SELECT enabled FROM ai_providers WHERE id = ?1 AND user_id = ?2')
      .bind(input.id, userId)
      .first<{ enabled: number }>()
    if (!existing) throw notFound('provider')
    priorEnabled = existing.enabled !== 0
  }
  if (input.id === undefined && input.presetId !== undefined) {
    const owned = 'SELECT 1 FROM ai_providers WHERE user_id = ?1 AND preset_id = ?2'
    if (!(await db.prepare(owned).bind(userId, input.presetId).first())) {
      await db
        .prepare(
          'UPDATE ai_providers SET preset_id = ?2 WHERE id = (SELECT id FROM ai_providers WHERE user_id = ?1 AND preset_id IS NULL AND lower(name) = lower(?3) ORDER BY position LIMIT 1)',
        )
        .bind(userId, input.presetId, input.name.trim())
        .run()
    }
    if (await db.prepare(owned).bind(userId, input.presetId).first()) return listProviders(env, userId)
  }
  const providerId = input.id ?? newId()
  const enabled = input.enabled ?? priorEnabled ?? true
  const { results: old } = await db
    .prepare('SELECT id FROM ai_endpoints WHERE provider_id = ?1 AND user_id = ?2')
    .bind(providerId, userId)
    .all<{ id: string }>()
  const oldIds = new Set(old.map((row) => row.id))
  const { results: priorModels } = await db
    .prepare(
      'SELECT endpoint_id AS endpointId, model_id AS modelId, reasoning FROM ai_models WHERE user_id = ?1 AND endpoint_id IN (SELECT id FROM ai_endpoints WHERE provider_id = ?2 AND user_id = ?1)',
    )
    .bind(userId, providerId)
    .all<{ endpointId: string; modelId: string; reasoning: string | null }>()
  const priorReasoning = new Map(priorModels.map((model) => [`${model.endpointId}\n${model.modelId}`, model.reasoning]))
  if (input.endpoints.some((endpoint) => endpoint.id !== undefined && !oldIds.has(endpoint.id)))
    throw notFound('endpoint')
  const kept = new Set(input.endpoints.flatMap((endpoint) => (endpoint.id === undefined ? [] : [endpoint.id])))

  const planned = input.endpoints.map((endpoint) => {
    const id = endpoint.id ?? newId()
    const models = endpoint.models.map((model) => {
      // Omitted keeps the stored column (re-validated below); null = off ('none' for chat); object = replace.
      const reasoning =
        model.reasoning === undefined
          ? (priorReasoning.get(`${id}\n${model.id}`) ?? null)
          : model.reasoning === null
            ? model.modelType === 'chat' ? 'none' : null
            : JSON.stringify(model.reasoning)
      if (reasoning !== null && reasoning !== 'none')
        validateReasoning(ReasoningSchema.parse(JSON.parse(reasoning)), endpoint.protocol, model.modelType, model.maxOutput)
      return {
        ...model,
        name: label80('name', model.name),
        groupName: label80('groupName', model.groupName),
        reasoning: model.modelType === 'chat' ? reasoning : null,
        pricing: model.pricing === null ? null : JSON.stringify(model.pricing),
      }
    })
    return { endpoint, id, models }
  })

  const now = Date.now()
  const statements: D1PreparedStatement[] = [
    input.id === undefined
      ? db
          .prepare(
            'INSERT INTO ai_providers (id, user_id, name, enabled, notes, preset_id, position, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?6, ?7, (SELECT COALESCE(MAX(position) + 1, 0) FROM ai_providers WHERE user_id = ?2), ?5, ?5)',
          )
          .bind(providerId, userId, input.name, enabled ? 1 : 0, now, input.notes ?? '', input.presetId ?? null)
      : db
          .prepare('UPDATE ai_providers SET name = ?1, enabled = ?2, updated_at = ?3, notes = COALESCE(?6, notes) WHERE id = ?4 AND user_id = ?5')
          .bind(input.name, enabled ? 1 : 0, now, providerId, userId, input.notes ?? null),
    db
      .prepare(
        'DELETE FROM ai_models WHERE user_id = ?1 AND endpoint_id IN (SELECT id FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2)',
      )
      .bind(userId, providerId),
  ]
  for (const id of oldIds) {
    if (!kept.has(id))
      statements.push(
        db.prepare('DELETE FROM ai_endpoint_keys WHERE endpoint_id = ?1 AND user_id = ?2').bind(id, userId),
        db.prepare('DELETE FROM ai_endpoints WHERE id = ?1 AND user_id = ?2').bind(id, userId),
      )
  }
  statements.push(
    db.prepare('UPDATE ai_endpoints SET slug = id WHERE provider_id = ?1 AND user_id = ?2').bind(providerId, userId),
  )
  planned.forEach(({ endpoint, id, models }, position) => {
    const values = [endpoint.slug, endpoint.baseUrl.trim(), endpoint.protocol, position, id, userId] as const
    const image = endpoint.imageBaseUrl === undefined ? undefined : (imageBase(endpoint.imageBaseUrl) ?? null)
    const edit = endpoint.imageEditBaseUrl === undefined ? undefined : (imageBase(endpoint.imageEditBaseUrl) ?? null)
    const headers = endpoint.headers === undefined ? null : JSON.stringify(cleanHeaders(endpoint.headers))
    statements.push(
      endpoint.id === undefined
        ? db
            .prepare(
              'INSERT INTO ai_endpoints (slug, base_url, protocol, position, id, user_id, provider_id, image_base_url, headers, image_edit_base_url, key_strategy) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)',
            )
            .bind(...values, providerId, image ?? null, headers ?? '{}', edit ?? null, endpoint.keyStrategy ?? 'round_robin')
        : db
            .prepare(
              'UPDATE ai_endpoints SET slug = ?1, base_url = ?2, protocol = ?3, position = ?4, image_base_url = CASE WHEN ?7 = 1 THEN image_base_url ELSE ?8 END, headers = COALESCE(?9, headers), image_edit_base_url = CASE WHEN ?10 = 1 THEN image_edit_base_url ELSE ?11 END, key_strategy = COALESCE(?12, key_strategy) WHERE id = ?5 AND user_id = ?6',
            )
            .bind(...values, image === undefined ? 1 : 0, image ?? null, headers, edit === undefined ? 1 : 0, edit ?? null, endpoint.keyStrategy ?? null),
      db
        .prepare(
          `INSERT INTO ai_models (user_id, endpoint_id, model_id, model_type, type_source, context_window, max_output, can_vision, supports_tools, reasoning, native_web_search, name, group_name, pricing, position)
           SELECT ?1, ?2, json_extract(value, '$.id'), json_extract(value, '$.modelType'), json_extract(value, '$.typeSource'),
             json_extract(value, '$.contextWindow'), json_extract(value, '$.maxOutput'), json_extract(value, '$.canVision'),
             json_extract(value, '$.supportsTools'), json_extract(value, '$.reasoning'), json_extract(value, '$.nativeWebSearch'),
             json_extract(value, '$.name'), json_extract(value, '$.groupName'), json_extract(value, '$.pricing'), key FROM json_each(?3)`,
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
  const existing = await db
    .prepare('SELECT preset_id AS presetId FROM ai_providers WHERE id = ?1 AND user_id = ?2')
    .bind(id, userId)
    .first<{ presetId: string | null }>()
  if (!existing) throw notFound('provider')
  if (existing.presetId !== null) throw conflict('preset_provider')
  const endpoints = 'SELECT id FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2'
  await db.batch([
    db.prepare(`DELETE FROM ai_roles WHERE user_id = ?1 AND endpoint_id IN (${endpoints})`).bind(userId, id),
    db.prepare(`DELETE FROM ai_models WHERE user_id = ?1 AND endpoint_id IN (${endpoints})`).bind(userId, id),
    db.prepare(`DELETE FROM ai_endpoint_keys WHERE user_id = ?1 AND endpoint_id IN (${endpoints})`).bind(userId, id),
    db.prepare('DELETE FROM ai_endpoints WHERE user_id = ?1 AND provider_id = ?2').bind(userId, id),
    db.prepare('DELETE FROM ai_providers WHERE id = ?1 AND user_id = ?2').bind(id, userId),
  ])
  return listProviders(env, userId)
}

export async function saveKey(env: Env, userId: string, input: EndpointKeySaveInput): Promise<Provider[]> {
  const db = env.DB
  await ownedEndpoint(db, userId, input.endpointId)
  const keys = await endpointKeys(db, userId, input.endpointId)
  const isNew = input.id === undefined
  if (!isNew && !keys.some((row) => row.id === input.id)) throw notFound('key')
  if (isNew && keys.length >= MAX_KEYS) throw badRequest('keys', 'too_many', MAX_KEYS)
  const label = input.label?.trim()
  if (label !== undefined && charCount(label) > 40) throw badRequest('label', 'too_long', 40)
  const key = input.key?.trim()
  if (key === '' || (isNew && key === undefined)) throw badRequest('apiKey', 'empty')
  let cipher: string | null = null
  const id = input.id ?? newId()
  if (key !== undefined) {
    if (new TextEncoder().encode(key).length > 4096) throw badRequest('apiKey', 'too_long', 4096)
    for (const other of keys)
      if (other.id !== id && (await plainKey(env, other)) === key) throw badRequest('apiKey', 'duplicate')
    cipher = await encryptAiKey(env, id, key)
  }
  if (isNew) {
    const result = await db
      .prepare(
        `INSERT INTO ai_endpoint_keys (id, user_id, endpoint_id, label, enabled, key_ciphertext, position)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(position) + 1, 0) FROM ai_endpoint_keys WHERE user_id = ?2 AND endpoint_id = ?3)
         WHERE (SELECT COUNT(*) FROM ai_endpoint_keys WHERE user_id = ?2 AND endpoint_id = ?3) < ?7`,
      )
      .bind(id, userId, input.endpointId, label ?? '', input.enabled === false ? 0 : 1, cipher, MAX_KEYS)
      .run()
    if (result.meta.changes !== 1) throw badRequest('keys', 'too_many', MAX_KEYS)
  } else {
    await db
      .prepare(
        `UPDATE ai_endpoint_keys SET label = COALESCE(?1, label), enabled = COALESCE(?2, enabled), key_ciphertext = COALESCE(?3, key_ciphertext),
           exhausted_until = CASE WHEN ?7 = 1 OR ?3 IS NOT NULL THEN NULL ELSE exhausted_until END,
           exhausted_reason = CASE WHEN ?7 = 1 OR ?3 IS NOT NULL THEN NULL ELSE exhausted_reason END
         WHERE id = ?4 AND user_id = ?5 AND endpoint_id = ?6`,
      )
      .bind(label ?? null, input.enabled === undefined ? null : input.enabled ? 1 : 0, cipher, id, userId, input.endpointId, input.restore ? 1 : 0)
      .run()
  }
  return listProviders(env, userId)
}

export async function removeKey(env: Env, userId: string, endpointId: string, keyId: string): Promise<Provider[]> {
  await ownedEndpoint(env.DB, userId, endpointId)
  const result = await env.DB.prepare('DELETE FROM ai_endpoint_keys WHERE id = ?1 AND user_id = ?2 AND endpoint_id = ?3')
    .bind(keyId, userId, endpointId)
    .run()
  if (result.meta.changes !== 1) throw notFound('key')
  return listProviders(env, userId)
}

export async function revealKey(env: Env, userId: string, keyId: string, currentPassword: unknown): Promise<string> {
  const row = await env.DB.prepare('SELECT id, key_ciphertext AS keyCiphertext FROM ai_endpoint_keys WHERE id = ?1 AND user_id = ?2')
    .bind(keyId, userId)
    .first<{ id: string; keyCiphertext: string }>()
  if (!row) throw notFound('key')
  await requireCurrentPassword(env.DB, userId, currentPassword)
  return openKey(env, row)
}

export async function modelOptions(db: D1Database, userId: string, filter: ModelFilter): Promise<ModelOption[]> {
  const { results } = await db
    .prepare(
      `SELECT p.name AS provider, e.slug, e.protocol, e.base_url AS baseUrl, m.endpoint_id AS endpointId, m.model_id AS modelId, m.name, m.model_type AS modelType, m.supports_tools AS supportsTools, m.context_window AS contextWindow, m.max_output AS maxOutput, m.reasoning, m.native_web_search AS nativeWebSearch, m.can_vision AS canVision
       FROM ai_models m
       JOIN ai_endpoints e ON e.id = m.endpoint_id AND e.user_id = m.user_id
       JOIN ai_providers p ON p.id = e.provider_id AND p.user_id = m.user_id
       WHERE m.user_id = ?1 AND p.enabled = 1
       ORDER BY p.position, p.id, e.position, m.position`,
    )
    .bind(userId)
    .all<{
      provider: string
      slug: string
      protocol: Protocol
      baseUrl: string
      endpointId: string
      modelId: string
      name: string | null
      modelType: ModelType
      supportsTools: number | null
      contextWindow: number | null
      maxOutput: number | null
      reasoning: string | null
      nativeWebSearch: number
      canVision: number
    }>()
  return results
    .filter(
      (row) =>
        (filter.modelType === undefined || row.modelType === filter.modelType) &&
        (filter.supportsTools === undefined || flag(row.supportsTools) === filter.supportsTools),
    )
    .map((row) => ({
      endpointId: row.endpointId,
      modelId: row.modelId,
      name: row.name,
      label: `${row.provider} · ${row.slug} · ${row.modelId}`,
      modelType: row.modelType,
      supportsTools: flag(row.supportsTools),
      contextWindow: row.contextWindow,
      reasoning: readReasoning(row.reasoning, row.modelId, row.modelType, row.protocol, row.baseUrl, row.maxOutput),
      nativeWebSearch: row.nativeWebSearch !== 0,
      canVision: row.canVision !== 0,
    }))
}

export async function resolveModel(env: Env, userId: string, model: ModelRef, deferExhausted = false): Promise<Connection> {
  const row = await env.DB.prepare(
    `SELECT e.id AS endpointId, e.base_url AS baseUrl, e.protocol, e.image_base_url AS imageBaseUrl, e.image_edit_base_url AS imageEditBaseUrl, e.headers, e.key_strategy AS keyStrategy, e.slug, p.name AS providerName,
       m.model_type AS modelType, m.context_window AS contextWindow, m.max_output AS maxOutput, m.supports_tools AS supportsTools, m.reasoning, m.native_web_search AS nativeWebSearch, m.can_vision AS canVision, m.pricing
     FROM ai_models m JOIN ai_endpoints e ON e.id = m.endpoint_id AND e.user_id = m.user_id
     JOIN ai_providers p ON p.id = e.provider_id AND p.user_id = m.user_id
     WHERE m.user_id = ?1 AND m.endpoint_id = ?2 AND m.model_id = ?3 AND p.enabled = 1`,
  )
    .bind(userId, model.endpointId, model.modelId)
    .first<{
      endpointId: string
      baseUrl: string
      protocol: Protocol
      imageBaseUrl: string | null
      imageEditBaseUrl: string | null
      headers: string
      keyStrategy: KeyStrategy
      slug: string
      providerName: string
      modelType: ModelType
      contextWindow: number | null
      maxOutput: number | null
      supportsTools: number | null
      reasoning: string | null
      nativeWebSearch: number
      canVision: number
      pricing: string | null
    }>()
  if (!row) throw notFound('model')
  if (!row.baseUrl.trim()) throw needsConfig('missing_url')
  return {
    baseUrl: apiBase(row.baseUrl),
    imageBaseUrl: row.imageBaseUrl ? apiBase(row.imageBaseUrl) : null,
    imageEditBaseUrl: row.imageEditBaseUrl ? apiBase(row.imageEditBaseUrl) : null,
    headers: JSON.parse(row.headers) as Record<string, string>,
    protocol: row.protocol,
    ...(await requestKeys(env, userId, row.endpointId, row.keyStrategy, `${row.providerName} · ${row.slug}`, deferExhausted)),
    modelId: model.modelId,
    endpointId: row.endpointId,
    reasoning: readReasoning(row.reasoning, model.modelId, row.modelType, row.protocol, row.baseUrl, row.maxOutput),
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    supportsTools: flag(row.supportsTools),
    nativeWebSearch: row.nativeWebSearch !== 0,
    canVision: row.canVision !== 0,
    pricing: row.pricing === null ? null : (JSON.parse(row.pricing) as ModelPricing),
  }
}

/** Keys a probe tries: just `keyId` when given, else the rotated enabled keys. */
async function probeKeys(env: Env, userId: string, endpointId: string, keyId?: string): Promise<string[]> {
  if (keyId === undefined) return rotatedKeys(env, userId, endpointId)
  const row = (await endpointKeys(env.DB, userId, endpointId)).find((key) => key.id === keyId)
  if (!row) throw notFound('key')
  return [await openKey(env, row)]
}

const PROBE_TIMEOUT_MS = 20_000
const PROBE_MAX_BODY = 4 * 1024 * 1024

const failure = (kind: ProbeErrorKind, hint: string | null = null): ProbeError => ({
  kind,
  status: null,
  message: null,
  hint,
})

export async function probe(
  env: Env,
  userId: string,
  target: ProbeTargetInput,
  signal: AbortSignal,
): Promise<ProbeResult> {
  let baseUrl: string
  let protocol: Protocol
  let keys: string[] = []
  let headers: Record<string, string> = {}
  if (target.kind === 'saved') {
    ;({ baseUrl, protocol, headers } = await ownedEndpoint(env.DB, userId, target.endpointId))
    keys = await probeKeys(env, userId, target.endpointId)
  } else {
    baseUrl = target.baseUrl
    protocol = target.protocol
    if (target.endpointId !== undefined) {
      ;({ headers } = await ownedEndpoint(env.DB, userId, target.endpointId))
      keys = await probeKeys(env, userId, target.endpointId, target.keyId)
    } else if (target.keyId !== undefined) throw notFound('key')
  }
  const probeUrl = `${apiBase(baseUrl)}/models`
  const done = (models: ProbedModel[], error: ProbeError | null): ProbeResult => ({ probeUrl, models, error })
  const url = parseTarget(probeUrl)
  if (!(await addressAllowed(env.DB, url))) return done([], failure('blocked_address'))
  if (!keys.length && !isLoopback(url)) return done([], failure('missing_key'))
  const ipHost = /^\[.*\]$|^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)
  const candidates = keys.length ? keys : [null]
  let body: { bytes: Uint8Array; overflow: boolean } | null = null
  for (let index = 0; ; index++) {
    const key = candidates[index] ?? null
    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    const transport = (): ProbeResult => {
      if (signal.aborted) throw cancelled()
      return done(
        [],
        timeout.aborted ? failure('timeout') : failure('connect', ipHost ? 'providers.hint.check_network' : null),
      )
    }
    let response: Response
    try {
      response = await fetch(url, {
        headers: { ...headers, ...authHeaders(protocol, key) },
        redirect: 'manual',
        signal: AbortSignal.any([signal, timeout]),
      })
    } catch {
      return transport()
    }
    const declared = Number(response.headers.get('content-length') ?? '0')
    try {
      body = declared > PROBE_MAX_BODY ? null : await readUpTo(response.body, PROBE_MAX_BODY)
    } catch {
      if (!response.ok) body = null
      else return transport()
    }
    if (body?.overflow) body = null
    if (response.ok) break
    const status = response.status
    const message = body ? excerpt(new TextDecoder().decode(body.bytes), keys) || null : null
    const [kind, hint]: [ProbeErrorKind, string | null] =
      status === 401 || status === 403
        ? ['unauthorized', 'providers.hint.check_key']
        : status === 404
          ? ['not_found', baseUrl.includes('/v1') ? null : 'providers.hint.missing_v1']
          : status === 429
            ? ['rate_limited', null]
            : ['status', null]
    if ((kind === 'unauthorized' || kind === 'rate_limited') && index + 1 < candidates.length) continue
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
        reasoning: inferred.modelType === 'chat' ? inferReasoning(id, protocol, baseUrl, inferred.maxOutput) : null,
        nativeWebSearch: false,
        name: null,
        groupName: inferred.group,
        pricing: null,
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
