import type {
  ModelFilter,
  ModelOption,
  ModelRef,
  ModelPricing,
  ModelType,
  Protocol,
  KeyStrategy,
} from '@ouraihub/aether-ui/ports'
import type { Env } from '../../env'

import { apiBase, needsConfig, notFound } from '../kit'
import { readReasoning } from './schema'
import type { Connection } from './types'

import { requestKeys } from './key-rotation'

const flag = (value: number | null): boolean | null =>
  value === null ? null : value !== 0

export async function modelOptions(
  db: D1Database,
  userId: string,
  filter: ModelFilter,
): Promise<ModelOption[]> {
  const { results } = await db
    .prepare(
      'SELECT p.name AS provider, e.slug, e.protocol, e.b' +
        'ase_url AS baseUrl, m.endpoint_id AS endpointId, m' +
        '.model_id AS modelId, m.name, m.model_type AS mode' +
        'lType, m.supports_tools AS supportsTools, m.contex' +
        't_window AS contextWindow, m.max_output AS maxOutp' +
        'ut, m.reasoning, m.native_web_search AS nativeWebS' +
        'earch, m.can_vision AS canVision\n       FROM ai_m' +
        'odels m\n       JOIN ai_endpoints e ON e.id = m.en' +
        'dpoint_id AND e.user_id = m.user_id\n       JOIN a' +
        'i_providers p ON p.id = e.provider_id AND p.user_i' +
        'd = m.user_id\n       WHERE m.user_id = ?1 AND p.e' +
        'nabled = 1\n       ORDER BY p.position, p.id, e.po' +
        'sition, m.position',
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
        (filter.modelType === undefined ||
          row.modelType === filter.modelType) &&
        (filter.supportsTools === undefined ||
          flag(row.supportsTools) === filter.supportsTools),
    )
    .map((row) => ({
      endpointId: row.endpointId,
      modelId: row.modelId,
      name: row.name,
      label: `${row.provider} · ${row.slug} · ${row.modelId}`,
      modelType: row.modelType,
      supportsTools: flag(row.supportsTools),
      contextWindow: row.contextWindow,
      reasoning: readReasoning(
        row.reasoning,
        row.modelId,
        row.modelType,
        row.protocol,
        row.baseUrl,
        row.maxOutput,
      ),
      nativeWebSearch: row.nativeWebSearch !== 0,
      canVision: row.canVision !== 0,
    }))
}

export async function resolveModel(
  env: Env,
  userId: string,
  model: ModelRef,
  deferExhausted = false,
): Promise<Connection> {
  const row = await env.DB.prepare(
    'SELECT e.id AS endpointId, e.base_url AS baseUrl, ' +
      'e.protocol, e.image_base_url AS imageBaseUrl, e.im' +
      'age_edit_base_url AS imageEditBaseUrl, e.headers, ' +
      'e.key_strategy AS keyStrategy, e.slug, p.name AS p' +
      'roviderName,\n       m.model_type AS modelType, m.' +
      'context_window AS contextWindow, m.max_output AS m' +
      'axOutput, m.supports_tools AS supportsTools, m.rea' +
      'soning, m.native_web_search AS nativeWebSearch, m.' +
      'can_vision AS canVision, m.pricing\n     FROM ai_m' +
      'odels m JOIN ai_endpoints e ON e.id = m.endpoint_i' +
      'd AND e.user_id = m.user_id\n     JOIN ai_provider' +
      's p ON p.id = e.provider_id AND p.user_id = m.user' +
      '_id\n     WHERE m.user_id = ?1 AND m.endpoint_id =' +
      ' ?2 AND m.model_id = ?3 AND p.enabled = 1',
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
    imageEditBaseUrl: row.imageEditBaseUrl
      ? apiBase(row.imageEditBaseUrl)
      : null,
    headers: JSON.parse(row.headers) as Record<string, string>,
    protocol: row.protocol,
    ...(await requestKeys(
      env,
      userId,
      row.endpointId,
      row.keyStrategy,
      `${row.providerName} · ${row.slug}`,
      deferExhausted,
    )),
    modelId: model.modelId,
    endpointId: row.endpointId,
    reasoning: readReasoning(
      row.reasoning,
      model.modelId,
      row.modelType,
      row.protocol,
      row.baseUrl,
      row.maxOutput,
    ),
    contextWindow: row.contextWindow,
    maxOutput: row.maxOutput,
    supportsTools: flag(row.supportsTools),
    nativeWebSearch: row.nativeWebSearch !== 0,
    canVision: row.canVision !== 0,
    pricing:
      row.pricing === null ? null : (JSON.parse(row.pricing) as ModelPricing),
  }
}
export type { Connection } from './types'
