import type { Env } from '../env'
import { initializeDatabase } from '../db/schema'
import { deleteAttachmentObjects } from './backend'
import {
  parseAttachmentCleanupTarget,
  type AttachmentObjectStorage,
} from './keys'

interface CleanupRow {
  object_key: string
}

export async function drainAttachmentCleanup(
  env: Env,
  userId?: string,
  limit = 200,
): Promise<{ processed: number; pending: boolean }> {
  const capped = Math.max(1, Math.min(500, Math.trunc(limit)))
  const supported =
    env.FILES && env.FILES_KV
      ? '1 = 1'
      : env.FILES
        ? `substr(object_key, 1, 3) = 'r2:'`
        : env.FILES_KV
          ? `substr(object_key, 1, 3) = 'kv:'`
          : null

  if (!supported)
    return { processed: 0, pending: await hasPendingCleanup(env.DB, userId) }

  const statement = userId
    ? env.DB.prepare(
        `SELECT object_key FROM attachment_cleanup
          WHERE user_id = ?1 AND ${supported}
          ORDER BY created_at, object_key LIMIT ?2`,
      ).bind(userId, capped)
    : env.DB.prepare(
        `SELECT object_key FROM attachment_cleanup
          WHERE ${supported}
          ORDER BY created_at, object_key LIMIT ?1`,
      ).bind(capped)
  const { results } = await statement.all<CleanupRow>()
  if (!results.length)
    return { processed: 0, pending: await hasPendingCleanup(env.DB, userId) }

  const groups = new Map<
    AttachmentObjectStorage,
    Array<CleanupRow & { key: string }>
  >([
    ['r2', []],
    ['kv', []],
  ])
  for (const row of results) {
    const target = parseAttachmentCleanupTarget(row.object_key)
    if (!target) continue
    groups.get(target.storage)!.push({ ...row, key: target.key })
  }

  const deleted: CleanupRow[] = []
  for (const storage of ['r2', 'kv'] as const) {
    const rows = groups.get(storage)!
    if (!rows.length) continue
    try {
      await deleteAttachmentObjects(
        env,
        storage,
        rows.map((row) => row.key),
      )
      deleted.push(...rows)
    } catch (error) {
      console.warn(
        '[autonote] Attachment object cleanup will retry later:',
        error,
      )
    }
  }

  for (let index = 0; index < deleted.length; index += 100) {
    await env.DB.batch(
      deleted
        .slice(index, index + 100)
        .map((row) =>
          env.DB.prepare(
            `DELETE FROM attachment_cleanup WHERE object_key = ?1`,
          ).bind(row.object_key),
        ),
    )
  }
  return {
    processed: deleted.length,
    pending: await hasPendingCleanup(env.DB, userId),
  }
}

export async function runAttachmentCleanup(env: Env): Promise<void> {
  try {
    await initializeDatabase(env)
    for (let page = 0; page < 10; page++) {
      const result = await drainAttachmentCleanup(env, undefined, 500)
      if (!result.pending || result.processed === 0) break
    }
  } catch (error) {
    console.warn(
      '[autonote] Attachment object cleanup will retry during the next '
        + 'scheduled run:',
      error,
    )
  }
}

async function hasPendingCleanup(
  db: D1Database,
  userId?: string,
): Promise<boolean> {
  const row = userId
    ? await db
        .prepare(
          'SELECT 1 AS pending FROM attachment_cleanup WHERE user_id = ?1 ' +
            'LIMIT 1',
        )
        .bind(userId)
        .first<{ pending: number }>()
    : await db
        .prepare('SELECT 1 AS pending FROM attachment_cleanup LIMIT 1')
        .first<{ pending: number }>()
  return Boolean(row)
}
