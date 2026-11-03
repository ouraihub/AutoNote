/**
 * Private AI semantic search for the MCP module.
 *
 * Notes are embedded with Workers AI (`@cf/baai/bge-m3`, 1024 dims,
 * multilingual) and the vectors live in D1 — no public query endpoint, one
 * index per account. Content changes are queued and drained in the
 * background; when the AI binding is missing or the model call fails the
 * feature degrades to plain lexical search instead of failing (the old
 * behavior that surfaced as HTTP 503s).
 */
import { getMeta, selectQueueUsersRoundRobin, setMeta } from '../db/metadata'
import type { Env } from '../env'
import {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  semanticWhere,
} from './ai-search-tail'
import { extractEmbedding } from './ai-embedding'
export {
  cosineSimilarity,
  decodeVector,
  encodeVector,
  semanticSnippet,
} from './ai-search-tail'
export { extractEmbedding } from './ai-embedding'

export const AI_EMBEDDING_MODEL = '@cf/baai/bge-m3'
const EMBED_TEXT_MAX_CHARS = 4_000
const MAX_SEMANTIC_VECTORS = 8_000
const SEMANTIC_TOP_K = 40
const DRAIN_USERS_PER_RUN = 10
const DRAIN_PER_USER = 25
const AI_DRAIN_CURSOR_META_KEY = 'ai-index-drain-user-v1'
const ENQUEUE_CHUNK = 200
export { RRF_K, fuseByRrf, type FusedHit } from './ai-ranking'

export type AiIndexKind = 'embed' | 'delete'

export interface AiSearchStatus {
  available: boolean
  enabled: boolean
  model: string
  indexedCount: number
  pendingCount: number
  reason: 'no_ai_binding' | null
}

export interface SemanticSearchHit {
  id: string
  title: string
  excerpt: string
  rev: number
  updatedAt: number
  score: number
}

interface QueueRow {
  note_id: string
  kind: AiIndexKind
  created_at: number
}

interface EmbeddingRow {
  id: string
  title: string
  excerpt: string
  rev: number
  updated_at: number
  vector: ArrayBuffer
}

export interface SemanticFilters {
  tags?: string[]
  folder?: string
  starred?: boolean
  archived?: boolean
}

export function isAiSearchAvailable(env: Env): boolean {
  return Boolean(env.AI)
}

export async function getAiSearchStatus(
  db: D1Database,
  env: Env,
  userId: string,
): Promise<AiSearchStatus> {
  const [enabled, indexed, pending] = await Promise.all([
    isAiSearchEnabled(db, userId),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM ai_note_embeddings WHERE user_id = ?1`,
      )
      .bind(userId)
      .first<{ n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM ai_index_queue WHERE user_id = ?1`)
      .bind(userId)
      .first<{ n: number }>(),
  ])
  return {
    available: isAiSearchAvailable(env),
    enabled,
    model: AI_EMBEDDING_MODEL,
    indexedCount: indexed?.n ?? 0,
    pendingCount: pending?.n ?? 0,
    reason: isAiSearchAvailable(env) ? null : 'no_ai_binding',
  }
}

export async function setAiSearchEnabled(
  db: D1Database,
  userId: string,
  enabled: boolean,
): Promise<void> {
  await setMeta(db, aiSearchPrefKey(userId), enabled ? '1' : '0')
}

export async function isAiSearchEnabled(
  db: D1Database,
  userId: string,
): Promise<boolean> {
  return (await getMeta(db, aiSearchPrefKey(userId))) === '1'
}

// Stored in app_meta instead of a column on mcp_preferences: D1 does not
// reliably support ALTER TABLE ADD COLUMN with constraints, and app_meta
// exists on every database without any migration.
function aiSearchPrefKey(userId: string): string {
  return `ai-search-enabled:${userId}`
}

/**
 * Queues a note for embedding (or vector deletion). The single row per note
 * uses last-write-wins semantics: a delete supersedes a pending embed and
 * vice versa. Queuing is skipped entirely while the account has AI search
 * disabled, except deletions which always clean up stale vectors.
 */
export async function enqueueNoteIndex(
  db: D1Database,
  userId: string,
  noteId: string,
  kind: AiIndexKind,
  now = Date.now(),
): Promise<void> {
  await noteIndexQueueStatement(db, userId, noteId, kind, now).run()
}

export function noteIndexQueueStatement(
  db: D1Database,
  userId: string,
  noteId: string,
  kind: AiIndexKind,
  now = Date.now(),
): D1PreparedStatement {
  const guard =
    kind === 'embed'
      ? ` WHERE EXISTS (SELECT 1 FROM app_meta WHERE key = ?5 AND value = '1')`
      : ` WHERE ${aiDeleteNeededSql('?1', '?2')}`
  const statement = db.prepare(
    'INSERT OR REPLACE INTO ai_index_queue ' +
      '(user_id, note_id, kind, created_at)\n' +
      '     SELECT ?1, ?2, ?3,\n' +
      '       ' +
      'MAX(?4, COALESCE((SELECT created_at + 1 FROM ai_index_queue\n' +
      '         ' +
      `WHERE user_id = ?1 AND note_id = ?2), ?4))${guard}`,
  )
  return kind === 'embed'
    ? statement.bind(userId, noteId, kind, now, aiSearchPrefKey(userId))
    : statement.bind(userId, noteId, kind, now)
}

export function aiDeleteNeededSql(userId: string, noteId: string): string {
  return `(EXISTS (SELECT 1 FROM ai_note_embeddings
    WHERE user_id = ${userId} AND note_id = ${noteId})
    OR EXISTS (SELECT 1 FROM ai_index_queue
      WHERE user_id = ${userId} AND note_id = ${noteId}))`
}

export async function enqueueAllNotesForIndex(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<number> {
  const boundary = await db
    .prepare(
      `SELECT MAX(id) AS id FROM notes ` +
        `WHERE user_id = ?1 AND deleted_at IS NULL`,
    )
    .bind(userId)
    .first<{ id: string | null }>()
  const lastId = boundary?.id
  if (!lastId) return 0

  let cursor = ''
  let enqueued = 0
  while (cursor < lastId) {
    const { results } = await db
      .prepare(
        `SELECT id FROM notes
        WHERE user_id = ?1 AND deleted_at IS NULL AND id > ?2 AND id <= ?3
        ORDER BY id ASC LIMIT ?4`,
      )
      .bind(userId, cursor, lastId, ENQUEUE_CHUNK)
      .all<{ id: string }>()
    if (!results.length) break

    const statements = results.map(({ id }) =>
      db
        .prepare(
          'INSERT OR REPLACE INTO ai_index_queue ' +
            '(user_id, note_id, kind, created_at)\n' +
            "       SELECT ?1, ?2, 'embed',\n" +
            '         ' +
            'MAX(?3, COALESCE((SELECT created_at + 1 FROM ai_index_queue\n' +
            '           WHERE user_id = ?1 AND note_id = ?2), ?3))',
        )
        .bind(userId, id, now),
    )
    await db.batch(statements)
    enqueued += results.length
    cursor = results[results.length - 1]!.id
  }
  return enqueued
}

export async function clearAiIndex(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM ai_note_embeddings WHERE user_id = ?1`)
    .bind(userId)
    .first<{ n: number }>()
  await db.batch([
    db
      .prepare(`DELETE FROM ai_note_embeddings WHERE user_id = ?1`)
      .bind(userId),
    db.prepare(`DELETE FROM ai_index_queue WHERE user_id = ?1`).bind(userId),
  ])
  return row?.n ?? 0
}

/**
 * Processes queued embedding jobs. Called from the hourly cron with a large
 * budget and from write paths (via waitUntil) with a small one. Items are
 * processed sequentially so Workers AI rate limits are respected; a failing
 * item stops the batch and is retried on the next run.
 */
export async function drainAiIndexQueue(
  env: Env,
  max: number,
): Promise<{ processed: number }> {
  if (!env.AI) return { processed: 0 }
  const budget = Math.max(0, Math.trunc(max))
  if (!Number.isFinite(budget) || budget === 0) return { processed: 0 }
  let processed = 0
  const users = await selectQueueUsersRoundRobin(
    env.DB,
    'ai_index_queue',
    AI_DRAIN_CURSOR_META_KEY,
    Math.min(DRAIN_USERS_PER_RUN, Math.ceil(budget / DRAIN_PER_USER)),
  )
  for (const user_id of users) {
    if (processed >= budget) break
    if (!(await isAiSearchEnabled(env.DB, user_id))) {
      // The account turned AI search off;
      // its queue would otherwise grow forever.
      await env.DB.prepare(`DELETE FROM ai_index_queue WHERE user_id = ?1`)
        .bind(user_id)
        .run()
      continue
    }
    processed += await drainUserQueue(
      env,
      user_id,
      Math.min(budget - processed, DRAIN_PER_USER),
    )
  }
  return { processed }
}

async function drainUserQueue(
  env: Env,
  userId: string,
  max: number,
): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT note_id, kind, created_at FROM ai_index_queue
      WHERE user_id = ?1 ORDER BY created_at ASC LIMIT ?2`,
  )
    .bind(userId, max)
    .all<QueueRow>()
  let done = 0
  for (const item of results) {
    try {
      await processQueueItem(env, userId, item)
      done++
    } catch (error) {
      console.warn(
        '[autonote] AI index drain paused:',
        error instanceof Error ? error.message : error,
      )
      break
    }
  }
  return done
}

async function processQueueItem(
  env: Env,
  userId: string,
  item: QueueRow,
): Promise<void> {
  const db = env.DB
  const ai = env.AI
  if (!ai) return
  const queueGuard = `EXISTS (SELECT 1 FROM ai_index_queue
    WHERE user_id = ?3 AND note_id = ?4 AND kind = ?5 AND created_at = ?6)`
  const insertQueueGuard = `EXISTS (SELECT 1 FROM ai_index_queue
    WHERE user_id = ?6 AND note_id = ?7 AND kind = ?8 AND created_at = ?9)`
  if (item.kind === 'delete') {
    await db.batch([
      db
        .prepare(
          `DELETE FROM ai_note_embeddings
          WHERE user_id = ?1 AND note_id = ?2 AND ${queueGuard}`,
        )
        .bind(
          userId,
          item.note_id,
          userId,
          item.note_id,
          item.kind,
          item.created_at,
        ),
      db
        .prepare(
          'DELETE FROM ai_index_queue\n' +
            '          WHERE user_id = ?1 AND note_id = ?2 ' +
            'AND kind = ?3 AND created_at = ?4',
        )
        .bind(userId, item.note_id, item.kind, item.created_at),
    ])
    return
  }
  const note = await db
    .prepare(
      `SELECT title, content FROM notes
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    )
    .bind(item.note_id, userId)
    .first<{ title: string; content: string }>()
  if (!note) {
    await db.batch([
      db
        .prepare(
          `DELETE FROM ai_note_embeddings
          WHERE user_id = ?1 AND note_id = ?2 AND ${queueGuard}`,
        )
        .bind(
          userId,
          item.note_id,
          userId,
          item.note_id,
          item.kind,
          item.created_at,
        ),
      db
        .prepare(
          'DELETE FROM ai_index_queue\n' +
            '          WHERE user_id = ?1 AND note_id = ?2 ' +
            'AND kind = ?3 AND created_at = ?4',
        )
        .bind(userId, item.note_id, item.kind, item.created_at),
    ])
    return
  }
  const text = `${note.title}\n${note.content}`.slice(0, EMBED_TEXT_MAX_CHARS)
  const vector = await embedText(ai, text)
  await db.batch([
    db
      .prepare(
        'INSERT INTO ai_note_embeddings ' +
          '(user_id, note_id, model, vector, indexed_at)\n' +
          '       ' +
          `SELECT ?1, ?2, ?3, ?4, ?5 WHERE ${insertQueueGuard}\n` +
          '       ON CONFLICT(user_id, note_id) DO UPDATE SET\n' +
          '         ' +
          'vector = excluded.vector, indexed_at = excluded.indexed_at',
      )
      .bind(
        userId,
        item.note_id,
        AI_EMBEDDING_MODEL,
        encodeVector(vector),
        Date.now(),
        userId,
        item.note_id,
        item.kind,
        item.created_at,
      ),
    db
      .prepare(
        'DELETE FROM ai_index_queue\n' +
          '        WHERE user_id = ?1 AND note_id = ?2 ' +
          'AND kind = ?3 AND created_at = ?4',
      )
      .bind(userId, item.note_id, item.kind, item.created_at),
  ])
}

/**
 * Semantic retrieval over the account's embedding index. Returns null when
 * AI is unavailable or the query embedding fails; the caller degrades to
 * lexical search.
 */
export async function searchSemanticNotes(
  env: Env,
  db: D1Database,
  userId: string,
  query: string,
  filters: SemanticFilters,
): Promise<SemanticSearchHit[] | null> {
  if (!env.AI || !(await isAiSearchEnabled(db, userId))) return null
  const queryVector = await embedText(env.AI, query)
  const { binds, where } = semanticWhere(userId, filters)
  binds.push(MAX_SEMANTIC_VECTORS)
  const { results } = await db
    .prepare(
      `SELECT n.id, n.title, n.excerpt, n.rev, n.updated_at, e.vector
       FROM ai_note_embeddings e JOIN notes n
         ON n.id = e.note_id AND n.user_id = e.user_id
      WHERE ${where}
      LIMIT ?${binds.length}`,
    )
    .bind(...binds)
    .all<EmbeddingRow>()
  if (!results.length) return []

  const scored = results.map((row) => ({
    row,
    score: cosineSimilarity(queryVector, decodeVector(row.vector)),
  }))
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.row.updated_at - a.row.updated_at ||
      a.row.id.localeCompare(b.row.id),
  )
  return scored.slice(0, SEMANTIC_TOP_K).map(({ row, score }) => ({
    id: row.id,
    title: row.title,
    excerpt: row.excerpt,
    rev: row.rev,
    updatedAt: row.updated_at,
    score,
  }))
}

/** Calls the Workers AI embedding model and returns a Float32Array. */
export async function embedText(
  ai: NonNullable<Env['AI']>,
  text: string,
): Promise<Float32Array> {
  const result = await ai.run(AI_EMBEDDING_MODEL, { text: [text] })
  return extractEmbedding(result)
}
