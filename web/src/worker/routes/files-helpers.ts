import { extractAttachmentIds } from '@shared/markdown-utils'
import type { Attachment } from '@shared/types'
import { ApiError } from '../lib/errors'
import { type AttachmentObjectStorage, attachmentCleanupTarget, attachmentObjectKey } from '../attachments/keys'

export interface AttachmentRow {
  id: string
  user_id: string
  note_id: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  storage: AttachmentObjectStorage
  created_at: number
}
export const ATTACHMENT_LIST_PAGE_SIZE = 500
export const ATTACHMENT_SCAN_PAGE_SIZE = 100
export function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}
export function parseAttachmentListCursor(value: string | undefined): { createdAt: number; id: string } | null {
  if (!value) return null
  const match = /^(\d{1,16})\.([0-9a-hjkmnp-tv-z]{26})$/.exec(value)
  const createdAt = Number(match?.[1])
  if (!match || !Number.isSafeInteger(createdAt) || createdAt < 0) throw ApiError.badRequest('Invalid attachment cursor')
  return { createdAt, id: match[2]! }
}
export function toAttachment(row: AttachmentRow): Attachment {
  return { id: row.id, noteId: row.note_id, filename: row.filename, mime: row.mime, size: row.size, width: row.width, height: row.height, url: `/api/files/${row.id}`, createdAt: row.created_at }
}
export async function collectAttachmentReferences(db: D1Database, userId: string, wantedIds?: ReadonlySet<string>): Promise<Map<string, number>> {
  const references = new Map<string, number>()
  if (wantedIds?.size === 0) return references
  let afterId = ''
  while (true) {
    const { results } = await db.prepare(`SELECT id, content FROM notes WHERE user_id = ?1 AND id > ?2 ORDER BY id ASC LIMIT ?3`).bind(userId, afterId, ATTACHMENT_SCAN_PAGE_SIZE).all<{ id: string; content: string }>()
    if (!results.length) break
    for (const note of results) for (const id of extractAttachmentIds(note.content)) {
      if (wantedIds && !wantedIds.has(id)) continue
      references.set(id, (references.get(id) ?? 0) + 1)
    }
    afterId = results[results.length - 1]!.id
    if (results.length < ATTACHMENT_SCAN_PAGE_SIZE) break
  }
  return references
}
export async function collectAttachmentIdsThroughBoundary(db: D1Database, userId: string, boundary: { created_at: number; id: string }): Promise<Set<string>> {
  const ids = new Set<string>()
  let cursor: { createdAt: number; id: string } | null = null
  while (true) {
    const query: D1PreparedStatement = cursor ? db.prepare(`SELECT created_at, id FROM attachments WHERE user_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3)) AND (created_at > ?4 OR (created_at = ?4 AND id > ?5)) ORDER BY created_at ASC, id ASC LIMIT ?6`).bind(userId, boundary.created_at, boundary.id, cursor.createdAt, cursor.id, ATTACHMENT_SCAN_PAGE_SIZE) : db.prepare(`SELECT created_at, id FROM attachments WHERE user_id = ?1 AND (created_at < ?2 OR (created_at = ?2 AND id <= ?3)) ORDER BY created_at ASC, id ASC LIMIT ?4`).bind(userId, boundary.created_at, boundary.id, ATTACHMENT_SCAN_PAGE_SIZE)
    const rows = (await query.all<{ created_at: number; id: string }>()).results
    if (!rows.length) break
    for (const row of rows) ids.add(row.id)
    const last = rows[rows.length - 1]!
    cursor = { createdAt: last.created_at, id: last.id }
    if (rows.length < ATTACHMENT_SCAN_PAGE_SIZE) break
  }
  return ids
}
export { attachmentCleanupTarget, attachmentObjectKey }
