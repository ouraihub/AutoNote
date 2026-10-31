import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt } from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { buildNoteDerivedStatements } from '../db/writes'
import { loadNote, loadNoteRow, restoredVersionTitle, shiftSqlPlaceholders } from './notes-shared'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { enqueueNoteIndex } from '../mcp/ai-search'
import type { Hono } from 'hono'
import type { AppBindings } from '../env'

export function registerNotesVersionRoutes(routes: Hono<AppBindings>): void {
  const notesRoutes = routes

notesRoutes.get('/:id/versions', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, note_id, title, length(CAST(content AS BLOB)) AS size, created_at FROM note_versions
       WHERE note_id = ?1 AND user_id = ?2 ORDER BY created_at DESC LIMIT 100`,
  )
    .bind(c.req.param('id'), c.get('userId'))
    .all<{
      id: string
      note_id: string
      title: string
      size: number
      created_at: number
    }>()

  return c.json({
    versions: results.map((r) => ({
      id: r.id,
      noteId: r.note_id,
      title: r.title,
      size: r.size,
      createdAt: r.created_at,
    })),
  })
})

notesRoutes.get('/:id/versions/:versionId', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT id, note_id, title, content, length(CAST(content AS BLOB)) AS size, created_at FROM note_versions
       WHERE id = ?1 AND note_id = ?2 AND user_id = ?3`,
  )
    .bind(c.req.param('versionId'), c.req.param('id'), c.get('userId'))
    .first<{
      id: string
      note_id: string
      title: string
      content: string
      size: number
      created_at: number
    }>()
  if (!row) throw ApiError.notFound('Version not found')
  return c.json({
    id: row.id,
    noteId: row.note_id,
    title: row.title,
    content: row.content,
    size: row.size,
    createdAt: row.created_at,
  })
})

notesRoutes.post('/:id/versions/:versionId/restore', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')

  const version = await c.env.DB.prepare(
    `SELECT title, content FROM note_versions WHERE id = ?1 AND note_id = ?2 AND user_id = ?3`,
  )
    .bind(c.req.param('versionId'), id, userId)
    .first<{ title: string; content: string }>()
  if (!version) throw ApiError.notFound('Version not found')

  const current = await loadNoteRow(c.env.DB, userId, id)
  const now = Math.max(Date.now(), current.updated_at + 1)
  const { words, chars } = countText(version.content)
  const title = restoredVersionTitle(version.title)
  const hash = await sha256Hex(version.content)
  const nextRev = current.rev + 1
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [id, userId, nextRev, hash, title, now] as const
  const update = c.env.DB.prepare(
    `UPDATE notes SET content = ?1, title = ?2, excerpt = ?3, word_count = ?4, char_count = ?5,
       content_hash = ?6, rev = ?7, updated_at = ?8
       WHERE id = ?9 AND user_id = ?10 AND rev = ?11`,
  ).bind(
    version.content,
    title,
    deriveExcerpt(version.content),
    words,
    chars,
    hash,
    nextRev,
    now,
    id,
    userId,
    current.rev,
  )
  const snapshot = c.env.DB.prepare(
    `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
      WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
  ).bind(
    newId(),
    id,
    userId,
    current.title,
    current.content,
    utf8ByteLength(current.content),
    now,
    ...mutationValues,
  )
  const trimVersions = c.env.DB.prepare(
    `DELETE FROM note_versions WHERE note_id = ?1
       AND ${shiftSqlPlaceholders(mutationGuard, 1)}
       AND id IN (SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
  ).bind(id, ...mutationValues, LIMITS.versionsPerNote)
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: id,
    title,
    content: version.content,
    ftsEnabled,
    titleChanged: true,
    previousTitle: current.title,
    expectedRev: nextRev,
    expectedContentHash: hash,
    expectedTitle: title,
    expectedUpdatedAt: now,
    deleted: current.deleted_at !== null,
  }).statements
  const change = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'note', ?2, 'upsert', ?3
      WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
  ).bind(userId, id, now, ...mutationValues)
  const [updated] = await c.env.DB.batch([
    update,
    snapshot,
    trimVersions,
    ...derived,
    change,
  ])
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
}
