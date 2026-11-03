import { LIMITS } from '@shared/constants'
import { countText, deriveExcerpt } from '@shared/markdown-utils'
import { utf8ByteLength } from '@shared/text-utils'
import type { Note } from '@shared/types'
import { NOTE_COLUMNS_FULL, toNote, type NoteRow } from '../db/rows'
import { buildNoteDerivedStatements } from '../db/writes'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import { newId } from '../lib/id'
import { broadcastUserCursor } from '../lib/notify'
import { assertContentSize } from '../lib/request'
import { enqueueNoteIndex } from './ai-search'
import { buildOutline } from './retrieval'
import {
  lineOffsets,
  push,
  resolveTitle,
  shiftSqlPlaceholders,
} from './write-tail'
import type { McpWriteContext, NoteEditOperation } from './writes'

export async function patchNote(
  context: McpWriteContext,
  row: NoteRow,
  patch: {
    title?: string
    content?: string
    folderId?: string | null
    isPinned?: boolean
    isStarred?: boolean
    isArchived?: boolean
  },
): Promise<Note> {
  const now = Math.max(Date.now(), row.updated_at + 1)
  const sets: string[] = []
  const binds: unknown[] = []
  let contentChanged = false
  let newTitle = row.title
  let newContent = row.content
  let newHash = row.content_hash

  if (patch.content !== undefined && patch.content !== row.content) {
    assertContentSize(patch.content)
    const hash = await sha256Hex(patch.content)
    if (hash !== row.content_hash) {
      contentChanged = true
      newHash = hash
      newContent = patch.content
      newTitle =
        patch.title === undefined ? row.title : resolveTitle(patch.title)
      const { words, chars } = countText(patch.content)
      push(sets, binds, 'content', patch.content)
      push(sets, binds, 'content_hash', hash)
      push(sets, binds, 'title', newTitle)
      push(sets, binds, 'excerpt', deriveExcerpt(patch.content))
      push(sets, binds, 'word_count', words)
      push(sets, binds, 'char_count', chars)
    }
  } else if (
    patch.title !== undefined &&
    resolveTitle(patch.title) !== row.title
  ) {
    newTitle = resolveTitle(patch.title)
    push(sets, binds, 'title', newTitle)
  }
  if (
    Object.prototype.hasOwnProperty.call(patch, 'folderId') &&
    patch.folderId !== row.folder_id
  ) {
    push(
      sets,
      binds,
      'folder_id',
      await resolveFolderId(context.env.DB, context.userId, patch.folderId),
    )
  }
  if (patch.isPinned !== undefined && Number(patch.isPinned) !== row.is_pinned)
    push(sets, binds, 'is_pinned', patch.isPinned ? 1 : 0)
  if (
    patch.isStarred !== undefined &&
    Number(patch.isStarred) !== row.is_starred
  )
    push(sets, binds, 'is_starred', patch.isStarred ? 1 : 0)
  if (
    patch.isArchived !== undefined &&
    Number(patch.isArchived) !== row.is_archived
  )
    push(sets, binds, 'is_archived', patch.isArchived ? 1 : 0)
  if (!sets.length) return toNote(row)

  push(sets, binds, 'updated_at', now)
  const nextRev = row.rev + 1
  push(sets, binds, 'rev', nextRev)
  binds.push(row.id, context.userId, row.rev)
  const update = context.env.DB.prepare(
    `UPDATE notes SET ${sets.join(', ')}\n` +
      `      WHERE id = ?${binds.length - 2} ` +
      `AND user_id = ?${binds.length - 1} AND rev = ?${binds.length}`,
  ).bind(...binds)
  const mutationGuard = `EXISTS (SELECT 1 FROM notes
    WHERE id = ?1 AND user_id = ?2 AND rev = ?3
      AND content_hash = ?4 AND title = ?5 AND updated_at = ?6)`
  const mutationValues = [
    row.id,
    context.userId,
    nextRev,
    newHash,
    newTitle,
    now,
  ] as const
  const statements: D1PreparedStatement[] = [update]

  if (contentChanged && row.content) {
    statements.push(
      context.env.DB.prepare(
        'INSERT INTO note_versions ' +
          '(id, note_id, user_id, title, content, size, created_at)\n' +
          '         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7\n' +
          '          ' +
          `WHERE ${shiftSqlPlaceholders(mutationGuard, 7)}`,
      ).bind(
        newId(),
        row.id,
        context.userId,
        row.title,
        row.content,
        utf8ByteLength(row.content),
        now,
        ...mutationValues,
      ),
      context.env.DB.prepare(
        'DELETE FROM note_versions WHERE note_id = ?1\n' +
          '           ' +
          `AND ${shiftSqlPlaceholders(mutationGuard, 1)}\n` +
          '           AND id IN (\n' +
          '             ' +
          'SELECT id FROM note_versions WHERE note_id = ?1 ' +
          'ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?8)',
      ).bind(row.id, ...mutationValues, LIMITS.versionsPerNote),
    )
  }

  if (contentChanged || newTitle !== row.title) {
    statements.push(
      ...buildNoteDerivedStatements({
        db: context.env.DB,
        userId: context.userId,
        noteId: row.id,
        title: newTitle,
        content: newContent,
        ftsEnabled: context.ftsEnabled,
        titleChanged: newTitle !== row.title,
        previousTitle: row.title,
        expectedRev: nextRev,
        expectedContentHash: newHash,
        expectedTitle: newTitle,
        expectedUpdatedAt: now,
      }).statements,
    )
    if (contentChanged) {
      statements.push(
        context.env.DB.prepare(
          `DELETE FROM tags WHERE user_id = ?1 AND is_manual = 0
             AND ${shiftSqlPlaceholders(mutationGuard, 1)}
             AND NOT EXISTS (SELECT 1 FROM note_tags WHERE tag_id = tags.id)`,
        ).bind(context.userId, ...mutationValues),
      )
    }
  }
  statements.push(
    context.env.DB.prepare(
      `INSERT INTO changes (user_id, entity, entity_id, op, at)
       SELECT ?1, 'note', ?2, 'upsert', ?3
        WHERE ${shiftSqlPlaceholders(mutationGuard, 3)}`,
    ).bind(context.userId, row.id, now, ...mutationValues),
  )
  const [updated] = await context.env.DB.batch(statements)
  if (!updated?.meta.changes) {
    throw ApiError.conflict('This note was modified elsewhere', {
      server: await loadNote(context.env.DB, context.userId, row.id),
    })
  }
  const note = await loadNote(context.env.DB, context.userId, row.id)
  if (contentChanged || newTitle !== row.title) {
    await enqueueNoteIndex(context.env.DB, context.userId, row.id, 'embed')
  }
  await afterMutation(context)
  return note
}

export function applyEdit(
  content: string,
  input: {
    operation: NoteEditOperation
    text: string
    oldText?: string
    section?: string
  },
): string {
  if (input.operation === 'replace_all') return input.text
  if (input.operation === 'append') {
    if (!content) return input.text
    return `${content.replace(/\s*$/, '')}\n\n${input.text}`
  }
  if (input.operation === 'prepend') {
    if (!content) return input.text
    return `${input.text}\n\n${content.replace(/^\s*/, '')}`
  }
  if (input.operation === 'replace') {
    const oldText = input.oldText ?? ''
    if (!oldText) throw ApiError.badRequest('old_text is required for replace')
    const first = content.indexOf(oldText)
    if (first < 0)
      throw ApiError.conflict(
        'old_text was not found; read the current note and retry',
      )
    if (content.indexOf(oldText, first + oldText.length) >= 0) {
      throw ApiError.conflict(
        'old_text occurs more than once; provide a larger unique passage',
      )
    }
    return (
      content.slice(0, first) +
      input.text +
      content.slice(first + oldText.length)
    )
  }

  const section = input.section?.trim().toLowerCase()
  if (!section)
    throw ApiError.badRequest('section is required for replace_section')
  const outline = buildOutline(content)
  const index = outline.findIndex(
    (item) => item.slug === section || item.title.toLowerCase() === section,
  )
  if (index < 0) throw ApiError.notFound(`Section not found: ${input.section}`)
  const heading = outline[index]!
  const offsets = lineOffsets(content)
  const headingEnd = offsets[heading.line] ?? content.length
  const next = outline
    .slice(index + 1)
    .find((item) => item.level <= heading.level)
  const sectionEnd = next
    ? (offsets[next.line - 1] ?? content.length)
    : content.length
  const replacement = input.text.trim()
  const middle = replacement ? `${replacement}\n\n` : ''
  return `${content.slice(0, headingEnd)}${middle}${content.slice(sectionEnd)}`
}

export async function afterMutation(context: McpWriteContext): Promise<void> {
  await broadcastUserCursor(
    context.env,
    context.userId,
    null,
    undefined,
    (task) => context.executionCtx.waitUntil(task),
  )
}

export async function loadNote(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Note> {
  return toNote(await loadNoteRow(db, userId, id))
}

export async function loadNoteOrNull(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Note | null> {
  const row = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n ` +
        `WHERE n.id = ?1 AND n.user_id = ?2`,
    )
    .bind(id, userId)
    .first<NoteRow>()
  return row ? toNote(row) : null
}

export async function loadNoteRow(
  db: D1Database,
  userId: string,
  id: string,
): Promise<NoteRow> {
  const row = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n ` +
        `WHERE n.id = ?1 AND n.user_id = ?2`,
    )
    .bind(id, userId)
    .first<NoteRow>()
  if (!row) throw ApiError.notFound('Note not found')
  return row
}

export function assertExpectedRevision(
  row: NoteRow,
  expectedRev: number,
): void {
  if (!Number.isInteger(expectedRev) || expectedRev < 1) {
    throw ApiError.badRequest('expected_rev must be a positive integer')
  }
  if (row.rev !== expectedRev) {
    throw ApiError.conflict('This note was modified elsewhere', {
      server: toNote(row),
    })
  }
}

export async function resolveFolderId(
  db: D1Database,
  userId: string,
  folderId: string | null | undefined,
): Promise<string | null> {
  if (!folderId) return null
  const row = await db
    .prepare(
      `SELECT id FROM folders ` +
        `WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    )
    .bind(folderId, userId)
    .first<{ id: string }>()
  if (!row) throw ApiError.badRequest('Folder not found')
  return row.id
}
