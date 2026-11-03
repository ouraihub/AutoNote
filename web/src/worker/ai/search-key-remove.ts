import type { Env } from '../env'
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

export async function removeKey(
  env: Env,
  userId: string,
  input: { capability?: unknown; provider?: unknown; keyId?: unknown },
): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider', 'keyId'])
  const cap = capability(input.capability)
  const provider = trimmed(input.provider, 'provider', 64)
  providerFor(cap, provider)
  const keyId = trimmed(input.keyId, 'keyId', 64)
  if (
    !(await keyRows(env, userId, cap, provider)).some((key) => key.id === keyId)
  )
    throw new KitFailure('bad_request', 'unknown key')
  await env.DB.prepare(
    'DELETE FROM ai_search_keys WHERE id = ?1 AND use' +
      'r_id = ?2 AND capability = ?3 AND provider = ?4',
  )
    .bind(keyId, userId, cap, provider)
    .run()
  return getSettings(env, userId, cap)
}
