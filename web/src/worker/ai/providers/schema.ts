import { z } from 'zod'
import type { ModelPricing, ModelType, Protocol, ReasoningConfig } from '@ouraihub/aether-ui/ports'
import { inferReasoning } from '@ouraihub/aether-core/providers'
import { charCount, badRequest } from '../kit'

export const PROTOCOLS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const
const MODEL_TYPES = ['chat', 'image', 'video', 'tts', 'stt', 'embedding', 'rerank', 'unknown'] as const
const EFFORTS = ['default', 'none', 'auto', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const DIALECTS = ['openai', 'anthropic-budget', 'anthropic-adaptive', 'thinking-type', 'qwen'] as const
const tokenLimit = z.number().int().min(0).max(0xffff_ffff).nullable().default(null)
export const ReasoningSchema = z
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
export const MAX_KEYS = 16

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

export function readReasoning(
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

export const label80 = (field: string, raw: string | null): string | null => {
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

export function validateModel(model: z.infer<typeof ModelSchema>, protocol: Protocol): void {
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

export function imageBase(raw: string | null | undefined): string | null | undefined {
  const url = raw?.trim() ?? ''
  if (!url) return null
  return new TextEncoder().encode(url).length <= 2048 && /^https?:\/\//.test(url) ? url : undefined
}

export function cleanHeaders(raw: Record<string, string>): Record<string, string> {
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

export function validateSave(input: ProviderSaveInput): void {
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
