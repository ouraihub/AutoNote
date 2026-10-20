import type { Env } from '../env'
import { decryptAiKey, encryptAiKey } from '../lib/crypto'
import { requireCurrentPassword } from '../lib/reauth'
import { newId } from '../lib/id'
import { addressAllowed, badRequest, internal, needsConfig, parseTarget, readUpTo, upstreamFailure } from './kit'
import { KitFailure } from './kit'

export type SearchCap = 'search' | 'fetch'
type KeyMode = 'required' | 'optional' | 'none'
interface ProviderSpec { id: string; name: string; description: string; officialWebsite?: string; apiKeyWebsite?: string; basicAuth: boolean; search?: { defaultBaseUrl?: string; keyMode: KeyMode }; fetch?: { defaultBaseUrl?: string; keyMode: KeyMode } }

const p = (id: string, name: string, description: string, spec: Partial<ProviderSpec> & Pick<ProviderSpec, 'basicAuth'>): ProviderSpec => ({ id, name, description, ...spec })
export const PROVIDERS: readonly ProviderSpec[] = [
  p('zhipu', '智谱 Zhipu', '智谱 GLM Web Search，提供联网搜索与实时信息检索。', { basicAuth: false, officialWebsite: 'https://docs.bigmodel.cn/cn/guide/tools/web-search', apiKeyWebsite: 'https://www.bigmodel.cn/invite?icode=X2d48dEyAbBOUJCLpZmYJUjPr3uHog9F4g5tjuOUqno%3D', search: { defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search', keyMode: 'required' } }),
  p('tavily', 'Tavily', '专为 LLM 优化的搜索引擎。', { basicAuth: false, officialWebsite: 'https://tavily.com', apiKeyWebsite: 'https://app.tavily.com/home', search: { defaultBaseUrl: 'https://api.tavily.com', keyMode: 'required' } }),
  p('searxng', 'SearXNG', '可自托管的免费互联网元搜索引擎，聚合多个搜索源。', { basicAuth: true, officialWebsite: 'https://docs.searxng.org', search: { defaultBaseUrl: 'http://localhost:8080', keyMode: 'none' } }),
  p('exa', 'Exa', '为 AI 应用设计的神经搜索 API，擅长语义检索高质量网页。', { basicAuth: false, officialWebsite: 'https://exa.ai', apiKeyWebsite: 'https://dashboard.exa.ai/api-keys', search: { defaultBaseUrl: 'https://api.exa.ai', keyMode: 'required' } }),
  p('exa-mcp', 'Exa MCP', '通过 Exa MCP Server 免费使用 Exa 搜索，不填密钥也能用。', { basicAuth: false, officialWebsite: 'https://exa.ai', search: { defaultBaseUrl: 'https://mcp.exa.ai/mcp', keyMode: 'optional' } }),
  p('bocha', '博查 Bocha', '面向 AI 场景的中文搜索 API，提供实时网页与结构化结果。', { basicAuth: false, officialWebsite: 'https://bochaai.com', apiKeyWebsite: 'https://open.bochaai.com/overview', search: { defaultBaseUrl: 'https://api.bochaai.com', keyMode: 'required' } }),
  p('querit', 'Querit', 'Querit 搜索与内容接口，用于关键词检索与网页正文提取。', { basicAuth: false, officialWebsite: 'https://querit.ai', apiKeyWebsite: 'https://www.querit.ai/en/dashboard/api-keys', search: { defaultBaseUrl: 'https://api.querit.ai', keyMode: 'required' }, fetch: { defaultBaseUrl: 'https://api.querit.ai', keyMode: 'required' } }),
  p('brave', 'Brave Search', 'Brave 独立索引的网页搜索 API。', { basicAuth: false, officialWebsite: 'https://brave.com/search/api/', apiKeyWebsite: 'https://api-dashboard.search.brave.com/app/keys', search: { defaultBaseUrl: 'https://api.search.brave.com', keyMode: 'required' } }),
  p('parallel', 'Parallel', '面向 AI 智能体的网页搜索 API，返回按相关性排序的链接与高密度摘录。', { basicAuth: false, officialWebsite: 'https://parallel.ai', apiKeyWebsite: 'https://platform.parallel.ai', search: { defaultBaseUrl: 'https://api.parallel.ai', keyMode: 'required' } }),
  p('jina', 'Jina', 'Jina Reader 搜索与阅读接口，用于检索并提取网页正文。', { basicAuth: false, officialWebsite: 'https://jina.ai/reader', apiKeyWebsite: 'https://jina.ai', search: { defaultBaseUrl: 'https://s.jina.ai', keyMode: 'required' }, fetch: { defaultBaseUrl: 'https://r.jina.ai', keyMode: 'optional' } }),
  p('firecrawl', 'Firecrawl', 'Firecrawl 网页抓取与搜索服务，支持将网页转换为 Markdown 格式。', { basicAuth: false, officialWebsite: 'https://firecrawl.dev', apiKeyWebsite: 'https://firecrawl.dev/app/api-keys', search: { defaultBaseUrl: 'https://api.firecrawl.dev', keyMode: 'optional' }, fetch: { defaultBaseUrl: 'https://api.firecrawl.dev', keyMode: 'optional' } }),
  p('fetch', '内置直连', '内置 URL 获取，直接请求网页并提取正文，不需要密钥。', { basicAuth: false, fetch: { keyMode: 'none' } }),
]
const SEARCH_ORDER = ['zhipu', 'tavily', 'searxng', 'exa', 'exa-mcp', 'bocha', 'querit', 'brave', 'parallel', 'jina', 'firecrawl']
const FETCH_ORDER = ['querit', 'fetch', 'jina', 'firecrawl']
const DEFAULTS: Record<SearchCap, string> = { search: 'exa-mcp', fetch: 'jina' }
const MAX_RESULTS = 50
const MAX_QUERY = 4096
const MAX_URL = 8192
const MAX_BODY = 2 * 1024 * 1024
const MAX_ERROR = 8 * 1024
const TIMEOUT = 15_000

interface Row { provider: string; baseUrl: string | null; basicAuthUsername: string | null }
interface KeyRow { id: string; provider: string; keyCiphertext: string; position: number }
interface Runtime { spec: ProviderSpec; capability: SearchCap; baseUrl: string; key: string | null; basicAuthUsername: string | null; maxResults: number }
export interface SearchPreferences { maxResults: number; compression: 'none' | 'cutoff'; cutoffLimit: number; blacklist: string[]; modelToolsPreferred: boolean }
const DEFAULT_PREFERENCES: SearchPreferences = { maxResults: 5, compression: 'none', cutoffLimit: 2000, blacklist: [], modelToolsPreferred: false }
const rotations = new WeakMap<D1Database, Map<string, number>>()
const PROVIDER_BY_ID: Record<string, ProviderSpec> = Object.fromEntries(PROVIDERS.map((provider) => [provider.id, provider]))
export interface SearchProviderDto {
  id: string; name: string; description: string; officialWebsite?: string; apiKeyWebsite?: string; keyMode: KeyMode; basicAuth: boolean; defaultBaseUrl?: string; baseUrl?: string; keys: { id: string; masked: string }[]; basicAuthUsername?: string; ready: boolean
}
export interface SearchSettingsDto { capability: SearchCap; defaultProvider: string; preferences: SearchPreferences; providers: SearchProviderDto[] }

function capability(value: unknown): SearchCap {
  if (value !== 'search' && value !== 'fetch') throw new KitFailure('bad_request', 'invalid capability')
  return value
}
function providerFor(cap: SearchCap, id: unknown): { spec: ProviderSpec; config: NonNullable<ProviderSpec['search'] | ProviderSpec['fetch']> } {
  if (typeof id !== 'string') throw new KitFailure('bad_request', 'invalid provider')
  const spec = PROVIDER_BY_ID[id]
  if (!spec) throw new KitFailure('bad_request', 'invalid provider')
  const config = cap === 'search' ? spec.search : spec.fetch
  if (!config) throw new KitFailure('unsupported', `provider ${id} does not support ${cap}`)
  return { spec, config }
}
function mask(value: string): string {
  if (value.length <= 4) return '••••'
  return `${value.slice(0, 2)}${'•'.repeat(Math.min(12, Math.max(4, value.length - 4)))}${value.slice(-2)}`
}
function chars(value: string): number { return [...value].length }
function trimmed(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new KitFailure('bad_request', `invalid ${field}`)
  const result = value.trim()
  if (chars(result) > max) throw new KitFailure('bad_request', `${field} too long`, { field, limit: max })
  return result
}
function rowMap(rows: Row[]): Map<string, Row> { return new Map(rows.map((row) => [row.provider, row])) }

async function rows(env: Env, userId: string, cap: SearchCap): Promise<Row[]> {
  return (await env.DB.prepare(`SELECT provider, base_url AS baseUrl, basic_username AS basicAuthUsername FROM ai_search_provider_configs WHERE user_id = ?1 AND capability = ?2`).bind(userId, cap).all<Row>()).results
}
async function keyRows(env: Env, userId: string, cap: SearchCap, provider?: string): Promise<KeyRow[]> {
  return (await env.DB.prepare(`SELECT id, provider, key_ciphertext AS keyCiphertext, position FROM ai_search_keys WHERE user_id = ?1 AND capability = ?2 ${provider === undefined ? '' : 'AND provider = ?3'} ORDER BY position, id`).bind(userId, cap, ...(provider === undefined ? [] : [provider])).all<KeyRow>()).results
}
export async function getPreferences(env: Env, userId: string): Promise<SearchPreferences> {
  const row = await env.DB.prepare('SELECT preferences FROM ai_search_preferences WHERE user_id = ?1').bind(userId).first<{ preferences: string }>()
  return row ? JSON.parse(row.preferences) as SearchPreferences : { ...DEFAULT_PREFERENCES, blacklist: [] }
}
async function defaultProvider(env: Env, userId: string, cap: SearchCap): Promise<string> {
  const row = await env.DB.prepare(`SELECT provider FROM ai_search_defaults WHERE user_id = ?1 AND capability = ?2`).bind(userId, cap).first<{ provider: string }>()
  return row?.provider ?? DEFAULTS[cap]
}
async function execute<T>(env: Env, userId: string, cap: SearchCap, id: string, signal: AbortSignal | undefined, action: (run: Runtime, executionSignal: AbortSignal) => Promise<T>): Promise<T> {
  const { spec, config } = providerFor(cap, id)
  const row = rowMap(await rows(env, userId, cap)).get(id)
  const baseUrl = row?.baseUrl || config.defaultBaseUrl || ''
  const keys = await keyRows(env, userId, cap, id)
  if (config.keyMode === 'required' && !keys.length) throw needsConfig(`${id} api key`)
  if (!baseUrl && id !== 'fetch') throw needsConfig(`${id} base URL`)
  if (baseUrl) await assertPublicTarget(env.DB, baseUrl)
  const preferences = await getPreferences(env, userId)
  let counters = rotations.get(env.DB)
  if (!counters) { counters = new Map(); rotations.set(env.DB, counters) }
  const scope = JSON.stringify([userId, cap, id])
  const start = (counters.get(scope) ?? 0) % Math.max(1, keys.length)
  counters.set(scope, (start + 1) % Math.max(1, keys.length))
  const deadline = Date.now() + (cap === 'fetch' ? 20_000 : id === 'exa-mcp' ? 25_000 : TIMEOUT)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  const timer = setTimeout(abort, Math.max(0, deadline - Date.now()))
  try {
    for (let attempt = 0; attempt < Math.max(1, keys.length); attempt++) {
      if (controller.signal.aborted) throw new KitFailure(signal?.aborted ? 'cancelled' : 'timeout', 'search execution aborted')
      const keyRow = keys[(start + attempt) % keys.length]
      const key = keyRow ? await decryptAiKey(env, keyRow.id, keyRow.keyCiphertext) : null
      if (keyRow && !key) throw needsConfig(`${id} api key`)
      try { return await action({ spec, capability: cap, baseUrl, key, basicAuthUsername: row?.basicAuthUsername || null, maxResults: preferences.maxResults }, controller.signal) }
      catch (error) {
        if (controller.signal.aborted) throw new KitFailure(signal?.aborted ? 'cancelled' : 'timeout', 'search execution aborted')
        if (!(error instanceof KitFailure) || ![401, 403, 429].includes(Number(error.details.status)) || attempt + 1 >= keys.length) throw error
      }
    }
    throw new KitFailure('upstream', 'search execution failed')
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

async function assertPublicTarget(db: D1Database, raw: string): Promise<URL> {
  const target = parseTarget(raw)
  if (!(await addressAllowed(db, target))) throw badRequest('url', 'blocked_address')
  return target
}

export async function getSettings(env: Env, userId: string, capInput: unknown): Promise<SearchSettingsDto> {
  const cap = capability(capInput)
  const configRows = rowMap(await rows(env, userId, cap))
  const allKeys = await keyRows(env, userId, cap)
  const result: SearchProviderDto[] = []
  for (const id of cap === 'search' ? SEARCH_ORDER : FETCH_ORDER) {
    const { spec, config } = providerFor(cap, id)
    const row = configRows.get(id)
    const keys = await Promise.all(allKeys.filter((key) => key.provider === id).map(async (key) => {
      const value = await decryptAiKey(env, key.id, key.keyCiphertext)
      if (!value) throw needsConfig(`${id} api key`)
      return { id: key.id, masked: mask(value) }
    }))
    result.push({ id, name: spec.name, description: spec.description, ...(spec.officialWebsite ? { officialWebsite: spec.officialWebsite } : {}), ...(spec.apiKeyWebsite ? { apiKeyWebsite: spec.apiKeyWebsite } : {}), keyMode: config.keyMode, basicAuth: spec.basicAuth, ...(config.defaultBaseUrl ? { defaultBaseUrl: config.defaultBaseUrl } : {}), ...(row?.baseUrl ? { baseUrl: row.baseUrl } : {}), keys, ...(row?.basicAuthUsername ? { basicAuthUsername: row.basicAuthUsername } : {}), ready: (config.keyMode !== 'required' || keys.length > 0) && (id === 'fetch' || Boolean(row?.baseUrl || config.defaultBaseUrl)) })
  }
  return { capability: cap, defaultProvider: await defaultProvider(env, userId, cap), preferences: await getPreferences(env, userId), providers: result }
}

function fields(input: object, allowed: string[]): void {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key))) throw new KitFailure('bad_request', 'invalid search settings')
}

function normalizeRule(value: unknown): string {
  if (typeof value !== 'string' || !value || chars(value) > 256 || /[\s\x00-\x1f\x7f\[\]\\^{}|#]/.test(value)) throw new KitFailure('bad_request', 'invalid blacklist rule')
  const parts = value.match(/^(https?|\*):\/\/([^/]+)(\/.*)?$/i)
  const hostPort = parts ? parts[2]! : value
  const hostMatch = hostPort.match(/^([^:]+)(?::([0-9]+))?$/)
  if (!hostMatch || (!parts && hostMatch[2]) || (hostMatch[2] && (Number(hostMatch[2]) < 1 || Number(hostMatch[2]) > 65535))) throw new KitFailure('bad_request', 'invalid blacklist rule')
  const host = hostMatch[1]!.toLowerCase().replace(/\.$/, '')
  if (host.length > 253 || host.split('.').some((label) => !label || label.length > 63 || !/^[a-z0-9*?](?:[a-z0-9*?-]*[a-z0-9*?])?$/.test(label))) throw new KitFailure('bad_request', 'invalid blacklist rule')
  if (!parts && /[/:@#]/.test(value)) throw new KitFailure('bad_request', 'invalid blacklist rule')
  return parts ? parts[1]!.toLowerCase() + '://' + host + (hostMatch[2] ? ':' + hostMatch[2] : '') + (parts[3] ?? '/') : host
}
export async function savePreferences(env: Env, userId: string, input: SearchPreferences): Promise<SearchPreferences> {
  fields(input, ['maxResults', 'compression', 'cutoffLimit', 'blacklist', 'modelToolsPreferred'])
  if (!Number.isInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > MAX_RESULTS || !['none', 'cutoff'].includes(input.compression) || !Number.isInteger(input.cutoffLimit) || input.cutoffLimit < 100 || input.cutoffLimit > 20000 || typeof input.modelToolsPreferred !== 'boolean' || !Array.isArray(input.blacklist) || input.blacklist.length > 32) throw new KitFailure('bad_request', 'invalid search preferences')
  const preferences: SearchPreferences = { ...input, blacklist: input.blacklist.map(normalizeRule) }
  await env.DB.prepare('INSERT INTO ai_search_preferences (user_id, preferences) VALUES (?1, ?2) ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences').bind(userId, JSON.stringify(preferences)).run()
  return preferences
}
function glob(pattern: string, value: string): boolean {
  let p = 0; let v = 0; let star = -1; let retry = 0
  while (v < value.length) {
    if (pattern[p] === '?' || pattern[p] === value[v]) { p++; v++ }
    else if (pattern[p] === '*') { star = p++; retry = v }
    else if (star >= 0) { p = star + 1; v = ++retry }
    else return false
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
function blocked(raw: string, rules: string[]): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return true }
  if (!['http:', 'https:'].includes(url.protocol)) return true
  return rules.some((rule) => {
    if (rule.includes('://')) return glob(rule, url.href)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    return rule.includes('*') || rule.includes('?') ? glob(rule, host) : host === rule || host.endsWith('.' + rule)
  })
}
function processHits(hits: SearchHit[], preferences: SearchPreferences): SearchHit[] {
  return hits.filter((hit) => !blocked(hit.url, preferences.blacklist)).slice(0, preferences.maxResults).map((hit) => preferences.compression === 'cutoff' ? { ...hit, snippet: truncate(hit.snippet, preferences.cutoffLimit) } : hit)
}
export async function saveProvider(env: Env, userId: string, input: { capability?: unknown; provider?: unknown; baseUrl?: unknown; basicAuthUsername?: unknown }): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider', 'baseUrl', 'basicAuthUsername'])
  const cap = capability(input.capability)
  const id = trimmed(input.provider, 'provider', 64)
  const { spec } = providerFor(cap, id)
  const baseUrl = input.baseUrl === undefined ? undefined : trimmed(input.baseUrl, 'baseUrl', MAX_URL)
  if (baseUrl) await assertPublicTarget(env.DB, baseUrl)
  const username = input.basicAuthUsername === undefined ? undefined : trimmed(input.basicAuthUsername, 'basicAuthUsername', 200)
  if (username !== undefined && !spec.basicAuth) throw badRequest('basicAuthUsername', 'unsupported')
  const old = rowMap(await rows(env, userId, cap)).get(id)
  await env.DB.prepare(`INSERT INTO ai_search_provider_configs (user_id, capability, provider, base_url, basic_username) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(user_id, capability, provider) DO UPDATE SET base_url = excluded.base_url, basic_username = excluded.basic_username`).bind(userId, cap, id, baseUrl === undefined ? old?.baseUrl ?? null : baseUrl || null, username === undefined ? old?.basicAuthUsername ?? null : username || null).run()
  return getSettings(env, userId, cap)
}
export async function setDefault(env: Env, userId: string, input: { capability?: unknown; provider?: unknown }): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider'])
  const cap = capability(input.capability)
  const id = trimmed(input.provider, 'provider', 64)
  providerFor(cap, id)
  await env.DB.prepare(`INSERT INTO ai_search_defaults (user_id, capability, provider) VALUES (?1, ?2, ?3) ON CONFLICT(user_id, capability) DO UPDATE SET provider = excluded.provider`).bind(userId, cap, id).run()
  return getSettings(env, userId, cap)
}
export async function saveKey(env: Env, userId: string, input: { capability?: unknown; provider?: unknown; value?: unknown; keyId?: unknown }): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider', 'value', 'keyId'])
  const cap = capability(input.capability)
  const provider = trimmed(input.provider, 'provider', 64)
  const { spec, config } = providerFor(cap, provider)
  if (config.keyMode === 'none' && !spec.basicAuth) throw new KitFailure('bad_request', 'provider does not accept keys')
  const value = trimmed(input.value, 'value', 4096)
  if (value.length > 4096) throw new KitFailure('bad_request', 'key too long')
  if (!value) throw new KitFailure('bad_request', 'key is empty')
  const keys = await keyRows(env, userId, cap, provider)
  const keyId = input.keyId === undefined ? newId() : trimmed(input.keyId, 'keyId', 64)
  if (input.keyId !== undefined && !keys.some((key) => key.id === keyId)) throw new KitFailure('bad_request', 'unknown key')
  if (input.keyId === undefined && keys.length >= 16) throw new KitFailure('bad_request', 'key limit reached')
  const cipher = await encryptAiKey(env, keyId, value)
  if (input.keyId === undefined) {
    const position = keys.length ? keys[keys.length - 1]!.position + 1 : 0
    await env.DB.prepare(`INSERT INTO ai_search_keys (id, user_id, capability, provider, key_ciphertext, position) SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE (SELECT COUNT(*) FROM ai_search_keys WHERE user_id = ?2 AND capability = ?3 AND provider = ?4) < 16`).bind(keyId, userId, cap, provider, cipher, position).run()
    if (!(await keyRows(env, userId, cap, provider)).some((key) => key.id === keyId)) throw new KitFailure('bad_request', 'key limit reached')
  } else await env.DB.prepare(`UPDATE ai_search_keys SET key_ciphertext = ?1 WHERE id = ?2 AND user_id = ?3 AND capability = ?4 AND provider = ?5`).bind(cipher, keyId, userId, cap, provider).run()
  return getSettings(env, userId, cap)
}
export async function removeKey(env: Env, userId: string, input: { capability?: unknown; provider?: unknown; keyId?: unknown }): Promise<SearchSettingsDto> {
  fields(input, ['capability', 'provider', 'keyId'])
  const cap = capability(input.capability)
  const provider = trimmed(input.provider, 'provider', 64)
  providerFor(cap, provider)
  const keyId = trimmed(input.keyId, 'keyId', 64)
  if (!(await keyRows(env, userId, cap, provider)).some((key) => key.id === keyId)) throw new KitFailure('bad_request', 'unknown key')
  await env.DB.prepare('DELETE FROM ai_search_keys WHERE id = ?1 AND user_id = ?2 AND capability = ?3 AND provider = ?4').bind(keyId, userId, cap, provider).run()
  return getSettings(env, userId, cap)
}
export async function reveal(env: Env, userId: string, input: { capability?: unknown; provider?: unknown; keyId?: unknown; currentPassword?: unknown }): Promise<string> {
  fields(input, ['capability', 'provider', 'keyId', 'currentPassword'])
  const cap = capability(input.capability)
  const provider = trimmed(input.provider, 'provider', 64)
  providerFor(cap, provider)
  const keyId = trimmed(input.keyId, 'keyId', 64)
  await requireCurrentPassword(env.DB, userId, input.currentPassword)
  const row = (await keyRows(env, userId, cap, provider)).find((key) => key.id === keyId)
  if (!row) throw new KitFailure('bad_request', 'unknown key')
  const value = await decryptAiKey(env, row.id, row.keyCiphertext)
  if (!value) throw needsConfig('api key')
  return value
}

export async function check(env: Env, userId: string, capInput: unknown, providerInput: unknown, signal?: AbortSignal): Promise<{ count: number }> {
  const cap = capability(capInput)
  const id = trimmed(providerInput, 'provider', 64)
  if (cap === 'search') {
    const result = await execute(env, userId, cap, id, signal, (run, executionSignal) => doSearch(run, 'AutoNote', executionSignal))
    const hits = processHits(result.hits, await getPreferences(env, userId))
    if (!hits.length) throw upstreamFailure(200, '', [id])
    return { count: hits.length }
  }
  await fetchWithProvider(env, userId, id, 'https://example.com', signal)
  return { count: 1 }
}
export async function search(env: Env, userId: string, queryInput: string, signal?: AbortSignal): Promise<{ query: string; provider: string; hits: SearchHit[] }> {
  const query = trimmed(queryInput, 'query', MAX_QUERY)
  if (!query) throw new KitFailure('bad_request', 'query is empty')
  const provider = await defaultProvider(env, userId, 'search')
  const result = await execute(env, userId, 'search', provider, signal, (run, executionSignal) => doSearch(run, query, executionSignal))
  return { query, provider, hits: processHits(result.hits, await getPreferences(env, userId)) }
}
async function fetchWithProvider(env: Env, userId: string, provider: string, url: string, signal?: AbortSignal): Promise<SearchPage> {
  await assertPublicTarget(env.DB, url)
  const preferences = await getPreferences(env, userId)
  if (blocked(url, preferences.blacklist)) throw badRequest('url', 'blacklisted')
  const page = await execute(env, userId, 'fetch', provider, signal, (run, executionSignal) => doFetch(run, url, executionSignal, env.DB, preferences.blacklist))
  if (blocked(page.url, preferences.blacklist)) throw badRequest('url', 'blacklisted')
  return { ...page, content: preferences.compression === 'cutoff' ? truncate(page.content, preferences.cutoffLimit) : page.content }
}
export async function fetchPage(env: Env, userId: string, urlInput: string, signal?: AbortSignal): Promise<SearchPage> {
  const url = trimmed(urlInput, 'url', MAX_URL)
  if (!url) throw new KitFailure('bad_request', 'url is empty')
  return fetchWithProvider(env, userId, await defaultProvider(env, userId, 'fetch'), url, signal)
}

export interface SearchHit { title: string; url: string; snippet: string }
export interface SearchPage { title: string; url: string; content: string }

async function request(url: string, init: RequestInit, signal?: AbortSignal, timeout = TIMEOUT, known: string[] = [], follow?: (url: string) => Promise<boolean>): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    let current = url
    let response: Response
    for (let redirects = 0; ; redirects++) {
      response = await fetch(current, { ...init, redirect: 'manual', signal: controller.signal })
      if (response.status < 300 || response.status >= 400) break
      const location = response.headers.get('Location')
      if (!location || !follow || redirects >= 5) throw upstreamFailure(response.status, '', ['redirect'])
      const next = new URL(location, current).toString()
      if (!(await follow(next))) throw badRequest('url', 'blocked_address')
      current = next
    }
    const { bytes, overflow } = await readUpTo(response.body, MAX_BODY)
    const body = new TextDecoder().decode(bytes)
    if (overflow) throw new KitFailure('upstream', 'upstream response too large', { limit: MAX_BODY })
    if (!response.ok) throw upstreamFailure(response.status, body.slice(0, MAX_ERROR), known)
    return body
  } catch (error) {
    if (error instanceof KitFailure) throw error
    if (controller.signal.aborted) throw signal?.aborted ? new KitFailure('cancelled', 'cancelled') : new KitFailure('timeout', 'upstream timeout')
    throw internal(error)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
function authHeaders(run: Runtime, kind: 'bearer' | 'api' = 'bearer'): Record<string, string> {
  if (!run.key) return {}
  return kind === 'api' ? { 'x-api-key': run.key } : { authorization: `Bearer ${run.key}` }
}
function basic(run: Runtime): Record<string, string> {
  if (!run.basicAuthUsername) return {}
  return { authorization: `Basic ${btoa(`${run.basicAuthUsername}:${run.key ?? ''}`)}` }
}
function jsonHeaders(run: Runtime, kind: 'bearer' | 'api' = 'bearer'): Record<string, string> { return { accept: 'application/json', 'content-type': 'application/json', ...authHeaders(run, kind) } }
function rawText(value: unknown, ...keys: string[]): string {
  if (!value || typeof value !== 'object') return ''
  for (const key of keys) {
    const found = (value as Record<string, unknown>)[key]
    if (typeof found === 'string' && found.trim()) return found.trim()
    if (Array.isArray(found)) {
      const joined = found.filter((part): part is string => typeof part === 'string').join(' ').trim()
      if (joined) return joined
    }
  }
  return ''
}
function at(value: unknown, path: string): unknown { return path.split('/').filter(Boolean).reduce((current: unknown, key) => current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value) }
function truncate(value: string, limit: number): string { return Array.from(value).slice(0, limit).join('') }
function parseJson(body: string, provider: string): Record<string, unknown> { try { const value: unknown = JSON.parse(body); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown> } catch { throw new KitFailure('upstream', `${provider} returned invalid JSON`) } }
function providerError(run: Runtime, payload: Record<string, unknown>): void {
  const failed = run.spec.id === 'bocha' && typeof payload.code === 'number' && payload.code !== 200 || run.spec.id === 'querit' && typeof payload.error_code === 'number' && payload.error_code !== 200 || run.spec.id === 'firecrawl' && payload.success === false
  if (failed) throw new KitFailure('upstream', `${run.spec.name} returned an error`)
}
function collect(items: unknown[], limit: number): SearchHit[] {
  const seen = new Set<string>(); const result: SearchHit[] = []
  for (const item of items) {
    if (result.length >= limit) break
    if (!item || typeof item !== 'object') continue
    const url = rawText(item, 'url', 'link'); if (!/^https?:\/\//i.test(url) || seen.has(url)) continue
    seen.add(url); result.push({ title: rawText(item, 'title', 'name') || url, url, snippet: rawText(item, 'content', 'text', 'snippet', 'description', 'excerpts', 'summary', 'markdown') })
  }
  return result
}
async function doSearch(run: Runtime, query: string, signal?: AbortSignal): Promise<{ hits: SearchHit[] }> {
  const base = run.baseUrl.replace(/\/+$/, ''); const count = run.maxResults
  let url = base; let init: RequestInit = {}
  switch (run.spec.id) {
    case 'zhipu': init = { method: 'POST', headers: jsonHeaders(run), body: JSON.stringify({ search_query: query, search_engine: 'search_std', search_intent: false }) }; break
    case 'tavily': url += '/search'; init = { method: 'POST', headers: jsonHeaders(run), body: JSON.stringify({ query, max_results: count }) }; break
    case 'searxng': url += '/search?q=' + encodeURIComponent(query) + '&format=json&language=auto'; init = { headers: { accept: 'application/json', ...basic(run) } }; break
    case 'exa': url += '/search'; init = { method: 'POST', headers: jsonHeaders(run, 'api'), body: JSON.stringify({ query, numResults: count, contents: { text: true } }) }; break
    case 'exa-mcp': init = { method: 'POST', headers: { ...jsonHeaders(run, 'api'), accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: { query, type: 'auto', numResults: count, livecrawl: 'fallback' } } }) }; break
    case 'bocha': url += '/v1/web-search'; init = { method: 'POST', headers: jsonHeaders(run), body: JSON.stringify({ query, count, exclude: '', summary: true }) }; break
    case 'querit': url += '/v1/search'; init = { method: 'POST', headers: jsonHeaders(run), body: JSON.stringify({ query, count }) }; break
    case 'brave': url += '/res/v1/web/search?q=' + encodeURIComponent(query) + '&count=' + Math.min(20, count); init = { headers: { accept: 'application/json', 'x-subscription-token': run.key ?? '' } }; break
    case 'parallel': url += '/v1/search'; init = { method: 'POST', headers: jsonHeaders(run, 'api'), body: JSON.stringify({ objective: query, search_queries: [query], advanced_settings: { max_results: count } }) }; break
    case 'jina': url += '/' + encodeURIComponent(query); init = { headers: { accept: 'application/json', ...authHeaders(run) } }; break
    case 'firecrawl': url += '/v2/search'; init = { method: 'POST', headers: jsonHeaders(run), body: JSON.stringify({ query, limit: count, scrapeOptions: { formats: ['markdown'] } }) }; break
    default: throw new KitFailure('unsupported', `unsupported provider ${run.spec.id}`)
  }
  const body = await request(url, init, signal, run.spec.id === 'exa-mcp' ? 25_000 : TIMEOUT, [run.key ?? '', run.basicAuthUsername ?? ''])
  if (run.spec.id === 'exa-mcp') return { hits: parseMcp(body, Number.POSITIVE_INFINITY) }
  return { hits: parseSearchResponse(run.spec.id, run.spec.name, body, Number.POSITIVE_INFINITY) }
}

export function parseSearchResponse(provider: string, name: string, body: string, limit: number): SearchHit[] {
  const payload = parseJson(body, name); providerError({ spec: { id: provider, name } as ProviderSpec } as Runtime, payload)
  const paths: Record<string, string[]> = { zhipu: ['/search_result'], bocha: ['/data/webPages/value'], querit: ['/results/result'], brave: ['/web/results'], parallel: ['/results'], jina: ['/data', '/results'], firecrawl: ['/data/web'], tavily: ['/results'], exa: ['/results'], searxng: ['/results'] }
  const rawList = (paths[provider] ?? ['/results']).map((path) => at(payload, path)).find((value) => Array.isArray(value))
  if (!Array.isArray(rawList)) throw new KitFailure('upstream', `${name} returned an invalid result shape`)
  return collect(rawList, limit)
}
export function parseMcp(body: string, limit: number): SearchHit[] {
  const values = body.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6).trim()).filter(Boolean).map((line) => { try { return JSON.parse(line) as unknown } catch { return null } }).filter(Boolean)
  const raw = values.map((value) => at(value, '/result/content')).flatMap((items) => Array.isArray(items) ? items.map((item) => rawText(item, 'text')) : []).join('\n\n') || body
  return collect(raw.split(/\r?\n(?=Title:)/).map((chunk) => { const title = chunk.match(/^Title:\s*(.*)$/m)?.[1] ?? ''; const url = chunk.match(/^URL:\s*(.*)$/m)?.[1] ?? ''; const snippet = chunk.match(/^(?:Text|Highlights):[^\S\r\n]*([\s\S]*)$/m)?.[1]?.trim() ?? ''; return { title, url, snippet } }), limit)
}
async function doFetch(run: Runtime, target: string, signal?: AbortSignal, db?: D1Database, blacklist: string[] = []): Promise<SearchPage> {
  parseTarget(target)
  const base = run.baseUrl.replace(/\/+$/, ''); let url = base; let init: RequestInit = {}
  switch (run.spec.id) {
    case 'querit': url += '/v1/contents'; init = { method: 'POST', headers: jsonHeaders(run), body: JSON.stringify({ urls: [target], format: 'markdown', extrasMeta: true }) }; break
    case 'jina': url += '/' + target; init = { headers: { accept: 'application/json', 'x-retain-images': 'none', ...authHeaders(run) } }; break
    case 'firecrawl': url += '/v2/scrape'; init = { method: 'POST', headers: jsonHeaders(run), body: JSON.stringify({ url: target, formats: ['markdown'] }) }; break
    case 'fetch': url = target; init = { headers: { accept: 'text/html, text/plain', 'user-agent': 'Mozilla/5.0 AutoNote' } }; break
    default: throw new KitFailure('unsupported', `unsupported provider ${run.spec.id}`)
  }
  const follow = run.spec.id === 'fetch' && db ? async (next: string) => { await assertPublicTarget(db, next); if (blocked(next, blacklist)) throw badRequest('url', 'blacklisted'); return true } : undefined
  const body = await request(url, init, signal, 20_000, [run.key ?? '', run.basicAuthUsername ?? ''], follow)
  if (run.spec.id === 'fetch') return parseHtml(body, target)
  const payload = parseJson(body, run.spec.name); providerError(run, payload)
  let title = ''; let resultUrl = target; let content = ''
  if (run.spec.id === 'querit') { const page = at(payload, '/results/0'); title = rawText(at(page, '/extrasMeta'), 'title'); resultUrl = rawText(page, 'url') || target; content = rawText(page, 'content') }
  else if (run.spec.id === 'firecrawl') { const data = at(payload, '/data'); const meta = at(data, '/metadata'); title = rawText(meta, 'title'); resultUrl = rawText(meta, 'sourceURL') || target; content = rawText(data, 'markdown') }
  else { const data = payload.data && typeof payload.data === 'object' ? payload.data : payload; title = rawText(data, 'title'); resultUrl = rawText(data, 'url') || target; content = rawText(data, 'content', 'text') }
  if (!content) throw new KitFailure('upstream', `${run.spec.name} returned no page content`)
  return { title: title || resultUrl, url: resultUrl, content }
}
function parseHtml(html: string, url: string): SearchPage {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || url
  const content = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<noscript\b[^>]*>[\s\S]*?<\/noscript>|<head\b[^>]*>[\s\S]*?<\/head>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
  if (!content) throw new KitFailure('upstream', 'page has no content')
  return { title, url, content }
}
