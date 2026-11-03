import type { Env } from '../env'
import { badRequest } from './kit'
import {
  capability,
  fields,
  getSettings,
  providerFor,
  rowMap,
  rows,
  assertPublicTarget,
  trimmed,
  type SearchSettingsDto,
} from './search-config'

export async function saveProvider(
  env: Env,
  userId: string,
  input: {
    capability?: unknown
    provider?: unknown
    baseUrl?: unknown
    basicAuthUsername?: unknown
  },
): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider', 'baseUrl', 'basicAuthUsername'])
  const cap = capability(input.capability)
  const id = trimmed(input.provider, 'provider', 64)
  const { spec } = providerFor(cap, id)
  const baseUrl =
    input.baseUrl === undefined
      ? undefined
      : trimmed(input.baseUrl, 'baseUrl', 8192)
  if (baseUrl) await assertPublicTarget(env.DB, baseUrl)
  const username =
    input.basicAuthUsername === undefined
      ? undefined
      : trimmed(input.basicAuthUsername, 'basicAuthUsername', 200)
  if (username !== undefined && !spec.basicAuth)
    throw badRequest('basicAuthUsername', 'unsupported')
  const old = rowMap(await rows(env, userId, cap)).get(id)
  await env.DB.prepare(
    'INSERT INTO ai_search_provider_configs (user_id,' +
      ' capability, provider, base_url, basic_username)' +
      ' VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(user_id' +
      ', capability, provider) DO UPDATE SET base_url =' +
      ' excluded.base_url, basic_username = excluded.ba' +
      'sic_username',
  )
    .bind(
      userId,
      cap,
      id,
      baseUrl === undefined ? (old?.baseUrl ?? null) : baseUrl || null,
      username === undefined
        ? (old?.basicAuthUsername ?? null)
        : username || null,
    )
    .run()
  return getSettings(env, userId, cap)
}

export async function setDefault(
  env: Env,
  userId: string,
  input: { capability?: unknown; provider?: unknown },
): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider'])
  const cap = capability(input.capability)
  const id = trimmed(input.provider, 'provider', 64)
  providerFor(cap, id)
  await env.DB.prepare(
    'INSERT INTO ai_search_defaults (user_id, capabil' +
      'ity, provider) VALUES (?1, ?2, ?3) ON CONFLICT(u' +
      'ser_id, capability) DO UPDATE SET provider = exc' +
      'luded.provider',
  )
    .bind(userId, cap, id)
    .run()
  return getSettings(env, userId, cap)
}
