import type { KeyStrategy } from '@ouraihub/aether-ui/ports'
import type { Env } from '../../env'
import { decryptAiKey } from '../../lib/crypto'

import { KitFailure, needsConfig } from '../kit'

import type { Connection, KeyRow } from './types'

export const KEY_COLUMNS =
  'id, endpoint_id AS endpointId, label, enabled, key' +
  '_ciphertext AS keyCiphertext, exhausted_until AS e' +
  'xhaustedUntil, exhausted_reason AS exhaustedReason'

export const plainKey = (
  env: Env,
  row: { id: string; keyCiphertext: string },
): Promise<string | null> =>
  decryptAiKey(env, row.id, row.keyCiphertext).catch(() => null)

export async function openKey(
  env: Env,
  row: { id: string; keyCiphertext: string },
): Promise<string> {
  const key = await plainKey(env, row)
  if (key === null) throw needsConfig('key_unreadable')
  return key
}

export async function endpointKeys(
  db: D1Database,
  userId: string,
  endpointId: string,
): Promise<KeyRow[]> {
  return (
    await db
      .prepare(
        'SELECT ' +
          `${KEY_COLUMNS}` +
          ' FROM ai_endpoint_keys WHERE user_id = ?1 AND endp' +
          'oint_id = ?2 ORDER BY position, id',
      )
      .bind(userId, endpointId)
      .all<KeyRow>()
  ).results
}

// ponytail: per-isolate cursor (docs/34 §3.4); restarts from the first key on a
// cold isolate.
const rotations = new WeakMap<D1Database, Map<string, number>>()

/**
 * Enabled keys of an endpoint, decrypted, starting one step further on every
 * call.
 */
export async function rotatedKeys(
  env: Env,
  userId: string,
  endpointId: string,
): Promise<string[]> {
  const rows = (await endpointKeys(env.DB, userId, endpointId)).filter(
    (row) => row.enabled !== 0,
  )
  const keys = await Promise.all(rows.map((row) => openKey(env, row)))
  if (!keys.length) return []
  let counters = rotations.get(env.DB)
  if (!counters) {
    counters = new Map()
    rotations.set(env.DB, counters)
  }
  const scope = JSON.stringify([userId, endpointId])
  const start = (counters.get(scope) ?? 0) % keys.length
  counters.set(scope, (start + 1) % keys.length)
  return [...keys.slice(start), ...keys.slice(0, start)]
}

const DAY_MS = 86_400_000

const COOLDOWN_MS = 60_000

/**
 * Keys for one request by the endpoint's strategy (docs/43 §3); `name` labels
 * the all-used-up error.
 */
export async function requestKeys(
  env: Env,
  userId: string,
  endpointId: string,
  strategy: KeyStrategy,
  name: string,
  // The painting line is resolved up front for a chat run: an all-paused
  // painting line must fail the tool call, not the chat.
  deferExhausted = false,
): Promise<Pick<Connection, 'apiKeys' | 'setAside' | 'exhaustion'>> {
  if (strategy === 'round_robin')
    return {
      apiKeys: await rotatedKeys(env, userId, endpointId),
      setAside: null,
    }
  const rows = (await endpointKeys(env.DB, userId, endpointId)).filter(
    (row) => row.enabled !== 0,
  )
  const now = Date.now()
  const usable = rows.filter(
    (row) => row.exhaustedUntil === null || row.exhaustedUntil <= now,
  )
  if (rows.length && !usable.length) {
    const resumeAt = Math.min(...rows.map((row) => row.exhaustedUntil ?? now))
    const failure = new KitFailure(
      'rate_limited',
      '线路 ' +
        `${name}` +
        ' 的密钥全部用完，最早 ' +
        `${new Date(resumeAt).toISOString()}` +
        ' 恢复',
      { reason: 'keys_exhausted' },
    )
    failure.resumeAt = resumeAt
    if (!deferExhausted) throw failure
    return { apiKeys: [], setAside: null, exhaustion: { failure } }
  }
  const apiKeys = await Promise.all(usable.map((row) => openKey(env, row)))
  if (!apiKeys.length) return { apiKeys, setAside: null }
  const ids = usable.map((row) => row.id)
  const pool: Pick<Connection, 'apiKeys' | 'setAside' | 'exhaustion'> = {
    apiKeys,
    exhaustion: { failure: null },
    setAside: async (key, until, reason) => {
      const index = apiKeys.indexOf(key)
      await env.DB.prepare(
        'UPDATE ai_endpoint_keys SET exhausted_until = ?1, ' +
          'exhausted_reason = ?2 WHERE id = ?3 AND user_id = ' +
          '?4',
      )
        .bind(until, reason, ids[index]!, userId)
        .run()
      // Later tool rounds of the same run reuse this pool.
      apiKeys.splice(index, 1)
      ids.splice(index, 1)
      if (!apiKeys.length) {
        try {
          await requestKeys(env, userId, endpointId, strategy, name)
        } catch (error) {
          if (error instanceof KitFailure) pool.exhaustion!.failure = error
          throw error
        }
      }
    },
  }
  return pool
}

const FAILOVER_STATUS = [401, 403, 429]

/**
 * Calls `attempt` with each key in order (once with `null` when there is none).
 * Rotation moves on only when the upstream rejects the key; fill-first also
 * sets used-up or rate-limited keys aside and retries a network failure once.
 */
export async function withKeys<T>(
  pool: Pick<Connection, 'apiKeys' | 'setAside' | 'exhaustion'>,
  attempt: (key: string | null) => Promise<T>,
): Promise<T> {
  if (pool.exhaustion?.failure) throw pool.exhaustion.failure
  // A fill-first pool emptied by earlier rounds of this run must not fall back
  // to a keyless request.
  if (pool.setAside && !pool.apiKeys.length)
    throw new KitFailure(
      'rate_limited',
      'every key of this line is set aside',
      { reason: 'keys_exhausted' },
    )
  const candidates = pool.apiKeys.length ? [...pool.apiKeys] : [null]
  let retried = false
  for (let index = 0; ; index++) {
    try {
      return await attempt(candidates[index] ?? null)
    } catch (error) {
      if (!(error instanceof KitFailure)) throw error
      const next = index + 1 < candidates.length
      const status = Number(error.details.status)
      if (!pool.setAside) {
        if (next && FAILOVER_STATUS.includes(status)) continue
        throw error
      }
      if (error.code === 'network' || error.code === 'timeout') {
        if (next && !retried) {
          retried = true
          continue
        }
        throw error
      }
      const facts = error.upstream
      const limited = status === 429 && facts?.usedUp === false
      if (!facts || (!limited && !facts.usedUp)) throw error
      await pool.setAside(
        candidates[index]!,
        Date.now() + (limited ? (facts.retryAfterMs ?? COOLDOWN_MS) : DAY_MS),
        facts.reason,
      )
      if (!next) throw error
    }
  }
}
