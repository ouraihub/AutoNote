import type { Env } from '../env'
import { encryptAiKey } from '../lib/crypto'
import { newId } from '../lib/id'
import { KitFailure } from './kit'
import {
  capability,
  providerFor,
  keyRows,
  fields,
  trimmed,
  getSettings,
  type SearchSettingsDto,
} from './search-config'

export async function saveKey(
  env: Env,
  userId: string,
  input: {
    capability?: unknown
    provider?: unknown
    value?: unknown
    keyId?: unknown
  },
): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider', 'value', 'keyId'])
  const cap = capability(input.capability)
  const provider = trimmed(input.provider, 'provider', 64)
  const { spec, config } = providerFor(cap, provider)
  if (config.keyMode === 'none' && !spec.basicAuth)
    throw new KitFailure('bad_request', 'provider does not accept keys')
  const value = trimmed(input.value, 'value', 4096)
  if (!value) throw new KitFailure('bad_request', 'key is empty')
  const keys = await keyRows(env, userId, cap, provider)
  const keyId =
    input.keyId === undefined ? newId() : trimmed(input.keyId, 'keyId', 64)
  if (input.keyId !== undefined && !keys.some((key) => key.id === keyId))
    throw new KitFailure('bad_request', 'unknown key')
  if (input.keyId === undefined && keys.length >= 16)
    throw new KitFailure('bad_request', 'key limit reached')
  const cipher = await encryptAiKey(env, keyId, value)
  if (input.keyId === undefined) {
    const position = keys.length ? keys[keys.length - 1]!.position + 1 : 0
    await env.DB.prepare(
      'INSERT INTO ai_search_keys (id, user_id, capabil' +
        'ity, provider, key_ciphertext, position) SELECT ' +
        '?1, ?2, ?3, ?4, ?5, ?6 WHERE (SELECT COUNT(*) FR' +
        'OM ai_search_keys WHERE user_id = ?2 AND capabil' +
        'ity = ?3 AND provider = ?4) < 16',
    )
      .bind(keyId, userId, cap, provider, cipher, position)
      .run()
    if (
      !(await keyRows(env, userId, cap, provider)).some(
        (key) => key.id === keyId,
      )
    )
      throw new KitFailure('bad_request', 'key limit reached')
  } else {
    await env.DB.prepare(
      'UPDATE ai_search_keys SET key_ciphertext = ?1 WH' +
        'ERE id = ?2 AND user_id = ?3 AND capability = ?4' +
        ' AND provider = ?5',
    )
      .bind(cipher, keyId, userId, cap, provider)
      .run()
  }
  return getSettings(env, userId, cap)
}
