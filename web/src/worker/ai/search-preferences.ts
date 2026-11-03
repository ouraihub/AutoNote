import type { Env } from '../env'
import { fields, normalizeRule, type SearchPreferences } from './search-config'
import { KitFailure } from './kit'

const MAX_RESULTS = 50

export async function savePreferences(
  env: Env,
  userId: string,
  input: SearchPreferences,
): Promise<SearchPreferences> {
  fields(input, [
    'maxResults',
    'compression',
    'cutoffLimit',
    'blacklist',
    'modelToolsPreferred',
  ])
  if (
    !Number.isInteger(input.maxResults) ||
    input.maxResults < 1 ||
    input.maxResults > MAX_RESULTS ||
    !['none', 'cutoff'].includes(input.compression) ||
    !Number.isInteger(input.cutoffLimit) ||
    input.cutoffLimit < 100 ||
    input.cutoffLimit > 20000 ||
    typeof input.modelToolsPreferred !== 'boolean' ||
    !Array.isArray(input.blacklist) ||
    input.blacklist.length > 32
  )
    throw new KitFailure('bad_request', 'invalid search preferences')
  const preferences: SearchPreferences = {
    ...input,
    blacklist: input.blacklist.map(normalizeRule),
  }
  await env.DB.prepare(
    'INSERT INTO ai_search_preferences (user_id, pref' +
      'erences) VALUES (?1, ?2)' +
      (' ON CONFLICT(user_id) DO UPDATE SET preferences ' +
        '= excluded.preferences'),
  )
    .bind(userId, JSON.stringify(preferences))
    .run()
  return preferences
}
