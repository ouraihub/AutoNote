import type { ExistingNoteIndex } from './types'
import type { ImportContext } from './types'
import { runBatched } from '../../db/writes'

export async function loadExistingNoteIndex(
  db: D1Database,
  userId: string,
  id: string,
  ctx: ImportContext,
): Promise<ExistingNoteIndex | null> {
  if (ctx.byId?.has(id)) return ctx.byId.get(id) ?? null
  const row = await db
    .prepare(
      `SELECT n.id, n.title, n.rev, n.updated_at
       FROM notes n
      WHERE n.user_id = ?1
        AND (
          n.id = ?2 OR n.id = (
            SELECT target_id FROM import_mappings
             WHERE user_id = ?1 AND entity = 'note' AND source_id = ?2
          )
        )
      ORDER BY CASE WHEN n.id = (
        SELECT target_id FROM import_mappings
         WHERE user_id = ?1 AND entity = 'note' AND source_id = ?2
      ) THEN 0 ELSE 1 END
      LIMIT 1`,
    )
    .bind(userId, id)
    .first<ExistingNoteIndex>()
  ctx.byId?.set(id, row ?? null)
  return row ?? null
}

export async function upsertImportMappings(
  db: D1Database,
  userId: string,
  entity: 'note' | 'attachment',
  mappings: readonly { sourceId: string; targetId: string }[],
): Promise<void> {
  const now = Date.now()
  await runBatched(
    db,
    mappings.map(({ sourceId, targetId }) =>
      db
        .prepare(
          'INSERT INTO import_mappings (user_id, entity, ' +
            'source_id, target_id, updated_at)\n         VALUES (?1, ' +
            '?2, ?3, ?4, ?5)\n         ON CONFLICT(user_id, entity, ' +
            'source_id) DO UPDATE SET\n           target_id = ' +
            'excluded.target_id,\n           updated_at = ' +
            'excluded.updated_at',
        )
        .bind(userId, entity, sourceId, targetId, now),
    ),
  )
}
