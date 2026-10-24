import { z } from 'zod'
import type { KeyStrategy, Protocol } from '@ouraihub/aether-ui/ports'
import type { Env } from '../env'
import { getMeta, setMeta } from '../db/metadata'
import { fromBase64Url, fromUtf8, sha256Hex, toBase64Url, utf8 } from '../lib/encoding'
import { newId } from '../lib/id'
import { KitFailure, addressAllowed, apiBase, isLoopback, parseTarget, upstreamFailure } from './kit'
import { PROTOCOL_PATH, authHeaders } from './protocol'
import { requestKeys, withKeys } from './providers'

// Relay for coding agents (docs/43 §4–§5): access keys, the pause switch, GitHub repos and forwarding.

const KEY_RE = /^anr_[A-Za-z0-9_-]{43}$/
const ACTIVE_KEYS_MAX = 20
const MAX_BODY = 10 * 1024 * 1024
const MAX_CONCURRENT = 8
const KEEP_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept']

export interface RelayKey {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  expiresAt: number | null
  todayRequests: number
}

export interface RelayModel {
  id: string
  object: 'model'
  owned_by: string
  protocol: Protocol
}

/** OpenAI/Anthropic-style error body, which agent clients already understand. */
export const relayError = (status: number, type: string, message: string): Response =>
  Response.json({ type: 'error', error: { type, message } }, { status })

const today = (now: number): string => new Date(now).toISOString().slice(0, 10)

export async function relayEnabled(db: D1Database, userId: string): Promise<boolean> {
  return (await getMeta(db, `relay_enabled:${userId}`)) === '1'
}

export async function setRelayEnabled(db: D1Database, userId: string, enabled: boolean): Promise<void> {
  await setMeta(db, `relay_enabled:${userId}`, enabled ? '1' : '0')
}

export async function createRelayKey(
  db: D1Database,
  userId: string,
  name: string,
  expiresAt: number | null = null,
): Promise<{ key: RelayKey; token: string }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = `anr_${toBase64Url(bytes)}`
  const id = newId()
  const now = Date.now()
  const inserted = await db
    .prepare(
      `INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at, expires_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE (SELECT COUNT(*) FROM relay_access_keys
                WHERE user_id = ?2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?5)) < ?7`,
    )
    .bind(id, userId, name, await sha256Hex(token), now, expiresAt, ACTIVE_KEYS_MAX)
    .run()
  if (!inserted.meta.changes) throw new KitFailure('conflict', `at most ${ACTIVE_KEYS_MAX} active relay keys`, { reason: 'too_many', limit: ACTIVE_KEYS_MAX })
  return { key: { id, name, createdAt: now, lastUsedAt: null, expiresAt, todayRequests: 0 }, token }
}

export async function listRelayKeys(db: D1Database, userId: string): Promise<RelayKey[]> {
  const now = Date.now()
  const { results } = await db
    .prepare(
      `SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt, day, day_requests AS dayRequests
         FROM relay_access_keys WHERE user_id = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)
        ORDER BY created_at DESC`,
    )
    .bind(userId, now)
    .all<Omit<RelayKey, 'todayRequests'> & { day: string | null; dayRequests: number }>()
  return results.map(({ day, dayRequests, ...key }) => ({ ...key, todayRequests: day === today(now) ? dayRequests : 0 }))
}

export async function revokeRelayKey(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db
    .prepare('UPDATE relay_access_keys SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL')
    .bind(Date.now(), id, userId)
    .run()
  return (result.meta.changes ?? 0) > 0
}

/** Daily cleanup: revoked or expired keys, kept one day for the usage view. */
export async function purgeRelayKeys(db: D1Database): Promise<void> {
  const cutoff = Date.now() - 86_400_000
  await db
    .prepare('DELETE FROM relay_access_keys WHERE (revoked_at IS NOT NULL AND revoked_at < ?1) OR (expires_at IS NOT NULL AND expires_at < ?1)')
    .bind(cutoff)
    .run()
}

/** Resolves an access key and counts the request; null for unknown, revoked, expired or malformed keys. */
export async function verifyRelayKey(db: D1Database, token: string): Promise<{ userId: string; keyId: string } | null> {
  if (!KEY_RE.test(token)) return null
  const now = Date.now()
  const day = today(now)
  const row = await db
    .prepare(
      `UPDATE relay_access_keys
          SET last_used_at = ?2, day_requests = CASE WHEN day = ?3 THEN day_requests + 1 ELSE 1 END, day = ?3
        WHERE key_hash = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)
        RETURNING id, user_id AS userId`,
    )
    .bind(await sha256Hex(token), now, day)
    .first<{ id: string; userId: string }>()
  return row ? { userId: row.userId, keyId: row.id } : null
}

export interface RelayRepo {
  repo: string
  workflow: string
}

export async function listRelayRepos(db: D1Database, userId: string): Promise<RelayRepo[]> {
  const { results } = await db.prepare('SELECT repo, workflow FROM relay_github_repos WHERE user_id = ?1 ORDER BY repo').bind(userId).all<RelayRepo>()
  return results
}

/** A repository belongs to one user; re-registering your own repository replaces its workflow. */
export async function addRelayRepo(db: D1Database, userId: string, repo: string, workflow: string): Promise<void> {
  const saved = await db
    .prepare(
      `INSERT INTO relay_github_repos (repo, user_id, workflow, created_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(repo) DO UPDATE SET workflow = excluded.workflow WHERE relay_github_repos.user_id = excluded.user_id`,
    )
    .bind(repo, userId, workflow, Date.now())
    .run()
  if (!saved.meta.changes) throw new KitFailure('conflict', `repository ${repo} is registered by another user`, { reason: 'repo_taken' })
}

export async function removeRelayRepo(db: D1Database, userId: string, repo: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM relay_github_repos WHERE user_id = ?1 AND repo = ?2').bind(userId, repo).run()
  return (result.meta.changes ?? 0) > 0
}

interface LineRow {
  endpointId: string
  baseUrl: string
  protocol: Protocol
  headers: string
  keyStrategy: KeyStrategy
  slug: string
  providerName: string
  modelId: string
}

/** Every enabled chat model of the user, in provider then endpoint order. */
async function chatLines(db: D1Database, userId: string): Promise<LineRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS endpointId, e.base_url AS baseUrl, e.protocol, e.headers, e.key_strategy AS keyStrategy, e.slug,
              p.name AS providerName, m.model_id AS modelId
         FROM ai_models m JOIN ai_endpoints e ON e.id = m.endpoint_id AND e.user_id = m.user_id
         JOIN ai_providers p ON p.id = e.provider_id AND p.user_id = m.user_id
        WHERE m.user_id = ?1 AND p.enabled = 1 AND m.model_type = 'chat'
        ORDER BY p.position, p.id, e.position, e.id, m.position`,
    )
    .bind(userId)
    .all<LineRow>()
  return results
}

export async function relayModels(db: D1Database, userId: string): Promise<RelayModel[]> {
  const seen = new Set<string>()
  const models: RelayModel[] = []
  for (const line of await chatLines(db, userId)) {
    const key = `${line.modelId}\u0000${line.protocol}`
    if (seen.has(key)) continue
    seen.add(key)
    models.push({ id: line.modelId, object: 'model', owned_by: line.providerName, protocol: line.protocol })
  }
  return models
}

// ponytail: per-isolate counter, so the 8-request cap holds per Worker instance; move to a Durable Object if keys get shared widely.
const inFlight = new Map<string, number>()

/** Forwards one agent request to the first matching line with a usable key (docs/43 §4). */
export async function forward(env: Env, userId: string, keyId: string, protocol: Protocol, request: Request): Promise<Response> {
  const running = inFlight.get(keyId) ?? 0
  if (running >= MAX_CONCURRENT) return relayError(429, 'rate_limit_error', `at most ${MAX_CONCURRENT} concurrent requests per access key`)
  inFlight.set(keyId, running + 1)
  let release = true
  try {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    const body = await request.arrayBuffer()
    if (body.byteLength > MAX_BODY) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return relayError(400, 'invalid_request_error', 'request body is not JSON')
    }
    const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const model = 'model' in payload ? payload.model : undefined
    if (typeof model !== 'string' || !model) return relayError(400, 'invalid_request_error', 'model is required')

    const all = (await chatLines(env.DB, userId)).filter((line) => line.protocol === protocol)
    let lines = all.filter((line) => line.modelId === model)
    let upstreamBody: ArrayBuffer | string = body
    const slash = model.indexOf('/')
    if (!lines.length && slash > 0) {
      const provider = model.slice(0, slash)
      const modelId = model.slice(slash + 1)
      lines = all.filter((line) => line.providerName === provider && line.modelId === modelId)
      // The upstream only knows its own model id.
      if (lines.length) upstreamBody = JSON.stringify({ ...payload, model: modelId })
    }
    if (!lines.length) {
      const available = [...new Set(all.map((line) => line.modelId))]
      return relayError(404, 'not_found_error', `model ${model} is not configured for ${protocol}; available: ${available.join(', ') || 'none'}`)
    }

    const inbound = Object.fromEntries(KEEP_HEADERS.flatMap((name) => (request.headers.get(name) ? [[name, request.headers.get(name)!]] : [])))
    let last: KitFailure | null = null
    // Assigned inside the key callback; the cast keeps TypeScript from narrowing it to null here.
    let rejected = null as { status: number; text: string; contentType: string } | null
    for (const line of lines) {
      const url = parseTarget(`${apiBase(line.baseUrl)}/${PROTOCOL_PATH[protocol]}`)
      if (!(await addressAllowed(env.DB, url))) {
        last = new KitFailure('bad_request', 'upstream address blocked', { reason: 'blocked_address' })
        continue
      }
      let pool
      try {
        pool = await requestKeys(env, userId, line.endpointId, line.keyStrategy, `${line.providerName} · ${line.slug}`)
      } catch (error) {
        if (error instanceof KitFailure) {
          last = error
          continue
        }
        throw error
      }
      if (!pool.apiKeys.length && !isLoopback(url)) {
        last = new KitFailure('needs_config', 'missing key', { reason: 'missing_key' })
        continue
      }
      const known = pool.apiKeys
      try {
        const response = await withKeys(pool, async (key) => {
          let upstream: Response
          try {
            upstream = await fetch(url, {
              method: 'POST',
              headers: { ...(JSON.parse(line.headers) as Record<string, string>), ...inbound, ...authHeaders(protocol, key) },
              body: upstreamBody,
              redirect: 'manual',
              signal: request.signal,
            })
          } catch {
            if (request.signal.aborted) throw new KitFailure('cancelled', 'cancelled')
            throw new KitFailure('network', 'upstream unreachable')
          }
          if (upstream.ok) return upstream
          const text = await upstream.text().catch(() => '')
          // A failure that does not switch keys or lines goes back to the agent unchanged.
          rejected = { status: upstream.status, text, contentType: upstream.headers.get('content-type') ?? 'application/json' }
          throw upstreamFailure(upstream.status, text, known, upstream.headers.get('retry-after'))
        })
        // The stream outlives this handler; release the slot when it ends.
        release = false
        const done = (): void => {
          inFlight.set(keyId, Math.max(0, (inFlight.get(keyId) ?? 1) - 1))
        }
        const { readable, writable } = new TransformStream()
        void (response.body ?? new ReadableStream()).pipeTo(writable).catch(() => {}).finally(done)
        return new Response(readable, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        // A line whose keys were all rejected or used up hands over to the next matching line.
        const status = Number(error.details.status)
        if (!error.upstream || !(error.upstream.quota || [401, 402, 403, 429].includes(status))) break
      }
    }
    if (rejected && last?.upstream) return new Response(rejected.text, { status: rejected.status, headers: { 'content-type': rejected.contentType } })
    if (last?.code === 'rate_limited') return relayError(429, 'rate_limit_error', last.message)
    if (last?.code === 'cancelled') return relayError(499, 'cancelled', 'cancelled')
    return relayError(502, 'api_error', last?.message ?? 'no usable line')
  } finally {
    if (release) inFlight.set(keyId, Math.max(0, (inFlight.get(keyId) ?? 1) - 1))
  }
}

const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com'
const GITHUB_KEY_TTL_MS = 2 * 3_600_000
const JwtHeader = z.object({ alg: z.literal('RS256'), kid: z.string() })
const GithubClaims = z.object({
  iss: z.literal(GITHUB_ISSUER),
  aud: z.union([z.string(), z.array(z.string())]),
  exp: z.number(),
  nbf: z.number().optional(),
  repository: z.string(),
  job_workflow_ref: z.string(),
  run_id: z.string(),
})
const Jwks = z.object({ keys: z.array(z.object({ kid: z.string(), kty: z.literal('RSA'), n: z.string(), e: z.string() })) })

/** Verifies a GitHub Actions OIDC token (RS256 against GitHub's JWKS); throws `unauthorized` on any mismatch. */
export async function verifyGithubToken(token: string, audience: string, now = Date.now()): Promise<z.infer<typeof GithubClaims>> {
  const deny = (reason: string): KitFailure => new KitFailure('unauthorized', `GitHub token rejected: ${reason}`, { reason })
  const parts = token.split('.')
  if (parts.length !== 3) throw deny('malformed')
  const [rawHeader, rawClaims, rawSignature] = parts as [string, string, string]
  let header: z.infer<typeof JwtHeader>
  let claims: z.infer<typeof GithubClaims>
  try {
    header = JwtHeader.parse(JSON.parse(fromUtf8(fromBase64Url(rawHeader))))
    claims = GithubClaims.parse(JSON.parse(fromUtf8(fromBase64Url(rawClaims))))
  } catch {
    throw deny('malformed')
  }
  const jwks = Jwks.parse(await (await fetch(`${GITHUB_ISSUER}/.well-known/jwks`)).json())
  const jwk = jwks.keys.find((key) => key.kid === header.kid)
  if (!jwk) throw deny('unknown_key')
  const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(rawSignature), utf8(`${rawHeader}.${rawClaims}`))
  if (!signed) throw deny('signature')
  const seconds = now / 1000
  if (claims.exp <= seconds || (claims.nbf !== undefined && claims.nbf > seconds + 60)) throw deny('expired')
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) throw deny('audience')
  return claims
}

/** Exchanges a verified run of the registered workflow for a 2-hour access key of the repository's user (docs/43 §5.2). */
export async function exchangeGithubToken(env: Env, token: string, audience: string): Promise<Response> {
  const claims = await verifyGithubToken(token, audience)
  const owner = await env.DB.prepare('SELECT user_id AS userId, workflow FROM relay_github_repos WHERE repo = ?1')
    .bind(claims.repository)
    .first<{ userId: string; workflow: string }>()
  if (!owner) return relayError(403, 'permission_error', `repository ${claims.repository} is not registered for the relay`)
  if (!claims.job_workflow_ref.startsWith(`${owner.workflow}@`)) {
    throw new KitFailure('unauthorized', 'GitHub token rejected: workflow', { reason: 'workflow' })
  }
  if (!(await relayEnabled(env.DB, owner.userId))) return relayError(503, 'relay_paused', '模型转发已暂停，请在 AutoNote 设置中启用')
  const expiresAt = Date.now() + GITHUB_KEY_TTL_MS
  const created = await createRelayKey(env.DB, owner.userId, `GitHub ${claims.repository} ${claims.run_id}`, expiresAt)
  return Response.json({ key: created.token, expiresAt, models: await relayModels(env.DB, owner.userId) })
}
