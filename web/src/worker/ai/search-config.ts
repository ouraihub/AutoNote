import { execute } from '@ouraihub/aether-core/search/execution'
import type { ResolvedSearchConfig } from '@ouraihub/aether-core/search'
import {
  searchRequest,
  parseSearchResponse,
} from '@ouraihub/aether-core/search/vendor'
import { blocked } from './search-policy'
import type { SearchHit } from '@ouraihub/aether-contracts'
import { outbound } from './outbound'
import type { Env } from '../env'
import { decryptAiKey } from '../lib/crypto'
import { addressAllowed, badRequest, needsConfig, parseTarget } from './kit'
import { KitFailure } from './kit'
import {
  DEFAULTS,
  FETCH_ORDER,
  PROVIDERS,
  SEARCH_ORDER,
  type KeyMode,
  type ProviderSpec,
} from './search-catalog'
export type SearchCap = 'search' | 'fetch'

interface Row {
  provider: string
  baseUrl: string | null
  basicAuthUsername: string | null
}
interface KeyRow {
  id: string
  provider: string
  keyCiphertext: string
  position: number
}
export interface SearchPreferences {
  maxResults: number
  compression: 'none' | 'cutoff'
  cutoffLimit: number
  blacklist: string[]
  modelToolsPreferred: boolean
}
const DEFAULT_PREFERENCES: SearchPreferences = {
  maxResults: 5,
  compression: 'none',
  cutoffLimit: 2000,
  blacklist: [],
  modelToolsPreferred: false,
}
const rotations = new WeakMap<D1Database, Map<string, number>>()
const PROVIDER_BY_ID: Record<string, ProviderSpec> = Object.fromEntries(
  PROVIDERS.map((provider) => [provider.id, provider]),
)
export interface SearchProviderDto {
  id: string
  name: string
  description: string
  officialWebsite?: string
  apiKeyWebsite?: string
  keyMode: KeyMode
  basicAuth: boolean
  defaultBaseUrl?: string
  baseUrl?: string
  keys: { id: string; masked: string }[]
  basicAuthUsername?: string
  ready: boolean
}
export interface SearchSettingsDto {
  capability: SearchCap
  defaultProvider: string
  preferences: SearchPreferences
  providers: SearchProviderDto[]
}

export function capability(value: unknown): SearchCap {
  if (value !== 'search' && value !== 'fetch')
    throw new KitFailure('bad_request', 'invalid capability')
  return value
}
export function providerFor(
  cap: SearchCap,
  id: unknown,
): {
  spec: ProviderSpec
  config: NonNullable<ProviderSpec['search'] | ProviderSpec['fetch']>
} {
  if (typeof id !== 'string')
    throw new KitFailure('bad_request', 'invalid provider')
  const spec = PROVIDER_BY_ID[id]
  if (!spec) throw new KitFailure('bad_request', 'invalid provider')
  const config = cap === 'search' ? spec.search : spec.fetch
  if (!config)
    throw new KitFailure(
      'unsupported',
      `provider ${id} does not support ${cap}`,
    )
  return { spec, config }
}
function mask(value: string): string {
  if (value.length <= 4) return '••••'
  return (
    '' +
    `${value.slice(0, 2)}` +
    '' +
    `${'•'.repeat(Math.min(12, Math.max(4, value.length - 4)))}` +
    '' +
    `${value.slice(-2)}` +
    ''
  )
}
function chars(value: string): number {
  return [...value].length
}
export function trimmed(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string')
    throw new KitFailure('bad_request', `invalid ${field}`)
  const result = value.trim()
  if (chars(result) > max)
    throw new KitFailure('bad_request', `${field} too long`, {
      field,
      limit: max,
    })
  return result
}
export function rowMap(rows: Row[]): Map<string, Row> {
  return new Map(rows.map((row) => [row.provider, row]))
}

export async function rows(
  env: Env,
  userId: string,
  cap: SearchCap,
): Promise<Row[]> {
  return (
    await env.DB.prepare(
      'SELECT provider, base_url AS baseUrl, basic_user' +
        'name AS' +
        (' basicAuthUsername FROM ai_search_provider_confi' +
          'gs WHERE user_id = ?1 AND capability = ?2'),
    )
      .bind(userId, cap)
      .all<Row>()
  ).results
}
export async function keyRows(
  env: Env,
  userId: string,
  cap: SearchCap,
  provider?: string,
): Promise<KeyRow[]> {
  return (
    await env.DB.prepare(
      'SELECT id, provider, key_ciphertext AS keyCipher' +
        'text, position FROM ai_search_keys WHERE user_id' +
        ' = ?1 AND capability = ?2 ' +
        `${provider === undefined ? '' : 'AND provider = ?3'}` +
        ' ORDER BY position, id',
    )
      .bind(userId, cap, ...(provider === undefined ? [] : [provider]))
      .all<KeyRow>()
  ).results
}
export async function getPreferences(
  env: Env,
  userId: string,
): Promise<SearchPreferences> {
  const row = await env.DB.prepare(
    'SELECT preferences FROM ai_search_preferences WH' + 'ERE user_id = ?1',
  )
    .bind(userId)
    .first<{ preferences: string }>()
  return row
    ? (JSON.parse(row.preferences) as SearchPreferences)
    : { ...DEFAULT_PREFERENCES, blacklist: [] }
}
export async function defaultProvider(
  env: Env,
  userId: string,
  cap: SearchCap,
): Promise<string> {
  const row = await env.DB.prepare(
    'SELECT provider FROM ai_search_defaults WHERE us' +
      'er_id = ?1 AND capability = ?2',
  )
    .bind(userId, cap)
    .first<{ provider: string }>()
  return row?.provider ?? DEFAULTS[cap]
}
export async function queryProvider(
  env: Env,
  userId: string,
  provider: string,
  query: string,
  signal?: AbortSignal,
): Promise<SearchHit[]> {
  const config = await resolve(env, userId, 'search', provider)
  const preferences = await getPreferences(env, userId)
  return execute(
    'search',
    config,
    outbound(env),
    signal,
    async (key, execution) => {
      const request = searchRequest(config, query, key)
      const response = await execution.request(request.url, request.init)
      const hits = parseSearchResponse(provider, await execution.body(response))
      const seen = new Set<string>()
      return hits
        .filter((hit) => {
          if (blocked(hit.url, preferences.blacklist) || seen.has(hit.url))
            return false
          seen.add(hit.url)
          return true
        })
        .slice(0, preferences.maxResults)
        .map((hit) =>
          preferences.compression === 'cutoff'
            ? {
                ...hit,
                snippet: Array.from(hit.snippet)
                  .slice(0, preferences.cutoffLimit)
                  .join(''),
              }
            : hit,
        )
    },
  )
}
export async function resolve(
  env: Env,
  userId: string,
  cap: SearchCap,
  id: string,
): Promise<ResolvedSearchConfig> {
  const { config } = providerFor(cap, id)
  const row = rowMap(await rows(env, userId, cap)).get(id)
  const baseUrl = row?.baseUrl || config.defaultBaseUrl || ''
  const keys = await keyRows(env, userId, cap, id)
  if (config.keyMode === 'required' && !keys.length)
    throw needsConfig(`${id} api key`)
  if (!baseUrl && id !== 'fetch') throw needsConfig(`${id} base URL`)
  if (baseUrl) await assertPublicTarget(env.DB, baseUrl)
  let counters = rotations.get(env.DB)
  if (!counters) {
    counters = new Map()
    rotations.set(env.DB, counters)
  }
  const scope = JSON.stringify([userId, cap, id])
  const start = (counters.get(scope) ?? 0) % Math.max(1, keys.length)
  counters.set(scope, (start + 1) % Math.max(1, keys.length))
  const apiKeys: string[] = []
  for (let i = 0; i < keys.length; i++) {
    const key = keys[(start + i) % keys.length]!
    const value = await decryptAiKey(env, key.id, key.keyCiphertext)
    if (!value) throw needsConfig(`${id} api key`)
    apiKeys.push(value)
  }
  return {
    provider: id,
    baseUrl,
    apiKeys,
    ...(row?.basicAuthUsername
      ? { basicAuthUsername: row.basicAuthUsername }
      : {}),
    preferences: { ...(await getPreferences(env, userId)), blacklist: [] },
  }
}

export async function assertPublicTarget(
  db: D1Database,
  raw: string,
): Promise<URL> {
  const target = parseTarget(raw)
  if (!(await addressAllowed(db, target)))
    throw badRequest('url', 'blocked_address')
  return target
}

export async function getSettings(
  env: Env,
  userId: string,
  capInput: unknown,
): Promise<SearchSettingsDto> {
  const cap = capability(capInput)
  const configRows = rowMap(await rows(env, userId, cap))
  const allKeys = await keyRows(env, userId, cap)
  const result: SearchProviderDto[] = []
  for (const id of cap === 'search' ? SEARCH_ORDER : FETCH_ORDER) {
    const { spec, config } = providerFor(cap, id)
    const row = configRows.get(id)
    const keys = await Promise.all(
      allKeys
        .filter((key) => key.provider === id)
        .map(async (key) => {
          const value = await decryptAiKey(env, key.id, key.keyCiphertext)
          if (!value) throw needsConfig(`${id} api key`)
          return { id: key.id, masked: mask(value) }
        }),
    )
    result.push({
      id,
      name: spec.name,
      description: spec.description,
      ...(spec.officialWebsite
        ? { officialWebsite: spec.officialWebsite }
        : {}),
      ...(spec.apiKeyWebsite ? { apiKeyWebsite: spec.apiKeyWebsite } : {}),
      keyMode: config.keyMode,
      basicAuth: spec.basicAuth,
      ...(config.defaultBaseUrl
        ? { defaultBaseUrl: config.defaultBaseUrl }
        : {}),
      ...(row?.baseUrl ? { baseUrl: row.baseUrl } : {}),
      keys,
      ...(row?.basicAuthUsername
        ? { basicAuthUsername: row.basicAuthUsername }
        : {}),
      ready:
        (config.keyMode !== 'required' || keys.length > 0) &&
        (id === 'fetch' || Boolean(row?.baseUrl || config.defaultBaseUrl)),
    })
  }
  return {
    capability: cap,
    defaultProvider: await defaultProvider(env, userId, cap),
    preferences: await getPreferences(env, userId),
    providers: result,
  }
}

export function fields(input: object, allowed: string[]): void {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !allowed.includes(key))
  )
    throw new KitFailure('bad_request', 'invalid search settings')
}

export function normalizeRule(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    chars(value) > 256 ||
    /[\s\x00-\x1f\x7f\[\]\\^{}|#]/.test(value)
  )
    throw new KitFailure('bad_request', 'invalid blacklist rule')
  const parts = value.match(/^(https?|\*):\/\/([^/]+)(\/.*)?$/i)
  const hostPort = parts ? parts[2]! : value
  const hostMatch = hostPort.match(/^([^:]+)(?::([0-9]+))?$/)
  if (
    !hostMatch ||
    (!parts && hostMatch[2]) ||
    (hostMatch[2] && (Number(hostMatch[2]) < 1 || Number(hostMatch[2]) > 65535))
  )
    throw new KitFailure('bad_request', 'invalid blacklist rule')
  const host = hostMatch[1]!.toLowerCase().replace(/\.$/, '')
  if (
    host.length > 253 ||
    host
      .split('.')
      .some(
        (label) =>
          !label ||
          label.length > 63 ||
          !/^[a-z0-9*?](?:[a-z0-9*?-]*[a-z0-9*?])?$/.test(label),
      )
  )
    throw new KitFailure('bad_request', 'invalid blacklist rule')
  if (!parts && /[/:@#]/.test(value))
    throw new KitFailure('bad_request', 'invalid blacklist rule')
  return parts
    ? parts[1]!.toLowerCase() +
        '://' +
        host +
        (hostMatch[2] ? ':' + hostMatch[2] : '') +
        (parts[3] ?? '/')
    : host
}
