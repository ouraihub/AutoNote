import type { FolderImportMetadata } from './types'
import type { ImportContext } from './types'
import { LIMITS } from '@shared/constants'
import { addWarning } from './values'
import { finiteNumber } from './values'
import { newId } from '../../lib/id'
import { normalizeFolderSegment } from './values'
import { validTimestamp } from './values'

export async function primeFolderCache(
  db: D1Database,
  userId: string,
  cache: Map<string, string>,
): Promise<void> {
  const { results } = await db
    .prepare(
      'SELECT id, parent_id, name FROM folders ' +
        'WHERE user_id = ?1 AND deleted_at IS NULL',
    )
    .bind(userId)
    .all<{ id: string; parent_id: string | null; name: string }>()

  const byId = new Map(results.map((r) => [r.id, r]))
  const pathOf = (id: string, guard = 0): string => {
    const folder = byId.get(id)
    if (!folder || guard > 16) return ''
    const parent = folder.parent_id ? pathOf(folder.parent_id, guard + 1) : ''
    return parent ? `${parent}/${folder.name}` : folder.name
  }
  for (const row of results) {
    const path = pathOf(row.id)
    if (path) cache.set(path.toLowerCase(), row.id)
  }
}

export async function ensureFolderPath(
  db: D1Database,
  userId: string,
  path: string,
  ctx: ImportContext,
  finalMetadata?: FolderImportMetadata,
): Promise<string | null> {
  const rawSegments = path
    .split('/')
    .map((segment) => normalizeFolderSegment(segment))
    .filter(Boolean)
  if (rawSegments.length > LIMITS.folderDepthMax) {
    addWarning(
      ctx.result,
      `Folder path exceeds ${LIMITS.folderDepthMax} levels ` +
        `and was truncated: ${path}`,
    )
  }
  const segments = rawSegments.slice(0, LIMITS.folderDepthMax)
  if (!segments.length) return null

  let parentId: string | null = null
  let accumulated = ''

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex]!
    accumulated = accumulated ? `${accumulated}/${segment}` : segment
    const key = accumulated.toLowerCase()
    const cached = ctx.folderCache.get(key)
    if (cached) {
      parentId = cached
      continue
    }

    const id = newId()
    const now = Date.now()
    const isFinal = segmentIndex === segments.length - 1
    const createdAt = isFinal
      ? validTimestamp(finalMetadata?.createdAt) || now
      : now
    const updatedAt = isFinal
      ? Math.max(
          createdAt,
          validTimestamp(finalMetadata?.updatedAt) || createdAt,
        )
      : now
    const position = isFinal
      ? (finiteNumber(finalMetadata?.position) ?? now)
      : now
    const icon = isFinal ? (finalMetadata?.icon ?? null) : null
    const color = isFinal ? (finalMetadata?.color ?? null) : null
    const insert = db
      .prepare(
        'INSERT OR IGNORE INTO folders\n         (id, user_id, ' +
          'parent_id, name, icon, color, position, created_at, ' +
          'updated_at)\n       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ' +
          '?8, ?9)',
      )
      .bind(
        id,
        userId,
        parentId,
        segment,
        icon,
        color,
        position,
        createdAt,
        updatedAt,
      )
    const [created] = await db.batch([
      insert,
      db
        .prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?1, 'folder', ?2, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2 AND user_id = ?1)`,
        )
        .bind(userId, id, updatedAt),
    ])

    let resolvedId = id
    if (created?.meta.changes) {
      ctx.result.createdFolders++
    } else {
      const existing = await db
        .prepare(
          `SELECT id FROM folders
          WHERE user_id = ?1 AND parent_id IS ?2 AND lower(name) = lower(?3)
            AND deleted_at IS NULL LIMIT 1`,
        )
        .bind(userId, parentId, segment)
        .first<{ id: string }>()
      if (!existing) throw new Error(`Could not create folder: ${segment}`)
      resolvedId = existing.id
    }

    ctx.folderCache.set(key, resolvedId)
    parentId = resolvedId
  }
  return parentId
}
