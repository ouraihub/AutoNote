import type { AppBindings } from '../../env'
import type { ExistingNoteIndex } from './types'
import type { ImportContext } from './types'
import type { InsertInput } from './types'
import { LIMITS } from '@shared/constants'
import { assertContentSize } from '../../lib/request'
import { buildNoteDerivedStatements } from '../../db/writes'
import { countText } from '@shared/markdown-utils'
import { deriveExcerpt } from '@shared/markdown-utils'
import { enqueueNoteIndex } from '../../mcp/ai-search'
import { finiteNumber } from './values'
import { newId } from '../../lib/id'
import { sha256Hex } from '../../lib/encoding'
import { shiftSqlPlaceholders } from './values'
import { truncateText } from '@shared/text-utils'
import { utf8ByteLength } from '@shared/text-utils'
import { validTimestamp } from './values'

export async function updateImportedNote(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  existing: ExistingNoteIndex,
  input: InsertInput,
  importedUpdatedAt: number,
  ctx: ImportContext,
): Promise<'updated' | 'skipped' | 'conflict' | 'missing'> {
  const current = await c.env.DB.prepare(
    'SELECT id, title, content, rev, position, is_pinned, ' +
      'is_starred, is_archived,\n            created_at, ' +
      'updated_at, deleted_at\n       FROM notes WHERE id = ?1 ' +
      'AND user_id = ?2',
  )
    .bind(existing.id, userId)
    .first<{
      id: string
      title: string
      content: string
      rev: number
      position: number
      is_pinned: number
      is_starred: number
      is_archived: number
      created_at: number
      updated_at: number
      deleted_at: number | null
    }>()
  if (!current) return 'missing'
  if (!importedUpdatedAt || current.updated_at >= importedUpdatedAt)
    return 'skipped'

  const title = truncateText(input.title.trim(), LIMITS.titleMaxLength)
  const { words, chars } = countText(input.content)
  const hash = await sha256Hex(input.content)
  const nextRev = current.rev + 1
  const updatedAt = validTimestamp(input.updatedAt) || importedUpdatedAt
  const createdAt = Math.min(
    validTimestamp(input.createdAt) || current.created_at,
    updatedAt,
  )
  const deletedAt = validTimestamp(input.deletedAt) || null
  const position = finiteNumber(input.position) ?? current.position
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [
    current.id,
    userId,
    nextRev,
    hash,
    title,
    updatedAt,
  ] as const
  const update = c.env.DB.prepare(
    'UPDATE notes SET title = ?1, content = ?2, excerpt = ' +
      '?3, word_count = ?4, char_count = ?5,\n       ' +
      'content_hash = ?6, folder_id = ?7, is_pinned = ?8, ' +
      'is_starred = ?9, is_archived = ?10,\n       position = ' +
      '?11, created_at = ?12, updated_at = ?13, rev = ?14, ' +
      'deleted_at = ?15\n      WHERE id = ?16 AND user_id = ?17 ' +
      'AND rev = ?18',
  ).bind(
    title,
    input.content,
    deriveExcerpt(input.content),
    words,
    chars,
    hash,
    input.folderId,
    input.isPinned === undefined ? current.is_pinned : input.isPinned ? 1 : 0,
    input.isStarred === undefined
      ? current.is_starred
      : input.isStarred
        ? 1
        : 0,
    input.isArchived === undefined
      ? current.is_archived
      : input.isArchived
        ? 1
        : 0,
    position,
    createdAt,
    updatedAt,
    nextRev,
    deletedAt,
    current.id,
    userId,
    current.rev,
  )

  const statements: D1PreparedStatement[] = [update]
  if (current.content !== input.content || current.title !== title) {
    const snapshotAt = Date.now()
    statements.push(
      c.env.DB.prepare(
        'INSERT INTO note_versions (id, note_id, user_id, title, ' +
          'content, size, created_at)\n         SELECT ?1, ?2, ?3, ' +
          '?4, ?5, ?6, ?7\n          WHERE ' +
          `${shiftSqlPlaceholders(mutationGuard, 7)}`,
      ).bind(
        newId(),
        current.id,
        userId,
        current.title,
        current.content,
        utf8ByteLength(current.content),
        snapshotAt,
        ...mutationValues,
      ),
      c.env.DB.prepare(
        'DELETE FROM note_versions WHERE note_id = ?1\n           ' +
          'AND ' +
          `${shiftSqlPlaceholders(mutationGuard, 1)}` +
          '\n           AND id IN (\n             SELECT id FROM ' +
          'note_versions WHERE note_id = ?1 ORDER BY created_at ' +
          'DESC, id DESC LIMIT -1 OFFSET ?8)',
      ).bind(current.id, ...mutationValues, LIMITS.versionsPerNote),
    )
  }
  const derived = buildNoteDerivedStatements({
    db: c.env.DB,
    userId,
    noteId: current.id,
    title,
    content: input.content,
    ftsEnabled: ctx.ftsEnabled,
    previousTitle: current.title,
    expectedRev: nextRev,
    expectedContentHash: hash,
    expectedTitle: title,
    expectedUpdatedAt: updatedAt,
    deleted: Boolean(deletedAt),
  }).statements
  statements.push(
    ...derived,
    c.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
    ).bind(userId, current.id, Date.now(), ...mutationValues),
  )

  const [result] = await c.env.DB.batch(statements)
  if (!result?.meta.changes) return 'conflict'
  existing.title = title
  existing.rev = nextRev
  existing.updated_at = updatedAt
  await enqueueNoteIndex(c.env.DB, userId, current.id, 'embed')
  return 'updated'
}

export async function insertNote(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  input: InsertInput,
  ctx: ImportContext,
): Promise<string> {
  assertContentSize(input.content)

  let id = input.id ?? newId()
  const now = Date.now()
  const created = validTimestamp(input.createdAt) || now
  const updated = Math.max(validTimestamp(input.updatedAt) || created, created)
  const deleted = validTimestamp(input.deletedAt) || null
  const position = finiteNumber(input.position) ?? created
  const { words, chars } = countText(input.content)
  const title = truncateText(input.title.trim(), LIMITS.titleMaxLength)

  const hash = await sha256Hex(input.content)
  let inserted = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const insert = c.env.DB.prepare(
      'INSERT INTO notes (id, user_id, folder_id, title, ' +
        'content, excerpt, rev, word_count, char_count,\n         ' +
        'is_pinned, is_starred, is_archived, position, ' +
        'content_hash, created_at, updated_at, deleted_at)\n      ' +
        ' VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9, ?10, ' +
        '?11, ?12, ?13, ?14, ?15, ?16)\n       ON CONFLICT(id) DO ' +
        'NOTHING',
    ).bind(
      id,
      userId,
      input.folderId,
      title,
      input.content,
      deriveExcerpt(input.content),
      words,
      chars,
      input.isPinned === true ? 1 : 0,
      input.isStarred === true ? 1 : 0,
      input.isArchived === true ? 1 : 0,
      position,
      hash,
      created,
      updated,
      deleted,
    )
    const derived = buildNoteDerivedStatements({
      db: c.env.DB,
      userId,
      noteId: id,
      title,
      content: input.content,
      ftsEnabled: ctx.ftsEnabled,
      expectedRev: 1,
      expectedContentHash: hash,
      expectedTitle: title,
      expectedUpdatedAt: updated,
      deleted: Boolean(deleted),
    }).statements
    const change = c.env.DB.prepare(
      'INSERT INTO changes (user_id, entity, entity_id, op, ' +
        "at)\n       SELECT ?1, 'note', ?2, 'upsert', ?3\n        " +
        'WHERE EXISTS (SELECT 1 FROM notes\n          WHERE id = ' +
        '?2 AND user_id = ?1 AND rev = 1 AND content_hash = ?4 ' +
        'AND updated_at = ?5)',
    ).bind(userId, id, Date.now(), hash, updated)
    const mapping = input.id
      ? c.env.DB.prepare(
          'INSERT INTO import_mappings (user_id, entity, ' +
            'source_id, target_id, updated_at)\n           SELECT ?1, ' +
            "'note', ?2, ?3, ?4\n            WHERE EXISTS (SELECT 1 " +
            'FROM notes\n              WHERE id = ?3 AND user_id = ?1 ' +
            'AND rev = 1\n                AND content_hash = ?5 AND ' +
            'updated_at = ?6)\n           ON CONFLICT(user_id, ' +
            'entity, source_id) DO UPDATE SET\n             target_id ' +
            '= excluded.target_id,\n             updated_at = ' +
            'excluded.updated_at',
        ).bind(userId, input.id, id, Date.now(), hash, updated)
      : null
    const [result] = await c.env.DB.batch([
      insert,
      ...derived,
      change,
      ...(mapping ? [mapping] : []),
    ])
    if (result?.meta.changes) {
      inserted = true
      break
    }
    id = newId()
  }
  if (!inserted) throw new Error('Could not generate a unique note ID')

  if (!deleted) await enqueueNoteIndex(c.env.DB, userId, id, 'embed')
  return id
}
