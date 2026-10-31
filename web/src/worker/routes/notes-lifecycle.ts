import type { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { duplicateNoteTitle } from '@shared/text-utils'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { enqueueNoteIndex, aiDeleteNeededSql } from '../mcp/ai-search'
import { NOTE_COLUMNS_FULL, toNote, type NoteRow } from '../db/rows'
import { buildNoteDerivedStatements, changeStatement, FTS_QUEUE_CONFLICT_SQL, LINK_TARGET_SUBQUERY } from '../db/writes'
import { loadNote, loadNoteRow, shiftSqlPlaceholders } from './notes-shared'
import type { AppBindings } from '../env'
export function registerNotesLifecycleRoutes(routes: Hono<AppBindings>): void {
  const notesRoutes = routes

notesRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')

  const row = await loadNoteRow(c.env.DB, userId, id)
  if (row.deleted_at !== null)
    throw ApiError.notFound('The note does not exist or is in the trash')
  const now = Math.max(Date.now(), row.updated_at + 1)
  const nextRev = row.rev + 1
  const guard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL)`
  const statements = [
    c.env.DB.prepare(
      `UPDATE notes SET deleted_at = ?1, updated_at = ?1, rev = ?2
        WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NULL`,
    ).bind(now, nextRev, id, userId, row.rev),
    c.env.DB.prepare(
      `DELETE FROM links WHERE source_note_id = ?1 AND ${shiftSqlPlaceholders(guard, 1)}`,
    ).bind(id, id, userId, nextRev),
    c.env.DB.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
        WHERE target_note_id = ?1 AND user_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
    ).bind(id, userId, id, userId, nextRev),
  ]
  if (ftsEnabled) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
          SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
          ${FTS_QUEUE_CONFLICT_SQL}`,
      ).bind(userId, id, now, id, userId, nextRev),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         AND ${aiDeleteNeededSql('?1', '?2')}`,
    ).bind(userId, id, now, id, userId, nextRev),
  )
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
       RETURNING seq`,
    ).bind(userId, id, now, id, userId, nextRev),
  )
  const results = await c.env.DB.batch(statements)
  const updated = results[0]
  if (!updated?.meta.changes) {
    throw ApiError.conflict('This note was modified elsewhere', {
      server: await loadNote(c.env.DB, userId, id),
    })
  }
  const changeResult = results.at(-1) as D1Result<{ seq: number }> | undefined
  await broadcastCursor(c, changeResult?.results?.[0]?.seq)
  scheduleFtsDrain(c)
  const note = toNote({
    ...row,
    deleted_at: now,
    updated_at: now,
    rev: nextRev,
  })
  return c.json(note)
})

notesRoutes.post('/:id/restore', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const row = await loadNoteRow(c.env.DB, userId, id)
  if (row.deleted_at === null)
    throw ApiError.badRequest('The note is not in the trash')

  const now = Math.max(Date.now(), row.updated_at + 1)
  const nextRev = row.rev + 1
  const update = c.env.DB.prepare(
    `UPDATE notes SET deleted_at = NULL, updated_at = ?1, rev = ?2
      WHERE id = ?3 AND user_id = ?4 AND rev = ?5 AND deleted_at IS NOT NULL`,
  ).bind(now, nextRev, id, userId, row.rev)
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: id,
    title: row.title,
    content: row.content,
    ftsEnabled,
    titleChanged: true,
    expectedRev: nextRev,
    expectedContentHash: row.content_hash,
    expectedTitle: row.title,
    expectedUpdatedAt: now,
  }).statements
  const change = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'note', ?2, 'upsert', ?3
      WHERE EXISTS (SELECT 1 FROM notes WHERE id = ?2 AND user_id = ?1 AND rev = ?4 AND deleted_at IS NULL)`,
  ).bind(userId, id, now, nextRev)
  const [updated] = await c.env.DB.batch([update, ...derived, change])
  if (!updated?.meta.changes) {
    throw ApiError.conflict('This note was modified elsewhere', {
      server: await loadNote(c.env.DB, userId, id),
    })
  }
  await broadcastCursor(c)
  await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
  scheduleFtsDrain(c)
  const note = await loadNote(c.env.DB, userId, id)
  return c.json(note)
})

notesRoutes.delete('/:id/purge', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const row = await loadNoteRow(c.env.DB, userId, id)
  if (row.deleted_at === null)
    throw ApiError.notFound('The note does not exist or is not in the trash')
  const guard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL)`
  const guarded = (sql: string) =>
    c.env.DB.prepare(`${sql} AND ${shiftSqlPlaceholders(guard, 1)}`).bind(
      id,
      id,
      userId,
      row.rev,
    )
  const statements: D1PreparedStatement[] = [
    guarded(`DELETE FROM note_tags WHERE note_id = ?1`),
    guarded(`DELETE FROM links WHERE source_note_id = ?1`),
    c.env.DB.prepare(
      `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
        WHERE target_note_id = ?1 AND user_id = ?2 AND ${shiftSqlPlaceholders(guard, 2)}`,
    ).bind(id, userId, id, userId, row.rev),
    guarded(`DELETE FROM note_versions WHERE note_id = ?1`),
    c.env.DB.prepare(
      `DELETE FROM share_asset_sessions
        WHERE slug IN (SELECT slug FROM shares WHERE note_id = ?1 AND user_id = ?2)
          AND ${shiftSqlPlaceholders(guard, 2)}`,
    ).bind(id, userId, id, userId, row.rev),
    guarded(`DELETE FROM shares WHERE note_id = ?1`),
    guarded(`UPDATE attachments SET note_id = NULL WHERE note_id = ?1`),
    c.env.DB.prepare(
      `DELETE FROM import_mappings
        WHERE user_id = ?1 AND entity = 'note' AND target_id = ?2
          AND EXISTS (SELECT 1 FROM notes
            WHERE id = ?2 AND user_id = ?1 AND rev = ?3 AND deleted_at IS NOT NULL)`,
    ).bind(userId, id, row.rev),
  ]
  if (ftsEnabled) {
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
          SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
          ${FTS_QUEUE_CONFLICT_SQL}`,
      ).bind(userId, id, Date.now(), id, userId, row.rev),
    )
  }
  statements.push(
    c.env.DB.prepare(
      `INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
       SELECT ?1, ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
         AND ${aiDeleteNeededSql('?1', '?2')}`,
    ).bind(userId, id, Date.now(), id, userId, row.rev),
  )
  statements.push(
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'delete', ?3 WHERE ${shiftSqlPlaceholders(guard, 3)}
       RETURNING seq`,
    ).bind(userId, id, Date.now(), id, userId, row.rev),
    c.env.DB.prepare(
      `DELETE FROM notes WHERE id = ?1 AND user_id = ?2 AND rev = ?3 AND deleted_at IS NOT NULL`,
    ).bind(id, userId, row.rev),
    c.env.DB.prepare(
      `DELETE FROM tags
      WHERE user_id = ?1 AND is_manual = 0
        AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`,
    ).bind(userId),
  )
  const results = await c.env.DB.batch(statements)
  const changeResult = results.at(-3) as D1Result<{ seq: number }> | undefined
  const deleted = results.at(-2)
  if (!deleted?.meta.changes)
    throw ApiError.conflict('Note state changed. Refresh and try again')
  const broadcastedCursor = await broadcastCursor(
    c,
    changeResult?.results?.[0]?.seq,
  )
  const deletionCursor = changeResult?.results[0]?.seq
  scheduleFtsDrain(c)
  return c.json({
    ok: true,
    cursor: Number.isSafeInteger(deletionCursor)
      ? deletionCursor!
      : broadcastedCursor,
  })
})

notesRoutes.post('/:id/duplicate', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const source = await loadNoteRow(c.env.DB, userId, c.req.param('id'))
  const body = c.req.header('Content-Type')?.includes('application/json')
    ? await readJson<{ id?: string }>(c, JSON_BODY_LIMITS.small)
    : {}
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid note id')
  }

  const id = body.id ?? newId()
  if (body.id) {
    const existing = await c.env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
    )
      .bind(id, userId)
      .first<NoteRow>()
    if (existing) return c.json(toNote(existing))
    const collision = await c.env.DB.prepare(
      `SELECT user_id FROM notes WHERE id = ?1`,
    )
      .bind(id)
      .first<{ user_id: string }>()
    if (collision) throw ApiError.conflict('This note id is already in use')
  }
  const now = Date.now()
  const title = duplicateNoteTitle(source.title, LIMITS.titleMaxLength)
  const content = source.content
  const hash = await sha256Hex(content)

  const insert = c.env.DB.prepare(
    `INSERT INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, 0, ?9, ?10, ?11, ?12, ?12)`,
  ).bind(
    id,
    userId,
    source.folder_id,
    title,
    content,
    source.excerpt,
    source.word_count,
    source.char_count,
    source.is_archived,
    now,
    hash,
    now,
  )
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: id,
    title,
    content,
    ftsEnabled,
    expectedRev: 1,
    expectedContentHash: hash,
    expectedTitle: title,
    expectedUpdatedAt: now,
  }).statements
  try {
    await c.env.DB.batch([
      insert,
      ...derived,
      changeStatement(c.env.DB, userId, 'note', id, 'upsert'),
    ])
  } catch (error) {
    if (body.id) {
      const existing = await c.env.DB.prepare(
        `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
      )
        .bind(id, userId)
        .first<NoteRow>()
      if (existing) return c.json(toNote(existing))
      const collision = await c.env.DB.prepare(
        `SELECT user_id FROM notes WHERE id = ?1`,
      )
        .bind(id)
        .first<{ user_id: string }>()
      if (collision) throw ApiError.conflict('This note id is already in use')
    }
    throw error
  }
  await broadcastCursor(c)
  await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
  scheduleFtsDrain(c)
  const note = await loadNote(c.env.DB, userId, id)
  return c.json(note, 201)
})
}
