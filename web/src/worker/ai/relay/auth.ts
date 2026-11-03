import { getMeta, setMeta } from '../../db/metadata'
import { sha256Hex, toBase64Url } from '../../lib/encoding'
import { newId } from '../../lib/id'
import { KitFailure } from '../kit'
import { ACTIVE_KEYS_MAX, KEY_RE, MAX_CONCURRENT_GITHUB, MAX_CONCURRENT_MANUAL, type LineRow, type RelayKey, type RelayModel, type RelayRepo, normalizeWorkflow, today } from './shared'

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

export async function createRelayKey(db: D1Database, userId: string, name: string): Promise<{ key: RelayKey; token: string }> {
  const { id, token, hash, now } = await mint()
  const inserted = await db.prepare(`INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE (SELECT COUNT(*) FROM relay_access_keys WHERE user_id = ?2 AND revoked_at IS NULL AND expires_at IS NULL) < ?6`)
    .bind(id, userId, name, hash, now, ACTIVE_KEYS_MAX).run()
  if (!inserted.meta.changes) throw new KitFailure('conflict', `at most ${ACTIVE_KEYS_MAX} active relay keys`, { reason: 'too_many', limit: ACTIVE_KEYS_MAX })
  return { key: { id, name, createdAt: now, lastUsedAt: null, expiresAt: null, todayRequests: 0 }, token }
}

export async function issueGithubKey(db: D1Database, owner: RelayRepo & { userId: string }, repositoryId: string, run: string, expiresAt: number): Promise<string> {
  const { id, token, hash, now } = await mint()
  const { repo, userId, workflow, ref } = owner
  const values = [repo, userId, workflow, ref, repositoryId] as const
  const registered = `EXISTS (SELECT 1 FROM relay_github_repos WHERE repo = ?1 AND user_id = ?2 AND workflow = ?3 AND ref = ?4 AND repository_id = ?5)`
  const results = await db.batch([
    db.prepare(`UPDATE relay_github_repos SET repository_id = ?5 WHERE repo = ?1 AND user_id = ?2 AND workflow = ?3 AND ref = ?4 AND (repository_id IS NULL OR repository_id = ?5)`).bind(...values),
    db.prepare(`DELETE FROM relay_access_keys WHERE user_id = ?2 AND expires_at IS NOT NULL AND expires_at <= ?6 AND ${registered}`).bind(...values, now),
    db.prepare(`UPDATE relay_access_keys SET revoked_at = ?6 WHERE user_id = ?2 AND github_run = ?7 AND revoked_at IS NULL AND ${registered}`).bind(...values, now, run),
    db.prepare(`UPDATE relay_access_keys SET revoked_at = ?6 WHERE ${registered} AND id IN (SELECT id FROM relay_access_keys WHERE user_id = ?2 AND substr(github_run, 1, length(?7)) = ?7 AND revoked_at IS NULL AND expires_at > ?6 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`).bind(...values, now, `${repo}#`, ACTIVE_KEYS_MAX - 1),
    db.prepare(`INSERT INTO relay_access_keys (id, user_id, name, key_hash, created_at, expires_at, github_run)
                SELECT ?6, ?2, ?7, ?8, ?9, ?10, ?11 WHERE ${registered}`).bind(...values, id, `GitHub ${repo} ${run.split('#')[1]}`, hash, now, expiresAt, run),
  ])
  if (!results[4]!.meta.changes) throw new KitFailure('unauthorized', 'GitHub token rejected: repository registration changed', { reason: 'repository_id' })
  return token
}

export async function listRelayKeys(db: D1Database, userId: string): Promise<RelayKey[]> {
  const now = Date.now()
  const { results } = await db.prepare(`SELECT id, name, created_at AS createdAt, last_used_at AS lastUsedAt, expires_at AS expiresAt, day, day_requests AS dayRequests
         FROM relay_access_keys WHERE user_id = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2) ORDER BY created_at DESC`).bind(userId, now)
    .all<Omit<RelayKey, 'todayRequests'> & { day: string | null; dayRequests: number }>()
  return results.map(({ day, dayRequests, ...key }) => ({ ...key, todayRequests: day === today(now) ? dayRequests : 0 }))
}

export async function revokeRelayKey(db: D1Database, userId: string, id: string): Promise<boolean> {
  const result = await db.prepare('UPDATE relay_access_keys SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL').bind(Date.now(), id, userId).run()
  return (result.meta.changes ?? 0) > 0
}

export async function purgeRelayKeys(db: D1Database): Promise<void> {
  const cutoff = Date.now() - 86_400_000
  await db.prepare('DELETE FROM relay_access_keys WHERE (revoked_at IS NOT NULL AND revoked_at < ?1) OR (expires_at IS NOT NULL AND expires_at < ?1)').bind(cutoff).run()
}

export async function verifyRelayKey(db: D1Database, token: string): Promise<{ userId: string; keyId: string; maxConcurrent: number } | null> {
  if (!KEY_RE.test(token)) return null
  const now = Date.now()
  const day = today(now)
  const row = await db.prepare(`UPDATE relay_access_keys SET last_used_at = ?2, day_requests = CASE WHEN day = ?3 THEN day_requests + 1 ELSE 1 END, day = ?3
        WHERE key_hash = ?1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?2)
        RETURNING id, user_id AS userId, github_run IS NOT NULL AS github`).bind(await sha256Hex(token), now, day)
    .first<{ id: string; userId: string; github: number }>()
  return row ? { userId: row.userId, keyId: row.id, maxConcurrent: row.github ? MAX_CONCURRENT_GITHUB : MAX_CONCURRENT_MANUAL } : null
}

export async function listRelayRepos(db: D1Database, userId: string): Promise<RelayRepo[]> {
  const { results } = await db.prepare('SELECT repo, workflow, ref FROM relay_github_repos WHERE user_id = ?1 ORDER BY repo').bind(userId).all<RelayRepo>()
  return results
}

export async function addRelayRepo(db: D1Database, userId: string, input: RelayRepo): Promise<void> {
  const repo = input.repo.toLowerCase()
  const saved = await db.prepare(`INSERT INTO relay_github_repos (repo, user_id, workflow, ref, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(repo) DO UPDATE SET workflow = excluded.workflow, ref = excluded.ref WHERE relay_github_repos.user_id = excluded.user_id`)
    .bind(repo, userId, normalizeWorkflow(input.workflow), input.ref, Date.now()).run()
  if (!saved.meta.changes) throw new KitFailure('conflict', `repository ${repo} is registered by another user`, { reason: 'repo_taken' })
}

export async function removeRelayRepo(db: D1Database, userId: string, repo: string): Promise<boolean> {
  const result = await db.prepare('DELETE FROM relay_github_repos WHERE user_id = ?1 AND repo = ?2').bind(userId, repo.toLowerCase()).run()
  return (result.meta.changes ?? 0) > 0
}

async function modelLines(db: D1Database, userId: string, modelType: 'chat' | 'image'): Promise<LineRow[]> {
  const { results } = await db.prepare(`SELECT e.id AS endpointId, e.base_url AS baseUrl, e.image_base_url AS imageBaseUrl, e.image_edit_base_url AS imageEditBaseUrl,
              e.protocol, e.headers, e.key_strategy AS keyStrategy, e.slug, p.id AS providerId, p.name AS providerName, m.model_id AS modelId, m.model_type AS modelType
         FROM ai_models m JOIN ai_endpoints e ON e.id = m.endpoint_id AND e.user_id = m.user_id JOIN ai_providers p ON p.id = e.provider_id AND p.user_id = m.user_id
        WHERE m.user_id = ?1 AND p.enabled = 1 AND m.model_type = ?2 ORDER BY p.position, p.id, e.position, e.id, m.position`).bind(userId, modelType).all<LineRow>()
  return results
}

export async function relayModels(db: D1Database, userId: string): Promise<RelayModel[]> {
  const first = new Map<string, string>(); const seen = new Set<string>(); const providers = new Set<string>(); const models: RelayModel[] = []
  for (const modelType of ['chat', 'image'] as const) for (const line of await modelLines(db, userId, modelType)) {
    const model = `${line.modelId}\u0000${line.protocol}`; const providerModel = `${line.providerId}\u0000${model}`
    if (providers.has(providerModel)) continue
    providers.add(providerModel); if (!first.has(model)) first.set(model, line.providerId)
    const id = first.get(model) === line.providerId ? line.modelId : `${line.providerName}/${line.modelId}`; const key = `${id}\u0000${line.protocol}\u0000${modelType}`
    if (seen.has(key)) continue
    seen.add(key); models.push({ id, object: 'model', owned_by: line.providerName, protocol: line.protocol, model_type: modelType })
  }
  return models
}

export { modelLines }
