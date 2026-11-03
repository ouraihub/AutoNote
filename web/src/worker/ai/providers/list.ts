import type {
  Endpoint,
  ModelPricing,
  Provider,
} from '@ouraihub/aether-ui/ports'
import type { Env } from '../../env'

import { apiBase, maskSecret } from '../kit'
import { readReasoning } from './schema'
import type { EndpointRow, KeyRow, ModelRow } from './types'

import { plainKey, KEY_COLUMNS } from './key-rotation'

const flag = (value: number | null): boolean | null =>
  value === null ? null : value !== 0

export async function listProviders(
  env: Env,
  userId: string,
): Promise<Provider[]> {
  const db = env.DB
  const [
    { results: providers },
    { results: endpoints },
    { results: models },
    { results: keys },
  ] = await Promise.all([
    db
      .prepare(
        'SELECT id, name, enabled, notes, preset_id AS pres' +
          'etId FROM ai_providers WHERE user_id = ?1 ORDER BY' +
          ' position, id',
      )
      .bind(userId)
      .all<{
        id: string
        name: string
        enabled: number
        notes: string
        presetId: string | null
      }>(),
    db
      .prepare(
        'SELECT id, provider_id AS providerId, slug, base_u' +
          'rl AS baseUrl, protocol, image_base_url AS imageBa' +
          'seUrl, image_edit_base_url AS imageEditBaseUrl, he' +
          'aders, key_strategy AS keyStrategy FROM ai_endpoin' +
          'ts WHERE user_id = ?1 ORDER BY position, id',
      )
      .bind(userId)
      .all<EndpointRow>(),
    db
      .prepare(
        'SELECT endpoint_id AS endpointId, model_id AS id, ' +
          'model_type AS modelType, type_source AS typeSource' +
          ', context_window AS contextWindow, max_output AS m' +
          'axOutput, can_vision AS canVision, supports_tools ' +
          'AS supportsTools, reasoning, native_web_search AS ' +
          'nativeWebSearch, name, group_name AS groupName, pr' +
          'icing FROM ai_models WHERE user_id = ?1 ORDER BY p' +
          'osition',
      )
      .bind(userId)
      .all<ModelRow>(),
    db
      .prepare(
        'SELECT ' +
          `${KEY_COLUMNS}` +
          ' FROM ai_endpoint_keys WHERE user_id = ?1 ORDER BY' +
          ' position, id',
      )
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
            // Set-aside marks only matter, and are only shown, under
            // fill-first.
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
              reasoning: readReasoning(
                model.reasoning,
                model.id,
                model.modelType,
                row.protocol,
                row.baseUrl,
                model.maxOutput,
              ),
              nativeWebSearch: model.nativeWebSearch !== 0,
              pricing:
                model.pricing === null
                  ? null
                  : (JSON.parse(model.pricing) as ModelPricing),
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
    endpoints: shown
      .filter(([providerId]) => providerId === provider.id)
      .map(([, endpoint]) => endpoint),
  }))
}
