import type { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt, extractTags, normalizeLinkKey } from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import { splitTags, toNote, type NoteRow, NOTE_COLUMNS_FULL } from '../db/rows'
import { buildNoteDerivedStatements, LINK_TARGET_SUBQUERY } from '../db/writes'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor, scheduleFtsDrain } from '../lib/notify'
import { assertContentSize, JSON_BODY_LIMITS, readJson } from '../lib/request'
import { enqueueNoteIndex } from '../mcp/ai-search'
import type { AppBindings } from '../env'
import type { CreateNoteBody, PatchNoteBody } from '@shared/types'
import { applyPatchRow, loadNote, resolveFolderId, resolveNoteTitle, rewriteInboundWikiLinks, sameTagSet, shiftSqlPlaceholders, SNAPSHOT_DIFF_THRESHOLD, SNAPSHOT_INTERVAL_MS, push } from './notes-shared'

export function registerNotesWriteRoutes(routes: Hono<AppBindings>): void {
  const notesRoutes = routes


notesRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const body = await readJson<CreateNoteBody>(c, JSON_BODY_LIMITS.note)

  if (body.content !== undefined && typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a string')
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw ApiError.badRequest('title must be a string')
  }
  if (
    body.folderId !== undefined &&
    body.folderId !== null &&
    typeof body.folderId !== 'string'
  ) {
    throw ApiError.badRequest('folderId must be a string or null')
  }
  if (body.isStarred !== undefined && typeof body.isStarred !== 'boolean') {
    throw ApiError.badRequest('isStarred must be a boolean')
  }
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid note id')
  }
  const content = typeof body.content === 'string' ? body.content : ''
  assertContentSize(content)

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
  const title = resolveNoteTitle(body.title)
  const excerpt = deriveExcerpt(content)
  const { words, chars } = countText(content)
  const hash = await sha256Hex(content)
  const folderId = await resolveFolderId(
    c.env.DB,
    userId,
    body.folderId ?? null,
  )

  const insert = c.env.DB.prepare(
    `INSERT OR IGNORE INTO notes (id, user_id, folder_id, title, content, excerpt, rev, word_count, char_count,
       is_pinned, is_starred, is_archived, position, content_hash, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, 0, ?9, 0, ?10, ?11, ?12, ?12)`,
  ).bind(
    id,
    userId,
    folderId,
    title,
    content,
    excerpt,
    words,
    chars,
    body.isStarred ? 1 : 0,
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
  const createChange = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'note', ?2, 'upsert', ?3
      WHERE EXISTS (
        SELECT 1 FROM notes
         WHERE id = ?2 AND user_id = ?1 AND rev = 1
           AND content_hash = ?4 AND title = ?5 AND created_at = ?3 AND updated_at = ?3
      )`,
  ).bind(userId, id, now, hash, title)
  const [insertResult] = await c.env.DB.batch([
    insert,
    ...derived,
    createChange,
  ])
  const created = await c.env.DB.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  )
    .bind(id, userId)
    .first<NoteRow>()
  if (!created) throw ApiError.conflict('This note id is already in use')
  await broadcastCursor(c)
  if (insertResult?.meta.changes) {
    await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
    scheduleFtsDrain(c)
  }
  const note = toNote(created)
  return c.json(note, insertResult?.meta.changes ? 201 : 200)
})

notesRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const { ftsEnabled } = c.get('database')
  const body = await readJson<PatchNoteBody>(c, JSON_BODY_LIMITS.note)

  const row = await c.env.DB.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`,
  )
    .bind(id, userId)
    .first<NoteRow>()
  if (!row) {
    const deletion = await c.env.DB.prepare(
      `SELECT MAX(seq) AS seq FROM changes
        WHERE user_id = ?1 AND entity = 'note' AND entity_id = ?2 AND op = 'delete'`,
    )
      .bind(userId, id)
      .first<{ seq: number | null }>()
    throw ApiError.notFound('Note not found', {
      deletionCursor: deletion?.seq ?? null,
    })
  }

  if (!Number.isInteger(body.rev) || body.rev < 1) {
    throw ApiError.badRequest('rev must be a positive integer')
  }
  if (body.rev !== row.rev) {
    throw ApiError.conflict('This note was modified elsewhere', {
      server: toNote(row),
    })
  }
  if (body.content !== undefined && typeof body.content !== 'string') {
    throw ApiError.badRequest('content must be a string')
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw ApiError.badRequest('title must be a string')
  }
  if (
    body.folderId !== undefined &&
    body.folderId !== null &&
    typeof body.folderId !== 'string'
  ) {
    throw ApiError.badRequest('folderId must be a string or null')
  }
  for (const [key, value] of [
    ['isPinned', body.isPinned],
    ['isStarred', body.isStarred],
    ['isArchived', body.isArchived],
    ['quiet', body.quiet],
    ['preserveVersion', body.preserveVersion],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw ApiError.badRequest(`${key} must be a boolean`)
    }
  }

  const now = Math.max(Date.now(), row.updated_at + 1)
  const sets: string[] = []
  const binds: unknown[] = []
  let contentChanged = false
  let newTitle = row.title
  let newContent = row.content
  let newHash = row.content_hash
  const resolvedTitle = resolveNoteTitle(body.title, row.title)

  if (typeof body.content === 'string' && body.content !== row.content) {
    assertContentSize(body.content)
    const hash = await sha256Hex(body.content)
    if (hash !== row.content_hash) {
      contentChanged = true
      newHash = hash
      newContent = body.content
      newTitle = resolvedTitle
      const { words, chars } = countText(body.content)
      push(sets, binds, 'content', body.content)
      push(sets, binds, 'content_hash', hash)
      push(sets, binds, 'title', newTitle)
      push(sets, binds, 'excerpt', deriveExcerpt(body.content))
      push(sets, binds, 'word_count', words)
      push(sets, binds, 'char_count', chars)
    }
  } else if (resolvedTitle !== row.title) {
    newTitle = resolvedTitle
    push(sets, binds, 'title', newTitle)
  }

  if (body.folderId !== undefined && body.folderId !== row.folder_id) {
    push(
      sets,
      binds,
      'folder_id',
      await resolveFolderId(c.env.DB, userId, body.folderId),
    )
  }
  if (
    typeof body.isPinned === 'boolean' &&
    Number(body.isPinned) !== row.is_pinned
  )
    push(sets, binds, 'is_pinned', body.isPinned ? 1 : 0)
  if (
    typeof body.isStarred === 'boolean' &&
    Number(body.isStarred) !== row.is_starred
  )
    push(sets, binds, 'is_starred', body.isStarred ? 1 : 0)
  if (
    typeof body.isArchived === 'boolean' &&
    Number(body.isArchived) !== row.is_archived
  )
    push(sets, binds, 'is_archived', body.isArchived ? 1 : 0)

  if (!sets.length) return c.json(toNote(row))

  push(sets, binds, 'updated_at', now)
  const nextRev = row.rev + 1
  push(sets, binds, 'rev', nextRev)
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [id, userId, nextRev, newHash, newTitle, now] as const

  binds.push(id, userId, body.rev)
  const update = c.env.DB.prepare(
    `UPDATE notes SET ${sets.join(', ')}
      WHERE id = ?${binds.length - 2} AND user_id = ?${binds.length - 1} AND rev = ?${binds.length}`,
  ).bind(...binds)

  const statements: D1PreparedStatement[] = [update]
  let derivedTags: string[] | null = null

  if (contentChanged && !body.quiet && row.content) {
    const bigChange =
      Math.abs(newContent.length - row.content.length) >=
      SNAPSHOT_DIFF_THRESHOLD
    const snapshotId = newId()
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO note_versions (id, note_id, user_id, title, content, size, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}
            AND (?14 = 1
                 OR NOT EXISTS (SELECT 1 FROM note_versions WHERE note_id = ?2)
                 OR ?15 - COALESCE((SELECT MAX(created_at) FROM note_versions WHERE note_id = ?2), 0) > ?16
                 OR ?17 = 1)`,
      ).bind(
        snapshotId,
        id,
        userId,
        row.title,
        row.content,
        utf8ByteLength(row.content),
        now,
        ...mutationValues,
        body.preserveVersion ? 1 : 0,
        now,
        SNAPSHOT_INTERVAL_MS,
        bigChange ? 1 : 0,
      ),
      c.env.DB.prepare(
        `DELETE FROM note_versions WHERE note_id = ?1
           AND EXISTS (SELECT 1 FROM note_versions WHERE id = ?9)
           AND ${shiftSqlPlaceholders(mutationGuard, 1)}
           AND id IN (
             SELECT id FROM note_versions WHERE note_id = ?1 ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)`,
      ).bind(id, ...mutationValues, LIMITS.versionsPerNote, snapshotId),
    )
  }

  if (row.deleted_at === null && (contentChanged || newTitle !== row.title)) {
    const derived = buildNoteDerivedStatements({
      db: c.env.DB,
      userId,
      noteId: id,
      title: newTitle,
      content: newContent,
      ftsEnabled,
      titleChanged: newTitle !== row.title,
      previousTitle: row.title,
      expectedRev: nextRev,
      expectedContentHash: newHash,
      expectedTitle: newTitle,
      expectedUpdatedAt: now,
    })
    statements.push(...derived.statements)
    derivedTags = derived.tags
    if (contentChanged && !sameTagSet(splitTags(row.tag_names), derived.tags)) {
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM tags WHERE user_id = ?1 AND is_manual = 0
             AND ${shiftSqlPlaceholders(mutationGuard, 1)}
             AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`,
        ).bind(userId, ...mutationValues),
      )
    }
  }

  statements.push(
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}
       RETURNING seq`,
    ).bind(userId, id, now, ...mutationValues),
  )

  const results = await c.env.DB.batch(statements)
  const updateResult = results[0]
  if (!updateResult?.meta.changes) {
    const current = await loadNote(c.env.DB, userId, id)
    throw ApiError.conflict('This note was modified elsewhere', {
      server: current,
    })
  }
  const changeResult = results.at(-1) as D1Result<{ seq: number }> | undefined
  let rewroteInbound = false
  if (newTitle !== row.title) {
    const ambiguous = await c.env.DB.prepare(
      `SELECT 1 AS found FROM notes
        WHERE user_id = ?1 AND id <> ?2 AND deleted_at IS NULL AND title_key IN (?3, ?4)
        LIMIT 1`,
    )
      .bind(userId, id, normalizeLinkKey(row.title), normalizeLinkKey(newTitle))
      .first<{ found: number }>()
    if (!ambiguous) {
      const rewrite = await rewriteInboundWikiLinks(
        c.env.DB,
        userId,
        id,
        row.title,
        newTitle,
        ftsEnabled,
      )
      if (rewrite.skipped) {
        console.warn(
          `Could not update ${rewrite.skipped} wiki-link source notes after renaming note ${id}`,
        )
      }
      rewroteInbound = rewrite.rewritten > 0
    } else {
      await c.env.DB.prepare(
        `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
          WHERE user_id = ?1 AND target_key = ?2
            AND EXISTS (SELECT 1 FROM notes
              WHERE id = ?3 AND user_id = ?1 AND rev = ?4
                AND title = ?5 AND updated_at = ?6 AND deleted_at IS NULL)`,
      )
        .bind(userId, normalizeLinkKey(row.title), id, nextRev, newTitle, now)
        .run()
    }
  }
  await broadcastCursor(
    c,
    rewroteInbound ? undefined : changeResult?.results?.[0]?.seq,
  )
  if (contentChanged || newTitle !== row.title) {
    await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
    scheduleFtsDrain(c)
  }
  const nextTags = contentChanged
    ? (derivedTags ?? extractTags(newContent))
    : null
  return c.json(toNote(applyPatchRow(row, sets, binds, nextTags)))
})
}