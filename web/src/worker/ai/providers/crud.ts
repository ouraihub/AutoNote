import type { Provider } from '@ouraihub/aether-ui/ports'
import type { Env } from '../../env'
import { encryptAiKey } from '../../lib/crypto'
import { newId } from '../../lib/id'
import { requireCurrentPassword } from '../../lib/reauth'

import { validateReasoning } from '@ouraihub/aether-core/providers'
import { badRequest, conflict, charCount, notFound } from '../kit'
import {
  MAX_KEYS,
  ReasoningSchema,
  cleanHeaders,
  imageBase,
  label80,
  validateSave,
  type ProviderSaveInput,
  type EndpointKeySaveInput,
} from './schema'

import { listProviders } from './list'
import { ownedEndpoint } from './probe'
import { endpointKeys, plainKey, openKey } from './key-rotation'

export async function setProviderEnabled(
  env: Env,
  userId: string,
  id: string,
  enabled: boolean,
): Promise<Provider[]> {
  const result = await env.DB.prepare(
    'UPDATE ai_providers SET enabled = ?1, updated_at =' +
      ' ?2 WHERE id = ?3 AND user_id = ?4',
  )
    .bind(enabled ? 1 : 0, Date.now(), id, userId)
    .run()
  if (result.meta.changes !== 1) throw notFound('provider')
  return listProviders(env, userId)
}

export async function saveProvider(
  env: Env,
  userId: string,
  input: ProviderSaveInput,
): Promise<Provider[]> {
  validateSave(input)
  const db = env.DB
  let priorEnabled: boolean | undefined
  if (input.id !== undefined) {
    const existing = await db
      .prepare(
        'SELECT enabled FROM ai_providers WHERE id = ?1 AND' + ' user_id = ?2',
      )
      .bind(input.id, userId)
      .first<{ enabled: number }>()
    if (!existing) throw notFound('provider')
    priorEnabled = existing.enabled !== 0
  }
  if (input.id === undefined && input.presetId !== undefined) {
    const owned =
      'SELECT 1 FROM ai_providers WHERE user_id = ?1 AND ' + 'preset_id = ?2'
    if (!(await db.prepare(owned).bind(userId, input.presetId).first())) {
      await db
        .prepare(
          'UPDATE ai_providers SET preset_id = ?2 WHERE id = ' +
            '(SELECT id FROM ai_providers WHERE user_id = ?1 AN' +
            'D preset_id IS NULL AND lower(name) = lower(?3) OR' +
            'DER BY position LIMIT 1)',
        )
        .bind(userId, input.presetId, input.name.trim())
        .run()
    }
    if (await db.prepare(owned).bind(userId, input.presetId).first())
      return listProviders(env, userId)
  }
  const providerId = input.id ?? newId()
  const enabled = input.enabled ?? priorEnabled ?? true
  const { results: old } = await db
    .prepare(
      'SELECT id FROM ai_endpoints WHERE provider_id = ?1' +
        ' AND user_id = ?2',
    )
    .bind(providerId, userId)
    .all<{ id: string }>()
  const oldIds = new Set(old.map((row) => row.id))
  const { results: priorModels } = await db
    .prepare(
      'SELECT endpoint_id AS endpointId, model_id AS mode' +
        'lId, reasoning FROM ai_models WHERE user_id = ?1 A' +
        'ND endpoint_id IN (SELECT id FROM ai_endpoints WHE' +
        'RE provider_id = ?2 AND user_id = ?1)',
    )
    .bind(userId, providerId)
    .all<{ endpointId: string; modelId: string; reasoning: string | null }>()
  const priorReasoning = new Map(
    priorModels.map((model) => [
      `${model.endpointId}\n${model.modelId}`,
      model.reasoning,
    ]),
  )
  if (
    input.endpoints.some(
      (endpoint) => endpoint.id !== undefined && !oldIds.has(endpoint.id),
    )
  )
    throw notFound('endpoint')
  const kept = new Set(
    input.endpoints.flatMap((endpoint) =>
      endpoint.id === undefined ? [] : [endpoint.id],
    ),
  )

  const planned = input.endpoints.map((endpoint) => {
    const id = endpoint.id ?? newId()
    const models = endpoint.models.map((model) => {
      // Omitted keeps the stored column (re-validated below); null = off
      // ('none' for chat); object = replace.
      const reasoning =
        model.reasoning === undefined
          ? (priorReasoning.get(`${id}\n${model.id}`) ?? null)
          : model.reasoning === null
            ? model.modelType === 'chat'
              ? 'none'
              : null
            : JSON.stringify(model.reasoning)
      if (reasoning !== null && reasoning !== 'none')
        validateReasoning(
          ReasoningSchema.parse(JSON.parse(reasoning)),
          endpoint.protocol,
          model.modelType,
          model.maxOutput,
        )
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
            'INSERT INTO ai_providers (id, user_id, name, enabl' +
              'ed, notes, preset_id, position, created_at, update' +
              'd_at) VALUES (?1, ?2, ?3, ?4, ?6, ?7, (SELECT COAL' +
              'ESCE(MAX(position) + 1, 0) FROM ai_providers WHERE' +
              ' user_id = ?2), ?5, ?5)',
          )
          .bind(
            providerId,
            userId,
            input.name,
            enabled ? 1 : 0,
            now,
            input.notes ?? '',
            input.presetId ?? null,
          )
      : db
          .prepare(
            'UPDATE ai_providers SET name = ?1, enabled = ?2, u' +
              'pdated_at = ?3, notes = COALESCE(?6, notes) WHERE ' +
              'id = ?4 AND user_id = ?5',
          )
          .bind(
            input.name,
            enabled ? 1 : 0,
            now,
            providerId,
            userId,
            input.notes ?? null,
          ),
    db
      .prepare(
        'DELETE FROM ai_models WHERE user_id = ?1 AND endpo' +
          'int_id IN (SELECT id FROM ai_endpoints WHERE user_' +
          'id = ?1 AND provider_id = ?2)',
      )
      .bind(userId, providerId),
  ]
  for (const id of oldIds) {
    if (!kept.has(id))
      statements.push(
        db
          .prepare(
            'DELETE FROM ai_endpoint_keys WHERE endpoint_id = ?' +
              '1 AND user_id = ?2',
          )
          .bind(id, userId),
        db
          .prepare(
            'DELETE FROM ai_endpoints WHERE id = ?1 AND user_id' + ' = ?2',
          )
          .bind(id, userId),
      )
  }
  statements.push(
    db
      .prepare(
        'UPDATE ai_endpoints SET slug = id WHERE provider_i' +
          'd = ?1 AND user_id = ?2',
      )
      .bind(providerId, userId),
  )
  planned.forEach(({ endpoint, id, models }, position) => {
    const values = [
      endpoint.slug,
      endpoint.baseUrl.trim(),
      endpoint.protocol,
      position,
      id,
      userId,
    ] as const
    const image =
      endpoint.imageBaseUrl === undefined
        ? undefined
        : (imageBase(endpoint.imageBaseUrl) ?? null)
    const edit =
      endpoint.imageEditBaseUrl === undefined
        ? undefined
        : (imageBase(endpoint.imageEditBaseUrl) ?? null)
    const headers =
      endpoint.headers === undefined
        ? null
        : JSON.stringify(cleanHeaders(endpoint.headers))
    statements.push(
      endpoint.id === undefined
        ? db
            .prepare(
              'INSERT INTO ai_endpoints (slug, base_url, protocol' +
                ', position, id, user_id, provider_id, image_base_u' +
                'rl, headers, image_edit_base_url, key_strategy) VA' +
                'LUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11' +
                ')',
            )
            .bind(
              ...values,
              providerId,
              image ?? null,
              headers ?? '{}',
              edit ?? null,
              endpoint.keyStrategy ?? 'round_robin',
            )
        : db
            .prepare(
              'UPDATE ai_endpoints SET slug = ?1, base_url = ?2, ' +
                'protocol = ?3, position = ?4, image_base_url = CAS' +
                'E WHEN ?7 = 1 THEN image_base_url ELSE ?8 END, hea' +
                'ders = COALESCE(?9, headers), image_edit_base_url ' +
                '= CASE WHEN ?10 = 1 THEN image_edit_base_url ELSE ' +
                '?11 END, key_strategy = COALESCE(?12, key_strategy' +
                ') WHERE id = ?5 AND user_id = ?6',
            )
            .bind(
              ...values,
              image === undefined ? 1 : 0,
              image ?? null,
              headers,
              edit === undefined ? 1 : 0,
              edit ?? null,
              endpoint.keyStrategy ?? null,
            ),
      db
        .prepare(
          'INSERT INTO ai_models (user_id, endpoint_id, model' +
            '_id, model_type, type_source, context_window, max_' +
            'output, can_vision, supports_tools, reasoning, nat' +
            'ive_web_search, name, group_name, pricing, positio' +
            'n)\n           SELECT ?1, ?2, json_extract(value, ' +
            "'$.id'), json_extract(value, '$.modelType'), json_" +
            "extract(value, '$.typeSource'),\n             json" +
            "_extract(value, '$.contextWindow'), json_extract(v" +
            "alue, '$.maxOutput'), json_extract(value, '$.canVi" +
            "sion'),\n             json_extract(value, '$.suppo" +
            "rtsTools'), json_extract(value, '$.reasoning'), js" +
            "on_extract(value, '$.nativeWebSearch'),\n         " +
            "    json_extract(value, '$.name'), json_extract(va" +
            "lue, '$.groupName'), json_extract(value, '$.pricin" +
            "g'), key FROM json_each(?3)",
        )
        .bind(userId, id, JSON.stringify(models)),
    )
  })
  statements.push(
    db
      .prepare(
        'DELETE FROM ai_roles WHERE user_id = ?1 AND NOT EX' +
          'ISTS (SELECT 1 FROM ai_models m WHERE m.user_id = ' +
          '?1 AND m.endpoint_id = ai_roles.endpoint_id AND m.' +
          'model_id = ai_roles.model_id)',
      )
      .bind(userId),
  )
  await db.batch(statements)
  return listProviders(env, userId)
}

export async function removeProvider(
  env: Env,
  userId: string,
  id: string,
): Promise<Provider[]> {
  const db = env.DB
  const existing = await db
    .prepare(
      'SELECT preset_id AS presetId FROM ai_providers WHE' +
        'RE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .first<{ presetId: string | null }>()
  if (!existing) throw notFound('provider')
  if (existing.presetId !== null) throw conflict('preset_provider')
  const endpoints =
    'SELECT id FROM ai_endpoints WHERE user_id = ?1 AND' + ' provider_id = ?2'
  await db.batch([
    db
      .prepare(
        'DELETE FROM ai_roles WHERE user_id = ?1 AND endpoi' +
          'nt_id IN (' +
          `${endpoints}` +
          ')',
      )
      .bind(userId, id),
    db
      .prepare(
        'DELETE FROM ai_models WHERE user_id = ?1 AND endpo' +
          'int_id IN (' +
          `${endpoints}` +
          ')',
      )
      .bind(userId, id),
    db
      .prepare(
        'DELETE FROM ai_endpoint_keys WHERE user_id = ?1 AN' +
          'D endpoint_id IN (' +
          `${endpoints}` +
          ')',
      )
      .bind(userId, id),
    db
      .prepare(
        'DELETE FROM ai_endpoints WHERE user_id = ?1 AND pr' + 'ovider_id = ?2',
      )
      .bind(userId, id),
    db
      .prepare('DELETE FROM ai_providers WHERE id = ?1 AND user_id' + ' = ?2')
      .bind(id, userId),
  ])
  return listProviders(env, userId)
}

export async function saveKey(
  env: Env,
  userId: string,
  input: EndpointKeySaveInput,
): Promise<Provider[]> {
  const db = env.DB
  await ownedEndpoint(db, userId, input.endpointId)
  const keys = await endpointKeys(db, userId, input.endpointId)
  const isNew = input.id === undefined
  if (!isNew && !keys.some((row) => row.id === input.id)) throw notFound('key')
  if (isNew && keys.length >= MAX_KEYS)
    throw badRequest('keys', 'too_many', MAX_KEYS)
  const label = input.label?.trim()
  if (label !== undefined && charCount(label) > 40)
    throw badRequest('label', 'too_long', 40)
  const key = input.key?.trim()
  if (key === '' || (isNew && key === undefined))
    throw badRequest('apiKey', 'empty')
  let cipher: string | null = null
  const id = input.id ?? newId()
  if (key !== undefined) {
    if (new TextEncoder().encode(key).length > 4096)
      throw badRequest('apiKey', 'too_long', 4096)
    for (const other of keys)
      if (other.id !== id && (await plainKey(env, other)) === key)
        throw badRequest('apiKey', 'duplicate')
    cipher = await encryptAiKey(env, id, key)
  }
  if (isNew) {
    const result = await db
      .prepare(
        'INSERT INTO ai_endpoint_keys (id, user_id, endpoin' +
          't_id, label, enabled, key_ciphertext, position)\n ' +
          '        SELECT ?1, ?2, ?3, ?4, ?5, ?6, (SELECT COA' +
          'LESCE(MAX(position) + 1, 0) FROM ai_endpoint_keys ' +
          'WHERE user_id = ?2 AND endpoint_id = ?3)\n        ' +
          ' WHERE (SELECT COUNT(*) FROM ai_endpoint_keys WHER' +
          'E user_id = ?2 AND endpoint_id = ?3) < ?7',
      )
      .bind(
        id,
        userId,
        input.endpointId,
        label ?? '',
        input.enabled === false ? 0 : 1,
        cipher,
        MAX_KEYS,
      )
      .run()
    if (result.meta.changes !== 1)
      throw badRequest('keys', 'too_many', MAX_KEYS)
  } else {
    await db
      .prepare(
        'UPDATE ai_endpoint_keys SET label = COALESCE(?1, l' +
          'abel), enabled = COALESCE(?2, enabled), key_cipher' +
          'text = COALESCE(?3, key_ciphertext),\n           e' +
          'xhausted_until = CASE WHEN ?7 = 1 OR ?3 IS NOT NUL' +
          'L THEN NULL ELSE exhausted_until END,\n           ' +
          'exhausted_reason = CASE WHEN ?7 = 1 OR ?3 IS NOT N' +
          'ULL THEN NULL ELSE exhausted_reason END\n         ' +
          'WHERE id = ?4 AND user_id = ?5 AND endpoint_id = ?' +
          '6',
      )
      .bind(
        label ?? null,
        input.enabled === undefined ? null : input.enabled ? 1 : 0,
        cipher,
        id,
        userId,
        input.endpointId,
        input.restore ? 1 : 0,
      )
      .run()
  }
  return listProviders(env, userId)
}

export async function removeKey(
  env: Env,
  userId: string,
  endpointId: string,
  keyId: string,
): Promise<Provider[]> {
  await ownedEndpoint(env.DB, userId, endpointId)
  const result = await env.DB.prepare(
    'DELETE FROM ai_endpoint_keys WHERE id = ?1 AND use' +
      'r_id = ?2 AND endpoint_id = ?3',
  )
    .bind(keyId, userId, endpointId)
    .run()
  if (result.meta.changes !== 1) throw notFound('key')
  return listProviders(env, userId)
}

export async function revealKey(
  env: Env,
  userId: string,
  keyId: string,
  currentPassword: unknown,
): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT id, key_ciphertext AS keyCiphertext FROM ai' +
      '_endpoint_keys WHERE id = ?1 AND user_id = ?2',
  )
    .bind(keyId, userId)
    .first<{ id: string; keyCiphertext: string }>()
  if (!row) throw notFound('key')
  await requireCurrentPassword(env.DB, userId, currentPassword)
  return openKey(env, row)
}
