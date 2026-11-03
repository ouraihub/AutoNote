import { LIMITS } from '@shared/constants'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { broadcastUserCursor } from '../lib/notify'
import type { FolderRow, LibraryContext, ShareRow } from './library'

export function duplicateTitle(title: string): string {
  const suffix = ' copy'
  const base = title.trim() || 'Untitled note'
  return (
    base.slice(0, Math.max(0, LIMITS.titleMaxLength - suffix.length)) + suffix
  )
}

export async function requireOwnedNote(
  db: D1Database,
  userId: string,
  noteId: string,
): Promise<void> {
  const row = await db
    .prepare(`SELECT 1 FROM notes WHERE id = ?1 AND user_id = ?2`)
    .bind(noteId, userId)
    .first()
  if (!row) throw ApiError.notFound('Note not found')
}

export async function loadFolderOrNull(
  db: D1Database,
  userId: string,
  id: string,
): Promise<FolderRow | null> {
  return db
    .prepare(
      `SELECT id, parent_id, name, icon, color, position, created_at, updated_at
       FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
    )
    .bind(id, userId)
    .first<FolderRow>()
}

export async function loadTagOrNull(
  db: D1Database,
  userId: string,
  id: string,
) {
  const row = await db
    .prepare(
      'SELECT t.id, t.name, t.color, t.is_manual,\n' +
        '       (SELECT COUNT(*) FROM note_tags nt ' +
        'JOIN notes n ON n.id = nt.note_id\n' +
        '         ' +
        'WHERE nt.tag_id = t.id AND n.user_id = t.user_id ' +
        'AND n.deleted_at IS NULL) AS note_count\n' +
        '       FROM tags t WHERE t.id = ?1 AND t.user_id = ?2',
    )
    .bind(id, userId)
    .first<{
      id: string
      name: string
      color: string | null
      is_manual: number
      note_count: number
    }>()
  return row
    ? {
        id: row.id,
        name: row.name,
        color: row.color,
        manual: row.is_manual === 1,
        note_count: row.note_count,
      }
    : null
}

export async function loadAttachmentMeta(
  db: D1Database,
  userId: string,
  id: string,
) {
  return db
    .prepare(
      'SELECT id, note_id, filename, mime, size, sha256, ' +
        'width, height, created_at\n' +
        '       FROM attachments WHERE id = ?1 AND user_id = ?2',
    )
    .bind(id, userId)
    .first<{
      id: string
      note_id: string | null
      filename: string
      mime: string
      size: number
      sha256: string
      width: number | null
      height: number | null
      created_at: number
    }>()
}

export function loadShare(db: D1Database, userId: string, noteId: string) {
  return db
    .prepare(
      `SELECT slug, note_id, password_hash, expires_at, views, created_at
       FROM shares WHERE note_id = ?1 AND user_id = ?2`,
    )
    .bind(noteId, userId)
    .first<ShareRow>()
}

export function shareResult(row: ShareRow, origin: string) {
  return {
    slug: row.slug,
    note_id: row.note_id,
    url: `${origin.replace(/\/$/, '')}/s/${row.slug}`,
    has_password: Boolean(row.password_hash),
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    views: row.views,
    created_at: new Date(row.created_at).toISOString(),
  }
}

export async function loadTagByName(
  db: D1Database,
  userId: string,
  name: string,
  exceptId?: string,
) {
  const row = await db
    .prepare(
      `SELECT id FROM tags WHERE user_id = ?1 AND name = ?2 COLLATE NOCASE
      AND (?3 IS NULL OR id != ?3) ORDER BY created_at ASC, id ASC LIMIT 1`,
    )
    .bind(userId, name, exceptId ?? null)
    .first<{ id: string }>()
  return row ? loadTagOrNull(db, userId, row.id) : null
}

export async function validateFolderParent(
  db: D1Database,
  userId: string,
  parentId: string | null,
  selfId?: string,
): Promise<void> {
  if (!parentId) return
  if (!isValidId(parentId))
    throw ApiError.badRequest('Invalid parent folder id')
  const { results } = await db
    .prepare(
      'WITH RECURSIVE ancestors(id, parent_id, depth) AS (\n' +
        '       SELECT id, parent_id, 1 FROM folders\n' +
        '        ' +
        'WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL\n' +
        '       UNION ALL\n' +
        '       SELECT f.id, f.parent_id, ancestors.depth + 1 ' +
        'FROM folders f JOIN ancestors ON f.id = ancestors.parent_id\n' +
        '        WHERE f.user_id = ?2 AND f.deleted_at IS NULL ' +
        'AND ancestors.depth < ?3\n' +
        '     ) SELECT id, depth FROM ancestors',
    )
    .bind(parentId, userId, LIMITS.folderDepthMax + 1)
    .all<{ id: string; depth: number }>()
  if (!results.length)
    throw ApiError.badRequest('The parent folder does not exist')
  if (selfId && results.some((row) => row.id === selfId)) {
    throw ApiError.badRequest(
      'A folder cannot be moved into its own descendant',
    )
  }
  if (Math.max(...results.map((row) => row.depth)) >= LIMITS.folderDepthMax) {
    throw ApiError.badRequest(
      `Folder nesting cannot exceed ${LIMITS.folderDepthMax} levels`,
    )
  }
}

export async function validateFolderMoveDepth(
  db: D1Database,
  userId: string,
  folderId: string,
  parentId: string | null,
): Promise<void> {
  const row = await db
    .prepare(
      'WITH RECURSIVE\n' +
        '       descendants(id, depth) AS (\n' +
        '         SELECT id, 1 FROM folders ' +
        'WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL\n' +
        '         UNION ALL\n' +
        '         ' +
        'SELECT f.id, descendants.depth + 1 FROM folders f ' +
        'JOIN descendants ON f.parent_id = descendants.id\n' +
        '          ' +
        'WHERE f.user_id = ?2 AND f.deleted_at IS NULL ' +
        'AND descendants.depth < ?4\n' +
        '       ),\n' +
        '       ancestors(id, parent_id, depth) AS (\n' +
        '         SELECT id, parent_id, 1 FROM folders ' +
        'WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL\n' +
        '         UNION ALL\n' +
        '         SELECT f.id, f.parent_id, ancestors.depth + 1 ' +
        'FROM folders f JOIN ancestors ON f.id = ancestors.parent_id\n' +
        '          ' +
        'WHERE f.user_id = ?2 AND f.deleted_at IS NULL ' +
        'AND ancestors.depth < ?4\n' +
        '       )\n' +
        '     ' +
        'SELECT COALESCE((SELECT MAX(depth) FROM descendants), 1) ' +
        'AS subtree_depth,\n' +
        '            ' +
        'COALESCE((SELECT MAX(depth) FROM ancestors), 0) ' +
        'AS parent_depth',
    )
    .bind(folderId, userId, parentId, LIMITS.folderDepthMax + 1)
    .first<{
      subtree_depth: number
      parent_depth: number
    }>()
  if (!row || row.subtree_depth + row.parent_depth > LIMITS.folderDepthMax) {
    throw ApiError.badRequest(
      `Folder nesting cannot exceed ${LIMITS.folderDepthMax} levels`,
    )
  }
}

export function normalizeFolderName(value: string): string {
  const name = value.trim()
  if (!name) throw ApiError.badRequest('Folder name is required')
  if (name.length > LIMITS.folderNameMaxLength)
    throw ApiError.badRequest('Folder name is too long')
  return name
}

export function normalizeTagName(value: string): string {
  const name = value.trim().replace(/^#+/, '')
  if (!name) throw ApiError.badRequest('Tag name is required')
  if (name.length > LIMITS.tagNameMaxLength)
    throw ApiError.badRequest('Tag name is too long')
  if (/[\s#]/.test(name))
    throw ApiError.badRequest('Tag names cannot contain spaces or #')
  return name
}

export async function recordChange(
  context: LibraryContext,
  entity: string,
  id: string,
  op: 'upsert' | 'delete',
  at: number,
): Promise<void> {
  await context.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at) ` +
      `VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(context.userId, entity, id, op, at)
    .run()
  await notifyMutation(context)
}

export async function notifyMutation(context: LibraryContext): Promise<void> {
  await broadcastUserCursor(
    context.env,
    context.userId,
    null,
    undefined,
    (task) => context.executionCtx.waitUntil(task),
  )
}

export function parseArray(raw: string): unknown[] {
  try {
    const value = JSON.parse(raw) as unknown
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

export function assertPropertyValue(value: unknown, depth: number): void {
  if (depth > 4)
    throw ApiError.badRequest(
      'Property values cannot exceed four nested levels',
    )
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return
  if (typeof value === 'number' && Number.isFinite(value)) return
  if (Array.isArray(value)) {
    if (value.length > 100)
      throw ApiError.badRequest('Property arrays cannot exceed 100 items')
    for (const item of value) assertPropertyValue(item, depth + 1)
    return
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length > 100)
      throw ApiError.badRequest('Property objects cannot exceed 100 fields')
    for (const [key, item] of entries) {
      if (!key || key.length > 120)
        throw ApiError.badRequest('Nested property names are invalid')
      assertPropertyValue(item, depth + 1)
    }
    return
  }
  throw ApiError.badRequest('Property values must be JSON-compatible')
}

export function propertyMatches(
  properties: Record<string, unknown>,
  condition: {
    key: string
    operator: 'exists' | 'equals' | 'contains'
    value?: unknown
  },
): boolean {
  const exists = Object.prototype.hasOwnProperty.call(properties, condition.key)
  if (condition.operator === 'exists') return exists
  if (!exists) return false
  const actual = properties[condition.key]
  if (condition.operator === 'equals')
    return JSON.stringify(actual) === JSON.stringify(condition.value)
  if (Array.isArray(actual)) {
    return actual.some(
      (item) => JSON.stringify(item) === JSON.stringify(condition.value),
    )
  }
  return String(actual)
    .toLocaleLowerCase()
    .includes(String(condition.value ?? '').toLocaleLowerCase())
}
