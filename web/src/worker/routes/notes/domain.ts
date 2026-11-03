import { LIMITS } from '@shared/constants'
import {
  countText,
  deriveExcerpt,
  normalizeLinkKey,
  replaceWikiLinkTarget,
} from '@shared/markdown-utils'
import { sliceText, truncateText, utf8ByteLength } from '@shared/text-utils'
import type { Note } from '@shared/types'
import { NOTE_COLUMNS_FULL, toNote, type NoteRow } from '../../db/rows'
import { buildNoteDerivedStatements } from '../../db/writes'
import { sha256Hex } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { newId } from '../../lib/id'
import { noteIndexQueueStatement } from '../../mcp/ai-search'
import { shiftSqlPlaceholders } from './helpers'

export async function loadNote(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Note> {
  return toNote(await loadNoteRow(db, userId, id))
}

export async function loadNoteRow(
  db: D1Database,
  userId: string,
  id: string,
): Promise<NoteRow> {
  const row = await db
    .prepare(
      'SELECT ' +
        `${NOTE_COLUMNS_FULL}` +
        ' FROM notes n WHERE n.id = ?1 AND n.user_id = ?2',
    )
    .bind(id, userId)
    .first<NoteRow>()
  if (!row) throw ApiError.notFound('Note not found')
  return row
}

export function linkContext(content: string, title: string): string {
  const needle = `[[${title}`
  const idx = content.toLowerCase().indexOf(needle.toLowerCase())
  if (idx < 0) return truncateText(content, 120).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, idx - 60)
  const end = Math.min(content.length, idx + needle.length + 90)
  return (
    (start > 0 ? '…' : '') +
    sliceText(content, start, end).replace(/\s+/g, ' ').trim() +
    (end < content.length ? '…' : '')
  )
}

export async function rewriteInboundWikiLinks(
  db: D1Database,
  userId: string,
  targetNoteId: string,
  fromTitle: string,
  toTitle: string,
  ftsEnabled: boolean,
): Promise<{ rewritten: number; skipped: number }> {
  const previousKey = normalizeLinkKey(fromTitle)
  const { results: candidates } = await db
    .prepare(
      `SELECT DISTINCT n.id FROM links l
      JOIN notes n ON n.id = l.source_note_id AND n.user_id = l.user_id
     WHERE l.user_id = ?1 AND l.target_note_id = ?2 AND l.target_key = ?3
       AND n.id <> ?2 AND n.deleted_at IS NULL`,
    )
    .bind(userId, targetNoteId, previousKey)
    .all<{ id: string }>()
  let rewritten = 0
  let skipped = 0
  for (const candidate of candidates) {
    let complete = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const note = await db
        .prepare(
          `SELECT id, title, content, content_hash, rev, updated_at, deleted_at
           FROM notes WHERE id = ?1 AND user_id = ?2`,
        )
        .bind(candidate.id, userId)
        .first<{
          id: string
          title: string
          content: string
          content_hash: string
          rev: number
          updated_at: number
          deleted_at: number | null
        }>()
      if (!note || note.deleted_at !== null) {
        complete = true
        break
      }
      const content = replaceWikiLinkTarget(note.content, fromTitle, toTitle)
      if (content === note.content) {
        complete = true
        break
      }
      const hash = await sha256Hex(content)
      const { words, chars } = countText(content)
      const now = Math.max(Date.now(), note.updated_at + 1)
      const nextRev = note.rev + 1
      const guard =
        'EXISTS (SELECT 1 FROM notes\n    WHERE id = ?1 AND ' +
        'user_id = ?2 AND rev = ?3\n      AND content_hash = ?4 ' +
        'AND title = ?5 AND updated_at = ?6)'
      const guardValues = [
        note.id,
        userId,
        nextRev,
        hash,
        note.title,
        now,
      ] as const
      const statements: D1PreparedStatement[] = [
        db
          .prepare(
            'UPDATE notes SET content = ?1, excerpt = ?2, word_count ' +
              '= ?3, char_count = ?4,\n             content_hash = ?5, ' +
              'rev = ?6, updated_at = ?7\n            WHERE id = ?8 AND ' +
              'user_id = ?9 AND rev = ?10 AND content_hash = ?11',
          )
          .bind(
            content,
            deriveExcerpt(content),
            words,
            chars,
            hash,
            nextRev,
            now,
            note.id,
            userId,
            note.rev,
            note.content_hash,
          ),
        db
          .prepare(
            'INSERT INTO note_versions (id, note_id, user_id, title, ' +
              'content, size, created_at)\n           SELECT ?1, ?2, ' +
              '?3, ?4, ?5, ?6, ?7 WHERE ' +
              `${shiftSqlPlaceholders(guard, 7)}`,
          )
          .bind(
            newId(),
            note.id,
            userId,
            note.title,
            note.content,
            utf8ByteLength(note.content),
            now,
            ...guardValues,
          ),
        db
          .prepare(
            'DELETE FROM note_versions WHERE note_id = ?1\n           ' +
              '  AND ' +
              `${shiftSqlPlaceholders(guard, 1)}` +
              '\n             AND id IN (SELECT id FROM note_versions ' +
              'WHERE note_id = ?1 ORDER BY created_at DESC, id DESC ' +
              'LIMIT -1 OFFSET ?8)',
          )
          .bind(note.id, ...guardValues, LIMITS.versionsPerNote),
      ]
      statements.push(
        ...buildNoteDerivedStatements({
          db,
          userId,
          noteId: note.id,
          title: note.title,
          content,
          ftsEnabled,
          expectedRev: nextRev,
          expectedContentHash: hash,
          expectedTitle: note.title,
          expectedUpdatedAt: now,
        }).statements,
      )
      statements.push(
        noteIndexQueueStatement(db, userId, note.id, 'embed', now),
      )
      statements.push(
        db
          .prepare(
            'INSERT INTO changes (user_id, entity, entity_id, op, ' +
              "at)\n           SELECT ?1, 'note', ?2, 'upsert', ?3 " +
              'WHERE ' +
              `${shiftSqlPlaceholders(guard, 3)}`,
          )
          .bind(userId, note.id, now, ...guardValues),
      )
      const [updated] = await db.batch(statements)
      if (updated?.meta.changes) {
        rewritten++
        complete = true
        break
      }
    }
    if (!complete) skipped++
  }
  return { rewritten, skipped }
}

export function sameTagSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((name) => set.has(name))
}

export function applyPatchRow(
  row: NoteRow,
  sets: string[],
  binds: unknown[],
  tagNames: string[] | null,
): NoteRow {
  const next: NoteRow = { ...row }
  for (let index = 0; index < sets.length; index++) {
    const column = sets[index]!.split(' ')[0]!
    const value = binds[index]
    if (column === 'content') next.content = value as string
    else if (column === 'content_hash') next.content_hash = value as string
    else if (column === 'title') next.title = value as string
    else if (column === 'excerpt') next.excerpt = value as string
    else if (column === 'word_count') next.word_count = value as number
    else if (column === 'char_count') next.char_count = value as number
    else if (column === 'folder_id') next.folder_id = value as string | null
    else if (column === 'is_pinned') next.is_pinned = value as number
    else if (column === 'is_starred') next.is_starred = value as number
    else if (column === 'is_archived') next.is_archived = value as number
    else if (column === 'updated_at') next.updated_at = value as number
    else if (column === 'rev') next.rev = value as number
  }
  if (tagNames !== null) next.tag_names = tagNames.join('\u0001')
  return next
}

export async function resolveFolderId(
  db: D1Database,
  userId: string,
  folderId: string | null | undefined,
): Promise<string | null> {
  if (!folderId) return null
  const row = await db
    .prepare(
      'SELECT id FROM folders WHERE id = ?1 AND user_id = ?2 ' +
        'AND deleted_at IS NULL',
    )
    .bind(folderId, userId)
    .first<{ id: string }>()
  if (!row) throw ApiError.badRequest('Folder not found')
  return row.id
}
