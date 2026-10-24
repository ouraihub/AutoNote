import type { z } from 'zod'
import type { Details, KitError, KitErrorCode } from '@ouraihub/aether-ui/ports'
import { newId } from '../lib/id'

export class KitFailure extends Error {
  // Set by `upstreamFailure`; drives fill-first key set-aside, never serialized.
  upstream: { quota: boolean; retryAfterMs: number | null; reason: string } | null = null

  constructor(
    readonly code: KitErrorCode,
    message: string,
    readonly details: Details = {},
  ) {
    super(message)
    this.name = 'KitFailure'
  }

  toJSON(): KitError {
    return Object.keys(this.details).length
      ? { code: this.code, message: this.message, details: this.details }
      : { code: this.code, message: this.message }
  }
}

export const HTTP_STATUS: Record<KitErrorCode, number> = {
  bad_request: 400,
  not_found: 404,
  conflict: 409,
  unsupported: 400,
  cancelled: 409,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  upstream: 502,
  timeout: 504,
  network: 502,
  needs_config: 409,
  budget_exceeded: 400,
  incompatible_db: 500,
  internal: 500,
}

export const badRequest = (field: string, reason: string, limit?: number): KitFailure =>
  new KitFailure('bad_request', `invalid ${field}: ${reason}`, limit === undefined ? { field, reason } : { field, reason, limit })
export const notFound = (entity: string): KitFailure => new KitFailure('not_found', `${entity} not found`, { entity })
export const conflict = (reason: string): KitFailure => new KitFailure('conflict', `conflict: ${reason}`, { reason })
export const needsConfig = (reason: string): KitFailure =>
  new KitFailure('needs_config', `needs configuration: ${reason}`, { reason })
export const unsupported = (reason: string): KitFailure => new KitFailure('unsupported', `unsupported: ${reason}`, { reason })
export const cancelled = (): KitFailure => new KitFailure('cancelled', 'cancelled')

export function internal(cause: unknown): KitFailure {
  const errorId = newId().slice(-10)
  console.error('[autonote] AI kit internal error', errorId, cause)
  return new KitFailure('internal', `internal error ${errorId}`, { errorId })
}

// Quota wording looked for in the first 4 KB of a failed response (docs/43 §3.1).
const QUOTA_WORDS = /quota|insufficient|balance|billing|exceeded|credit|额度|余额|用尽|不足|过期/i

export function upstreamFailure(status: number, body: string, known: readonly string[], retryAfter: string | null = null): KitFailure {
  const code = status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate_limited' : 'upstream'
  const text = excerpt(body, known)
  const failure = new KitFailure(code, text ? `${status}: ${text}` : `upstream returned ${status}`, { status })
  const seconds = Number(retryAfter)
  const date = retryAfter ? Date.parse(retryAfter) - Date.now() : NaN
  const retryAfterMs = retryAfter && Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(date) ? Math.max(date, 0) : null
  failure.upstream = { quota: QUOTA_WORDS.test(body.slice(0, 4096)), retryAfterMs, reason: [...(text ? `HTTP ${status} ${text}` : `HTTP ${status}`)].slice(0, 120).join('') }
  return failure
}

export const charCount = (value: string): number => [...value].length

export function checkLength(field: string, value: string | null | undefined, limit: number): void {
  if (value && charCount(value) > limit) throw badRequest(field, 'too_long', limit)
}

export function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value
  for (const key of path) {
    if (typeof current !== 'object' || current === null) return undefined
    current = Reflect.get(current, key) as unknown
  }
  return current
}

export function maskSecret(secret: string): string {
  const chars = [...secret]
  if (chars.length <= 8) return '*'.repeat(Math.max(chars.length, 4))
  return `${chars.slice(0, 4).join('')}${'*'.repeat(chars.length - 8)}${chars.slice(-4).join('')}`
}

const SECRET_PREFIXES = ['sk-', 'ghp_', 'gho_', 'github_pat_', 'xoxb-', 'xoxp-', 'AKIA', 'AIza', 'glpat-']

export function excerpt(body: string, known: readonly string[]): string {
  let text = body.split(/\s+/u).filter(Boolean).join(' ')
  for (const secret of known.map((value) => value.trim()).filter(Boolean)) text = text.replaceAll(secret, '***')
  let afterBearer = false
  text = text.replace(/[A-Za-z0-9\-_./+=]+/g, (token) => {
    const secret =
      token.length >= 20 && (SECRET_PREFIXES.some((prefix) => token.startsWith(prefix)) || afterBearer)
    afterBearer = token.toLowerCase() === 'bearer'
    return secret ? '***' : token
  })
  const chars = [...text]
  return chars.length > 300 ? `${chars.slice(0, 300).join('')}…` : text
}

export function parseBody<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (result.success) return result.data
  throw badRequest(result.error.issues[0]?.path.join('.') || 'body', 'invalid')
}

export async function readUpTo(
  body: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const chunks: Uint8Array[] = []
  let size = 0
  let overflow = false
  if (body) {
    const reader = body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (size + value.length > limit) {
          chunks.push(value.subarray(0, limit - size))
          size = limit
          overflow = true
          break
        }
        chunks.push(value)
        size += value.length
      }
    } finally {
      reader.cancel().catch(() => {})
    }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, overflow }
}

export function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

export function parseTarget(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw badRequest('url', 'invalid_url')
  }
  if (url.username || url.password) throw badRequest('url', 'userinfo')
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw badRequest('url', 'scheme')
  return url
}

export function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true
  if (host.includes(':')) return host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
  return (
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  )
}

export async function addressAllowed(db: D1Database, url: URL): Promise<boolean> {
  if (url.protocol !== 'https:') return false
  if (!isPrivateHost(url.hostname.toLowerCase().replace(/^\[|\]$/g, ''))) return true
  const allow = await db.prepare("SELECT value FROM app_meta WHERE key = 'setting:ai_allow_private'").first<{ value: string }>()
  return allow?.value === '1'
}

const active = new Map<string, number>()
const windows = new Map<string, { at: number; count: number }>()

export function acquireSlot(userId: string): () => void {
  const now = Date.now()
  const window = windows.get(userId)
  const fresh = !window || now - window.at >= 60_000
  const running = active.get(userId) ?? 0
  if ((!fresh && window.count >= 20) || running >= 2) throw new KitFailure('rate_limited', 'too many AI requests')
  windows.set(userId, fresh ? { at: now, count: 1 } : { at: window.at, count: window.count + 1 })
  active.set(userId, running + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    active.set(userId, Math.max(0, (active.get(userId) ?? 1) - 1))
  }
}
