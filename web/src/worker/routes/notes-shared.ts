import type { Note } from '@shared/types'
import { deriveExcerpt, replaceWikiLinkTarget } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'
import { LIMITS } from '@shared/constants'
import { NOTE_COLUMNS_FULL, type NoteRow, toNote } from '../db/rows'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'

export async function loadNote(db: D1Database, userId: string, id: string): Promise<Note> {
  return toNote(await loadNoteRow(db, userId, id))
}

export async function loadNoteRow(db: D1Database, userId: string, id: string): Promise<NoteRow> {
  const row = await db.prepare(`SELECT ${NOTE_COLUMNS_FULL} FROM notes n WHERE n.id = ?1 AND n.user_id = ?2`).bind(id, userId).first<NoteRow>()
  if (!row) throw ApiError.notFound('Note not found')
  return row
}

export function resolveNoteTitle(title: string | undefined, current = ''): string {
  return title === undefined ? current : truncateText(title.trim(), LIMITS.titleMaxLength)
}

export function restoredVersionTitle(title: string): string { return resolveNoteTitle(title) }

export function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(/\?(\d+)/g, (_match, value: string) => `?${Number(value) + offset}`)
}

export function sameTagSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false
  const set = new Set(left)
  return right.every((name) => set.has(name))
}

export function push(sets: string[], binds: unknown[], column: string, value: unknown): void {
  binds.push(value)
  sets.push(`${column} = ?${binds.length}`)
}

export function applyPatchRow(row: NoteRow, sets: string[], binds: unknown[], tagNames: string[] | null): NoteRow {
  const next: NoteRow = { ...row }
  for (let index = 0; index < sets.length; index++) {
    const column = sets[index]!.split(' ')[0]!
    const value = binds[index]
    if (column in next) (next as unknown as Record<string, unknown>)[column] = value
  }
  if (tagNames !== null) next.tag_names = tagNames.join('\u0001')
  return next
}

export async function resolveFolderId(db: D1Database, userId: string, folderId: string | null | undefined): Promise<string | null> {
  if (!folderId) return null
  const row = await db.prepare(`SELECT id FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`).bind(folderId, userId).first<{ id: string }>()
  if (!row) throw ApiError.badRequest('Folder not found')
  return row.id
}
export async function rewriteInboundWikiLinks(db: D1Database, userId: string, targetNoteId: string, fromTitle: string, toTitle: string, _ftsEnabled: boolean): Promise<{ rewritten: number; skipped: number }> {
  const { results } = await db.prepare(`SELECT DISTINCT n.id, n.content FROM links l JOIN notes n ON n.id = l.source_note_id WHERE l.user_id = ?1 AND l.target_note_id = ?2 AND n.deleted_at IS NULL`).bind(userId, targetNoteId).all<{ id: string; content: string }>()
  let rewritten = 0
  for (const row of results) {
    const content = replaceWikiLinkTarget(row.content, fromTitle, toTitle)
    if (content === row.content) continue
    const result = await db.prepare(`UPDATE notes SET content = ?1, excerpt = ?2, content_hash = ?3, rev = rev + 1, updated_at = ?4 WHERE id = ?5 AND user_id = ?6 AND content = ?7`).bind(content, deriveExcerpt(content), await sha256Hex(content), Date.now(), row.id, userId, row.content).run()
    if (result.meta.changes) rewritten++
  }
  return { rewritten, skipped: results.length - rewritten }
}

export const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000
export const SNAPSHOT_DIFF_THRESHOLD = 400
