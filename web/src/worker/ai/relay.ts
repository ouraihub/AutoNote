import { z } from 'zod'
import type { KeyStrategy, Protocol } from '@ouraihub/aether-ui/ports'
import type { Env } from '../env'
import { getMeta, setMeta } from '../db/metadata'
import { fromBase64Url, fromUtf8, sha256Hex, toBase64Url, utf8 } from '../lib/encoding'
import { newId } from '../lib/id'
import { KitFailure, addressAllowed, apiBase, isLoopback, parseTarget, readUpTo, upstreamFailure } from './kit'
import { PROTOCOL_PATH, authHeaders } from './protocol'
import { requestKeys, withKeys } from './providers'

// Relay for coding agents (docs/43 §4–§5): access keys, the pause switch, GitHub repos and forwarding.

const KEY_RE = /^anr_[A-Za-z0-9_-]{43}$/
const ACTIVE_KEYS_MAX = 20
const MAX_BODY = 10 * 1024 * 1024
const MAX_CONCURRENT = 8
const KEEP_HEADERS = ['anthropic-version', 'anthropic-beta', 'content-type', 'accept']
const KEY_STATUS = [401, 402, 403, 429]

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
  model_type: 'chat' | 'image'
}

export const relayError = (status: number, type: string, message: string): Response =>
  Response.json({ type: 'error', error: { type, message } }, { status })

const today = (now: number): string => new Date(now).toISOString().slice(0, 10)

export async function relayEnabled(db: D1Database, userId: string): Promise<boolean> {
  return (await getMeta(db, `relay_enabled:${userId}`)) === '1'
}

export async function setRelayEnabled(db: D1Database, userId: string, enabled: boolean): Promise<void> {
  await setMeta(db, `relay_enabled:${userId}`, enabled ? '1' : '0')
}

async function mint(): Promise<{ id: string; token: string; hash: string; now: number }> {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  const token = `anr_${toBase64Url(bytes)}`
  return { id: newId(), token, hash: await sha256Hex(token), now: Date.now() }
}

/** A manual key that never expires; GitHub-minted keys have their own cap and do not count here. */
export async function createRelayKey(db: D1Database, userId: string, name: string): Promise<{ key: RelayKey; token: string }> {
  const { id, token, hash, now } = await mint()
  const inserted = await db
    .prepare(
      `INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM relay_access_keys WHERE user_id = ?2 AND revoked_at IS NULL AND expires_at IS NULL) < ?6`,
    )
    .bind(id, userId, name, hash, now, ACTIVE_KEYS_MAX)
    .run()
  if (!inserted.meta.changes) throw new KitFailure('conflict', `at most ${ACTIVE_KEYS_MAX} active relay keys`, { reason: 'too_many', limit: ACTIVE_KEYS_MAX })
  return { key: { id, name, createdAt: now, lastUsedAt: null, expiresAt: null, todayRequests: 0 }, token }
}

/** One key per run attempt: a repeated exchange revokes the previous key; past 20 active keys the oldest is revoked. */
async function issueGithubKey(db: D1Database, owner: RelayRepo & { userId: string }, repositoryId: string, run: string, expiresAt: number): Promise<string> {
  const { id, token, hash, now } = await mint()
  const { repo, userId, workflow, ref } = owner
  const values = [repo, userId, workflow, ref, repositoryId] as const
  const registered = `EXISTS (SELECT 1 FROM relay_github_repos WHERE repo = ?1 AND user_id = ?2 AND workflow = ?3 AND ref = ?4 AND repository_id = ?5)`
  const results = await db.batch([
    db.prepare(`UPDATE relay_github_repos SET repository_id = ?5
                 WHERE repo = ?1 AND user_id = ?2 AND workflow = ?3 AND ref = ?4 AND (repository_id IS NULL OR repository_id = ?5)`).bind(...values),
    db.prepare(`DELETE FROM relay_access_keys WHERE user_id = ?2 AND expires_at IS NOT NULL AND expires_at <= ?6 AND ${registered}`).bind(...values, now),
    db.prepare(`UPDATE relay_access_keys SET revoked_at = ?6 WHERE user_id = ?2 AND github_run = ?7 AND revoked_at IS NULL AND ${registered}`).bind(...values, now, run),
    db
      .prepare(
        `UPDATE relay_access_keys SET revoked_at = ?6
          WHERE ${registered} AND id IN (SELECT id FROM relay_access_keys
                        WHERE user_id = ?2 AND substr(github_run, 1, length(?7)) = ?7 AND revoked_at IS NULL AND expires_at > ?6
                        ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
      )
      .bind(...values, now, `${repo}#`, ACTIVE_KEYS_MAX - 1),
    db
      .prepare(`INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at, expires_at, github_run)
                SELECT ?6, ?2, ?7, ?8, ?9, ?10, ?11 WHERE ${registered}`)
      .bind(...values, id, `GitHub ${repo} ${run.split('#')[1]}`, hash, now, expiresAt, run),
  ])
  if (!results[4]!.meta.changes) throw new KitFailure('unauthorized', 'GitHub token rejected: repository registration changed', { reason: 'repository_id' })
  return token
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
  ref: string
}

export async function listRelayRepos(db: D1Database, userId: string): Promise<RelayRepo[]> {
  const { results } = await db.prepare('SELECT repo, workflow, ref FROM relay_github_repos WHERE user_id = ?1 ORDER BY repo').bind(userId).all<RelayRepo>()
  return results
}

const normalizeWorkflow = (workflow: string): string => workflow.replace(/^[^/]+\/[^/]+/, (repo) => repo.toLowerCase())

/** A repository belongs to one user; re-registering your own repository replaces its workflow and trusted ref. Names are case-insensitive. */
export async function addRelayRepo(db: D1Database, userId: string, input: RelayRepo): Promise<void> {
  const repo = input.repo.toLowerCase()
  const saved = await db
    .prepare(
      `INSERT INTO relay_github_repos (repo, user_id, workflow, ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(repo) DO UPDATE SET workflow = excluded.workflow, ref = excluded.ref WHERE relay_github_repos.user_id = excluded.user_id`,
    )
    .bind(repo, userId, normalizeWorkflow(input.workflow), input.ref, Date.now())
    .run()
  if (!saved.meta.changes) throw new KitFailure('conflict', `repository ${repo} is registered by another user`, { reason: 'repo_taken' })
}

export async function removeRelayRepo(db: D1Database, userId: string, repo: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM relay_github_repos WHERE user_id = ?1 AND repo = ?2').bind(userId, repo.toLowerCase()).run()
  return (result.meta.changes ?? 0) > 0
}

interface LineRow {
  endpointId: string
  baseUrl: string
  imageBaseUrl: string | null
  imageEditBaseUrl: string | null
  protocol: Protocol
  headers: string
  keyStrategy: KeyStrategy
  slug: string
  providerId: string
  providerName: string
  modelId: string
  modelType: 'chat' | 'image'
}

/** Every enabled model of one type, in provider then endpoint order. */
async function modelLines(db: D1Database, userId: string, modelType: 'chat' | 'image'): Promise<LineRow[]> {
  const { results } = await db
    .prepare(
      `SELECT e.id AS endpointId, e.base_url AS baseUrl, e.image_base_url AS imageBaseUrl, e.image_edit_base_url AS imageEditBaseUrl,
              e.protocol, e.headers, e.key_strategy AS keyStrategy, e.slug,
              p.id AS providerId, p.name AS providerName, m.model_id AS modelId, m.model_type AS modelType
         FROM ai_models m JOIN ai_endpoints e ON e.id = m.endpoint_id AND e.user_id = m.user_id
         JOIN ai_providers p ON p.id = e.provider_id AND p.user_id = m.user_id
        WHERE m.user_id = ?1 AND p.enabled = 1 AND m.model_type = ?2
        ORDER BY p.position, p.id, e.position, e.id, m.position`,
    )
    .bind(userId, modelType)
    .all<LineRow>()
  return results
}


/** Plain ids for the first provider offering a model; later providers with the same model also get `provider/id`. */
export async function relayModels(db: D1Database, userId: string): Promise<RelayModel[]> {
  const first = new Map<string, string>()
  const seen = new Set<string>()
  const providers = new Set<string>()
  const models: RelayModel[] = []
  for (const modelType of ['chat', 'image'] as const) {
    for (const line of await modelLines(db, userId, modelType)) {
      const model = `${line.modelId}\u0000${line.protocol}`
      const providerModel = `${line.providerId}\u0000${model}`
      if (providers.has(providerModel)) continue
      providers.add(providerModel)
      if (!first.has(model)) first.set(model, line.providerId)
      const id = first.get(model) === line.providerId ? line.modelId : `${line.providerName}/${line.modelId}`
      const key = `${id}\u0000${line.protocol}\u0000${modelType}`
      if (seen.has(key)) continue
      seen.add(key)
      models.push({ id, object: 'model', owned_by: line.providerName, protocol: line.protocol, model_type: modelType })
    }
  }
  return models
}

/** Forwards OpenAI-compatible image generation and edit requests to image models. */
export async function forwardImage(env: Env, userId: string, keyId: string, request: Request, edit: boolean): Promise<Response> {
  const running = inFlight.get(keyId) ?? 0
  if (running >= MAX_CONCURRENT) return relayError(429, 'rate_limit_error', `at most ${MAX_CONCURRENT} concurrent requests per access key`)
  inFlight.set(keyId, running + 1)
  try {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_BODY) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    const { bytes: body, overflow } = await readUpTo(request.body, MAX_BODY)
    if (overflow) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    let model: unknown
    let payload: Record<string, unknown> | null = null
    let form: FormData | null = null
    if (edit) {
      try {
        form = await new Request('https://relay.invalid', { method: 'POST', headers: { 'content-type': request.headers.get('content-type') ?? '' }, body }).formData()
        model = form.get('model')
      } catch {
        return relayError(400, 'invalid_request_error', 'request body is not valid multipart form data')
      }
    } else {
      try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(body))
        payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
        model = payload?.model
      } catch {
        return relayError(400, 'invalid_request_error', 'request body is not JSON')
      }
    }
    if (typeof model !== 'string' || !model) return relayError(400, 'invalid_request_error', 'model is required')
    const configured = await modelLines(env.DB, userId, 'image')
    const select = (candidate: string): LineRow[] => {
      const direct = configured.filter((line) => line.modelId === candidate)
      if (direct.length) return direct
      const selected = configured.find((line) => candidate === `${line.providerName}/${line.modelId}`)
      return selected ? configured.filter((line) => line.providerId === selected.providerId && line.modelId === selected.modelId) : []
    }
    const lines = select(model)
    if (!lines.length) return relayError(404, 'not_found_error', `model ${model} is not configured for image generation`)
    let upstreamBody: Uint8Array | string = body
    let contentType = request.headers.get('content-type')
    if (model !== lines[0]!.modelId) {
      if (form) {
        form.set('model', lines[0]!.modelId)
        const rewritten = new Request('https://relay.invalid', { method: 'POST', body: form })
        upstreamBody = new Uint8Array(await rewritten.arrayBuffer())
        contentType = rewritten.headers.get('content-type')
      } else upstreamBody = JSON.stringify({ ...payload, model: lines[0]!.modelId })
    }
    let last: KitFailure | null = null
    let rejected: { status: number; text: string; contentType: string } | null = null
    let resumeAt: number | null = null
    let pausedLines = 0
    let configurationFailure: KitFailure | null = null
    for (const line of lines) {
      const base = edit ? line.imageEditBaseUrl ?? line.baseUrl : line.imageBaseUrl ?? line.baseUrl
      const url = parseTarget(`${apiBase(base)}/images/${edit ? 'edits' : 'generations'}`)
      if (!(await addressAllowed(env.DB, url))) {
        last = new KitFailure('bad_request', 'upstream address blocked', { reason: 'blocked_address' })
        configurationFailure = last
        continue
      }
      let pool
      try {
        pool = await requestKeys(env, userId, line.endpointId, line.keyStrategy, `${line.providerName} · ${line.slug}`)
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (error.resumeAt !== null) {
          resumeAt = Math.min(resumeAt ?? error.resumeAt, error.resumeAt)
          pausedLines++
        } else configurationFailure = error
        continue
      }
      if (!pool.apiKeys.length && !isLoopback(url)) {
        last = new KitFailure('needs_config', 'missing key', { reason: 'missing_key' })
        configurationFailure = last
        continue
      }
      const known = [...pool.apiKeys]
      try {
        const response = await withKeys(pool, async (key) => {
          let upstream: Response
          try {
            upstream = await fetch(url, {
              method: 'POST',
              headers: { ...Object.fromEntries(Object.entries(JSON.parse(line.headers) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])), ...authHeaders('openai-chat', key), ...(contentType ? { 'content-type': contentType } : {}) },
              body: upstreamBody,
              redirect: 'manual',
              signal: request.signal,
            })
          } catch {
            if (request.signal.aborted) throw new KitFailure('cancelled', 'cancelled')
            throw new KitFailure('network', 'upstream unreachable')
          }
          const read = await readUpTo(upstream.body, MAX_BODY).catch(() => {
            if (request.signal.aborted) throw new KitFailure('cancelled', 'cancelled')
            throw new KitFailure('network', 'upstream unreachable')
          })
          const text = new TextDecoder().decode(read.bytes)
          if (!upstream.ok) {
            const masked = known.reduce((value, secret) => (secret.trim() ? value.replaceAll(secret.trim(), '***') : value), text)
            rejected = { status: upstream.status, text: masked, contentType: upstream.headers.get('content-type') ?? 'application/json' }
            throw upstreamFailure(upstream.status, text, known, upstream.headers.get('retry-after'))
          }
          if (read.overflow) throw new KitFailure('bad_request', 'image response exceeds 10 MB', { field: 'images', reason: 'size' })
          return new Response(read.bytes, { status: upstream.status, headers: { 'content-type': upstream.headers.get('content-type') ?? 'application/json' } })
        })
        return response
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (!error.upstream) break
        if (!(error.upstream.usedUp || KEY_STATUS.includes(Number(error.details.status)))) break
      }
    }
    if (rejected !== null) {
      const failed = rejected as { status: number; text: string; contentType: string }
      return new Response(failed.text, { status: failed.status, headers: { 'content-type': failed.contentType } })
    }
    if (last?.code === 'cancelled') return relayError(499, 'cancelled', 'cancelled')
    if (resumeAt !== null && pausedLines === lines.length) return relayError(429, 'rate_limit_error', `every key of the matching lines is set aside; earliest recovery ${new Date(resumeAt).toISOString()}`)
    return relayError(502, 'api_error', configurationFailure?.message ?? last?.message ?? 'no usable line')
  } finally {
    inFlight.set(keyId, Math.max(0, (inFlight.get(keyId) ?? 1) - 1))
  }
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
    const { bytes: body, overflow } = await readUpTo(request.body, MAX_BODY)
    if (overflow) return relayError(413, 'invalid_request_error', 'request body exceeds 10 MB')
    let parsed: unknown
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      return relayError(400, 'invalid_request_error', 'request body is not JSON')
    }
    const payload = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    const model = 'model' in payload ? payload.model : undefined
    if (typeof model !== 'string' || !model) return relayError(400, 'invalid_request_error', 'model is required')

    const configured = await modelLines(env.DB, userId, 'chat')
    const all = configured.filter((line) => line.protocol === protocol)
    let lines = all.filter((line) => line.modelId === model)
    let upstreamBody: Uint8Array | string = body
    if (!lines.length) {
      const selected = all.find((line) => model === `${line.providerName}/${line.modelId}` && configured.find((candidate) => candidate.providerName === line.providerName)?.providerId === line.providerId)
      if (selected) {
        const modelId = model.slice(selected.providerName.length + 1)
        lines = all.filter((line) => line.providerId === selected.providerId && line.modelId === modelId)
        if (lines.length) upstreamBody = JSON.stringify({ ...payload, model: modelId })
      }
    }
    if (!lines.length) {
      const available = [...new Set(all.map((line) => line.modelId))]
      return relayError(404, 'not_found_error', `model ${model} is not configured for ${protocol}; available: ${available.join(', ') || 'none'}`)
    }

    const inbound = Object.fromEntries(KEEP_HEADERS.flatMap((name) => (request.headers.get(name) ? [[name, request.headers.get(name)!]] : [])))
    let last: KitFailure | null = null
    let resumeAt: number | null = null
    let pausedLines = 0
    let configurationFailure: KitFailure | null = null
    // Assigned inside the key callback; the cast keeps TypeScript from narrowing it to null here.
    let rejected = null as { status: number; text: string; contentType: string } | null
    for (const line of lines) {
      const url = parseTarget(`${apiBase(line.baseUrl)}/${PROTOCOL_PATH[protocol]}`)
      if (!(await addressAllowed(env.DB, url))) {
        last = new KitFailure('bad_request', 'upstream address blocked', { reason: 'blocked_address' })
        configurationFailure = last
        continue
      }
      let pool
      try {
        pool = await requestKeys(env, userId, line.endpointId, line.keyStrategy, `${line.providerName} · ${line.slug}`)
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (error.resumeAt !== null) {
          resumeAt = Math.min(resumeAt ?? error.resumeAt, error.resumeAt)
          pausedLines++
        } else configurationFailure = error
        continue
      }
      if (!pool.apiKeys.length && !isLoopback(url)) {
        last = new KitFailure('needs_config', 'missing key', { reason: 'missing_key' })
        configurationFailure = last
        continue
      }
      const known = [...pool.apiKeys]
      try {
        const response = await withKeys(pool, async (key) => {
          let upstream: Response
          try {
            upstream = await fetch(url, {
              method: 'POST',
              headers: { ...Object.fromEntries(Object.entries(JSON.parse(line.headers) as Record<string, string>).map(([name, value]) => [name.toLowerCase(), value])), ...authHeaders(protocol, key), ...inbound },
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
          const masked = known.reduce((value, secret) => (secret.trim() ? value.replaceAll(secret.trim(), '***') : value), text)
          rejected = { status: upstream.status, text: masked, contentType: upstream.headers.get('content-type') ?? 'application/json' }
          throw upstreamFailure(upstream.status, text, known, upstream.headers.get('retry-after'))
        })
        if (!response.body) return new Response(null, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
        const reader = response.body.getReader()
        let finished = false
        const done = (): void => {
          if (finished) return
          finished = true
          inFlight.set(keyId, Math.max(0, (inFlight.get(keyId) ?? 1) - 1))
        }
        const readable = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done: ended, value } = await reader.read()
              if (ended) { done(); controller.close() }
              else controller.enqueue(value)
            } catch (error) { done(); controller.error(error) }
          },
          cancel(reason) { done(); return reader.cancel(reason) },
        })
        release = false
        return new Response(readable, { status: response.status, headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' } })
      } catch (error) {
        if (!(error instanceof KitFailure)) throw error
        last = error
        if (!error.upstream) {
          rejected = null
          break
        }
        // A line whose keys were all rejected or used up hands over to the next matching line.
        if (!(error.upstream.usedUp || KEY_STATUS.includes(Number(error.details.status)))) break
      }
    }
    if (rejected) return new Response(rejected.text, { status: rejected.status, headers: { 'content-type': rejected.contentType } })
    if (last?.code === 'cancelled') return relayError(499, 'cancelled', 'cancelled')
    if (resumeAt !== null && pausedLines === lines.length) {
      return relayError(429, 'rate_limit_error', `every key of the matching lines is set aside; earliest recovery ${new Date(resumeAt).toISOString()}`)
    }
    return relayError(502, 'api_error', configurationFailure?.message ?? last?.message ?? 'no usable line')
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
  ref: z.string(),
  event_name: z.string(),
  workflow_ref: z.string(),
  job_workflow_ref: z.string().optional(),
  run_id: z.string().regex(/^\d+$/),
  run_attempt: z.string().regex(/^\d+$/),
  repository_id: z.string().regex(/^\d+$/),
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
  let signed: boolean
  try {
    signed = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromBase64Url(rawSignature), utf8(`${rawHeader}.${rawClaims}`))
  } catch {
    throw deny('signature')
  }
  if (!signed) throw deny('signature')
  const seconds = now / 1000
  if (claims.exp <= seconds || (claims.nbf !== undefined && claims.nbf > seconds + 60)) throw deny('expired')
  if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(audience)) throw deny('audience')
  return claims
}

// Only runs started by a push, a manual dispatch or a schedule; PR, comment and workflow_run triggers may run untrusted code.
const TRUSTED_EVENTS = ['push', 'workflow_dispatch', 'schedule']

/** Exchanges a trusted run of the registered workflow for a 2-hour access key of the repository's user (docs/43 §5.2). */
export async function exchangeGithubToken(env: Env, token: string, audience: string): Promise<Response> {
  const claims = await verifyGithubToken(token, audience)
  const repo = claims.repository.toLowerCase()
  const owner = await env.DB.prepare('SELECT user_id AS userId, workflow, ref, repository_id AS repositoryId FROM relay_github_repos WHERE repo = ?1')
    .bind(repo)
    .first<{ userId: string; workflow: string; ref: string; repositoryId: string | null }>()
  if (!owner) return relayError(403, 'permission_error', `repository ${claims.repository} is not registered for the relay`)
  const deny = (reason: string): KitFailure => new KitFailure('unauthorized', `GitHub token rejected: ${reason}`, { reason })
  if (owner.repositoryId !== null && owner.repositoryId !== claims.repository_id) throw deny('repository_id')
  if (claims.ref !== owner.ref) throw deny('ref')
  if (!TRUSTED_EVENTS.includes(claims.event_name)) throw deny('event')
  // A reusable workflow job carries `job_workflow_ref`; a plain workflow only has `workflow_ref`.
  const workflowRef = claims.job_workflow_ref ?? claims.workflow_ref
  const at = workflowRef.indexOf('@')
  if (at <= 0 || at === workflowRef.length - 1) throw deny('workflow')
  const running = normalizeWorkflow(workflowRef.slice(0, at))
  if (running !== owner.workflow) throw deny('workflow')
  if (!(await relayEnabled(env.DB, owner.userId))) return relayError(503, 'relay_paused', '模型转发已暂停，请在 AutoNote 设置中启用')
  const models = await relayModels(env.DB, owner.userId)
  // Pinning and issuance share one transaction, so only a successful exchange can claim the repository identity.
  const expiresAt = Date.now() + GITHUB_KEY_TTL_MS
  const run = `${repo}#${claims.run_id}#${claims.run_attempt}`
  const key = await issueGithubKey(env.DB, { ...owner, repo }, claims.repository_id, run, expiresAt)
  return Response.json({ key, expiresAt, models })
}
