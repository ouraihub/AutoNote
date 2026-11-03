import type { Env } from '../env'
import { KitFailure } from './kit'
import {
  capability,
  defaultProvider,
  trimmed,
  resolve,
  assertPublicTarget,
  getPreferences,
  queryProvider,
} from './search-config'
import { validateQuery } from '@ouraihub/aether-core/search'
import { execute } from '@ouraihub/aether-core/search/execution'
import { fetchRequest } from '@ouraihub/aether-core/search/vendor'
import { blocked, parsePage } from './search-policy'
import type { SearchPage, SearchHit } from '@ouraihub/aether-contracts'
import { outbound } from './outbound'
import { badRequest, upstreamFailure } from './kit'

const MAX_URL = 8192
export async function check(
  env: Env,
  userId: string,
  capInput: unknown,
  providerInput: unknown,
  signal?: AbortSignal,
): Promise<{ count: number }> {
  const cap = capability(capInput)
  const id = trimmed(providerInput, 'provider', 64)
  if (cap === 'search') {
    const hits = await queryProvider(env, userId, id, 'AutoNote', signal)
    if (!hits.length) throw upstreamFailure(200, '', [id])
    return { count: hits.length }
  }
  await fetchWithProvider(env, userId, id, 'https://example.com', signal)
  return { count: 1 }
}
export async function search(
  env: Env,
  userId: string,
  queryInput: string,
  signal?: AbortSignal,
): Promise<{ query: string; provider: string; hits: SearchHit[] }> {
  const provider = await defaultProvider(env, userId, 'search'),
    query = validateQuery(queryInput)
  return {
    query,
    provider,
    hits: await queryProvider(env, userId, provider, query, signal),
  }
}
async function fetchWithProvider(
  env: Env,
  userId: string,
  provider: string,
  url: string,
  signal?: AbortSignal,
): Promise<SearchPage> {
  await assertPublicTarget(env.DB, url)
  const config = await resolve(env, userId, 'fetch', provider)
  const preferences = await getPreferences(env, userId)
  if (blocked(url, preferences.blacklist))
    throw badRequest('url', 'blacklisted')
  return execute(
    'fetch',
    config,
    outbound(env),
    signal,
    async (key, execution) => {
      let request = fetchRequest(config, url, key)
      for (let redirects = 0; ; redirects++) {
        const response = await execution.request(request.url, request.init)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          await response.body?.cancel().catch(() => {})
          if (provider !== 'fetch' || !location || redirects >= 5)
            throw upstreamFailure(response.status, '', [])
          const target = new URL(location, request.url).href
          await assertPublicTarget(env.DB, target)
          if (blocked(target, preferences.blacklist))
            throw badRequest('url', 'blacklisted')
          request = {
            url: target,
            init: { headers: { accept: 'text/html, text/plain' } },
          }
          continue
        }
        const page = parsePage(provider, await execution.body(response), url)
        if (blocked(page.url, preferences.blacklist))
          throw badRequest('url', 'blacklisted')
        return {
          ...page,
          content:
            preferences.compression === 'cutoff'
              ? Array.from(page.content)
                  .slice(0, preferences.cutoffLimit)
                  .join('')
              : page.content,
        }
      }
    },
  )
}
export async function fetchPage(
  env: Env,
  userId: string,
  urlInput: string,
  signal?: AbortSignal,
): Promise<SearchPage> {
  const url = trimmed(urlInput, 'url', MAX_URL)
  if (!url) throw new KitFailure('bad_request', 'url is empty')
  return fetchWithProvider(
    env,
    userId,
    await defaultProvider(env, userId, 'fetch'),
    url,
    signal,
  )
}
