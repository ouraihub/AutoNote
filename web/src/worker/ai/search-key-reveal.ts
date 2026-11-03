import type { Env } from '../env'
import { decryptAiKey } from '../lib/crypto'
import { requireCurrentPassword } from '../lib/reauth'
import { KitFailure, needsConfig } from './kit'
import {
  capability,
  providerFor,
  keyRows,
  fields,
  trimmed,
} from './search-config'

export async function reveal(
  env: Env,
  userId: string,
  input: {
    capability?: unknown
    provider?: unknown
    keyId?: unknown
    currentPassword?: unknown
  },
): Promise<string> {
  fields(input, ['capability', 'provider', 'keyId', 'currentPassword'])
  const cap = capability(input.capability)
  const provider = trimmed(input.provider, 'provider', 64)
  providerFor(cap, provider)
  const keyId = trimmed(input.keyId, 'keyId', 64)
  await requireCurrentPassword(env.DB, userId, input.currentPassword)
  const row = (await keyRows(env, userId, cap, provider)).find(
    (key) => key.id === keyId,
  )
  if (!row) throw new KitFailure('bad_request', 'unknown key')
  const value = await decryptAiKey(env, row.id, row.keyCiphertext)
  if (!value) throw needsConfig('api key')
  return value
}
