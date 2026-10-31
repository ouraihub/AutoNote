import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { organizerColorOrNull } from '@shared/organizer-colors'
import { truncateText } from '@shared/text-utils'
import type { FolderRow } from '../db/rows'
import { toFolder } from '../db/rows'
import type { AppBindings } from '../env'
import { FTS_QUEUE_CONFLICT_SQL } from '../db/writes'
import { ApiError } from '../lib/errors'
import { isValidId, newId } from '../lib/id'
import { broadcastCursor } from '../lib/notify'
import { JSON_BODY_LIMITS, readJson } from '../lib/request'
import { requireAuth } from '../middleware/auth'
import { aiDeleteNeededSql } from '../mcp/ai-search'
import {
  FOLDER_SELECT,
  availableFolderName,
  folderDepth,
  folderPromotionOrder,
  loadFolder,
  loadFolderGraph,
  parseFolderDeleteStrategy,
  resolveFolderPosition,
  subtreeCteWithRevision,
  subtreeHeight,
  validateParent,
} from './folders-helpers'
export { folderPromotionOrder } from './folders-helpers'


export const foldersRoutes = new Hono<AppBindings>()

foldersRoutes.use('*', requireAuth)


foldersRoutes.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${FOLDER_SELECT} FROM folders f
      WHERE f.user_id = ?1 AND f.deleted_at IS NULL
      ORDER BY f.position ASC, f.created_at ASC, f.id ASC`,
  )
    .bind(c.get('userId'))
    .all<FolderRow>()
  return c.json({ folders: results.map(toFolder) })
})

foldersRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const body = await readJson<{
    id?: string
    name?: string
    parentId?: string | null
    icon?: string | null
    color?: string | null
  }>(c, JSON_BODY_LIMITS.small)

  if (body.name !== undefined && typeof body.name !== 'string') {
    throw ApiError.badRequest('name must be a string')
  }
  if (
    body.parentId !== undefined &&
    body.parentId !== null &&
    typeof body.parentId !== 'string'
  ) {
    throw ApiError.badRequest('parentId must be a string or null')
  }
  if (
    body.icon !== undefined &&
    body.icon !== null &&
    typeof body.icon !== 'string'
  ) {
    throw ApiError.badRequest('icon must be a string or null')
  }
  if (
    body.color !== undefined &&
    body.color !== null &&
    !organizerColorOrNull(body.color)
  ) {
    throw ApiError.badRequest('Folder color is not supported')
  }
  if (body.id !== undefined && !isValidId(body.id)) {
    throw ApiError.badRequest('id must be a valid folder id')
  }
  const id = body.id ?? newId()
  if (body.id) {
    const existing = await c.env.DB.prepare(
      `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.id = ?1 AND f.user_id = ?2 AND f.deleted_at IS NULL`,
    )
      .bind(id, userId)
      .first<FolderRow>()
    if (existing) return c.json(toFolder(existing))
    const collision = await c.env.DB.prepare(
      `SELECT user_id FROM folders WHERE id = ?1`,
    )
      .bind(id)
      .first<{ user_id: string }>()
    if (collision) throw ApiError.conflict('This folder id is already in use')
  }
  const graph = await loadFolderGraph(c.env.DB, userId)
  const parentId = validateParent(graph, body.parentId ?? null)
  const requestedName = (body.name ?? '').trim()
  const name =
    requestedName || availableFolderName(graph, parentId, 'New folder')
  if (name.length > LIMITS.folderNameMaxLength)
    throw ApiError.badRequest('Folder name is too long')
  if (parentId && folderDepth(graph, parentId) >= LIMITS.folderDepthMax) {
    throw ApiError.badRequest(
      `Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`,
    )
  }

  const now = Date.now()
  const insert = c.env.DB.prepare(
    `WITH RECURSIVE ancestors(id, parent_id, depth) AS (
       SELECT id, parent_id, 1 FROM folders
        WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
       UNION ALL
       SELECT f.id, f.parent_id, a.depth + 1
         FROM folders f JOIN ancestors a ON f.id = a.parent_id
        WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND a.depth < ?9
     )
     INSERT OR IGNORE INTO folders (id, user_id, parent_id, name, icon, color, position, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6,
            COALESCE((SELECT MAX(position) FROM folders
                       WHERE user_id = ?2 AND parent_id IS ?3 AND deleted_at IS NULL), 0) + 1000,
            ?7, ?7
      WHERE (?3 IS NULL OR EXISTS (
               SELECT 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
             ))
        AND COALESCE((SELECT MAX(depth) FROM ancestors), 0) < ?8`,
  ).bind(
    id,
    userId,
    parentId,
    name,
    body.icon ? truncateText(body.icon, 8) || null : null,
    organizerColorOrNull(body.color),
    now,
    LIMITS.folderDepthMax,
    LIMITS.folderDepthMax + 1,
  )
  const change = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'folder', ?2, 'upsert', ?3
      WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2 AND user_id = ?1)`,
  ).bind(userId, id, now)
  const [created] = await c.env.DB.batch([insert, change])
  if (!created?.meta.changes)
    throw ApiError.conflict(
      'The parent folder changed or a sibling already uses this name',
    )
  await broadcastCursor(c)
  return c.json(await loadFolder(c.env.DB, userId, id), 201)
})

foldersRoutes.patch('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const body = await readJson<{
    name?: string
    parentId?: string | null
    beforeId?: string | null
    icon?: string | null
    color?: string | null
  }>(c, JSON_BODY_LIMITS.small)

  const existing = await c.env.DB.prepare(
    `SELECT id, parent_id, updated_at FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(id, userId)
    .first<{ id: string; parent_id: string | null; updated_at: number }>()
  if (!existing) throw ApiError.notFound('Folder not found')

  const sets: string[] = []
  const binds: unknown[] = []

  if (body.name !== undefined && typeof body.name !== 'string') {
    throw ApiError.badRequest('name must be a string')
  }
  if (
    body.parentId !== undefined &&
    body.parentId !== null &&
    typeof body.parentId !== 'string'
  ) {
    throw ApiError.badRequest('parentId must be a string or null')
  }
  if (
    body.beforeId !== undefined &&
    body.beforeId !== null &&
    typeof body.beforeId !== 'string'
  ) {
    throw ApiError.badRequest('beforeId must be a string or null')
  }
  if (body.beforeId !== undefined && body.parentId === undefined) {
    throw ApiError.badRequest('parentId is required when reordering a folder')
  }
  if (body.beforeId === id)
    throw ApiError.badRequest('A folder cannot be placed before itself')
  if (
    body.icon !== undefined &&
    body.icon !== null &&
    typeof body.icon !== 'string'
  ) {
    throw ApiError.badRequest('icon must be a string or null')
  }
  if (typeof body.name === 'string') {
    const name = body.name.trim()
    if (!name) throw ApiError.badRequest('Folder name cannot be empty')
    if (name.length > LIMITS.folderNameMaxLength)
      throw ApiError.badRequest('Folder name is too long')
    binds.push(name)
    sets.push(`name = ?${binds.length}`)
  }
  if (body.icon !== undefined) {
    binds.push(body.icon ? truncateText(body.icon, 8) : null)
    sets.push(`icon = ?${binds.length}`)
  }
  if (body.color !== undefined) {
    if (body.color !== null && !organizerColorOrNull(body.color)) {
      throw ApiError.badRequest('Folder color is not supported')
    }
    binds.push(organizerColorOrNull(body.color))
    sets.push(`color = ?${binds.length}`)
  }
  const graph = await loadFolderGraph(c.env.DB, userId)
  let parentId = existing.parent_id
  if (body.parentId !== undefined) {
    parentId = validateParent(graph, body.parentId, id)
    const nextDepth =
      (parentId ? folderDepth(graph, parentId) : 0) + subtreeHeight(graph, id)
    if (nextDepth > LIMITS.folderDepthMax) {
      throw ApiError.badRequest(
        `Folder depth cannot exceed ${LIMITS.folderDepthMax} levels`,
      )
    }
    if (parentId !== existing.parent_id) {
      binds.push(parentId)
      sets.push(`parent_id = ?${binds.length}`)
    }
  }
  const parentChanged = parentId !== existing.parent_id
  const shouldPlace = body.beforeId !== undefined || parentChanged
  if (shouldPlace) {
    const position = await resolveFolderPosition(
      c.env.DB,
      userId,
      id,
      existing.parent_id,
      parentId,
      body.beforeId ?? null,
    )
    if (position !== null) {
      binds.push(position)
      sets.push(`position = ?${binds.length}`)
    }
  }
  if (!sets.length) return c.json(await loadFolder(c.env.DB, userId, id))

  const updatedAt = Math.max(Date.now(), existing.updated_at + 1)
  binds.push(updatedAt)
  sets.push(`updated_at = ?${binds.length}`)
  const shiftedSets = sets.map((set) =>
    set.replace(/\?(\d+)/g, (_m, n: string) => `?${Number(n) + 3}`),
  )
  const update = c.env.DB.prepare(
    `WITH RECURSIVE
       descendants(id, depth) AS (
         SELECT id, 1 FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
         UNION ALL
         SELECT f.id, d.depth + 1 FROM folders f JOIN descendants d ON f.parent_id = d.id
          WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND d.depth < ?${binds.length + 5}
       ),
       ancestors(id, parent_id, depth) AS (
         SELECT id, parent_id, 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
         UNION ALL
         SELECT f.id, f.parent_id, a.depth + 1 FROM folders f JOIN ancestors a ON f.id = a.parent_id
          WHERE f.user_id = ?2 AND f.deleted_at IS NULL AND a.depth < ?${binds.length + 5}
       )
     UPDATE OR IGNORE folders SET ${shiftedSets.join(', ')}
      WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL
        AND updated_at = ?${binds.length + 4}
        AND (?3 IS NULL OR EXISTS (
          SELECT 1 FROM folders WHERE id = ?3 AND user_id = ?2 AND deleted_at IS NULL
        ))
        AND NOT EXISTS (SELECT 1 FROM descendants WHERE id = ?3)
        AND COALESCE((SELECT MAX(depth) FROM ancestors), 0)
            + COALESCE((SELECT MAX(depth) FROM descendants), 1) <= ?${binds.length + 5}
        AND (?${binds.length + 6} IS NULL OR EXISTS (
          SELECT 1 FROM folders before_folder
           WHERE before_folder.id = ?${binds.length + 6}
             AND before_folder.user_id = ?2 AND before_folder.parent_id IS ?3
             AND before_folder.deleted_at IS NULL
        ))`,
  ).bind(
    id,
    userId,
    parentId,
    ...binds,
    existing.updated_at,
    LIMITS.folderDepthMax,
    body.beforeId ?? null,
  )
  const change = c.env.DB.prepare(
    `INSERT INTO changes (user_id, entity, entity_id, op, at)
     SELECT ?1, 'folder', ?2, 'upsert', ?3
      WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?2 AND user_id = ?1 AND updated_at = ?3)`,
  ).bind(userId, id, updatedAt)
  const [updated] = await c.env.DB.batch([update, change])
  if (!updated?.meta.changes)
    throw ApiError.conflict(
      'The folder changed elsewhere or a sibling already uses this name',
    )
  await broadcastCursor(c)
  return c.json(await loadFolder(c.env.DB, userId, id))
})

foldersRoutes.delete('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')
  const strategy = parseFolderDeleteStrategy(c.req.query('strategy'))
  const { ftsEnabled } = c.get('database')
  const now = Date.now()

  const row = await c.env.DB.prepare(
    `SELECT id, parent_id, position, updated_at FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
  )
    .bind(id, userId)
    .first<{
      id: string
      parent_id: string | null
      position: number
      updated_at: number
    }>()
  if (!row) throw ApiError.notFound('Folder not found')

  if (strategy === 'move-up') {
    const promotionOrder = await folderPromotionOrder(c.env.DB, userId, row)
    const promotionJson = JSON.stringify(promotionOrder)
    const guard = `EXISTS (SELECT 1 FROM folders
      WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at IS NULL)
      AND NOT EXISTS (
        SELECT 1 FROM folders child
        JOIN folders sibling
          ON sibling.user_id = child.user_id
         AND sibling.parent_id IS (
           SELECT parent_id FROM folders WHERE id = ?1 AND user_id = ?2
         )
         AND lower(sibling.name) = lower(child.name)
         AND sibling.deleted_at IS NULL
         AND sibling.id != ?1
         AND sibling.id != child.id
       WHERE child.parent_id = ?1 AND child.user_id = ?2 AND child.deleted_at IS NULL
      )`
    const statements = [
      c.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'folder', json_extract(item.value, '$.id'), 'upsert', ?4
           FROM json_each(?5) item WHERE ${guard}`,
      ).bind(id, userId, row.updated_at, now, promotionJson),
      c.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'note', id, 'upsert', ?4 FROM notes
          WHERE folder_id = ?1 AND user_id = ?2 AND ${guard}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'folder', ?1, 'delete', ?4 WHERE ${guard}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `UPDATE folders SET deleted_at = ?4
          WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3
            AND deleted_at IS NULL AND ${guard}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `UPDATE folders SET
           parent_id = CASE WHEN parent_id = ?1 THEN ?4 ELSE parent_id END,
           position = COALESCE((
             SELECT json_extract(item.value, '$.position') FROM json_each(?6) item
              WHERE json_extract(item.value, '$.id') = folders.id
           ), position),
           updated_at = MAX(updated_at + 1, ?5)
          WHERE id IN (SELECT json_extract(item.value, '$.id') FROM json_each(?6) item)
            AND user_id = ?2 AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM folders
              WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at = ?5)`,
      ).bind(id, userId, row.updated_at, row.parent_id, now, promotionJson),
      c.env.DB.prepare(
        `UPDATE notes SET folder_id = ?4, updated_at = MAX(updated_at + 1, ?5), rev = rev + 1
          WHERE folder_id = ?1 AND user_id = ?2
            AND EXISTS (SELECT 1 FROM folders
              WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at = ?5)`,
      ).bind(id, userId, row.updated_at, row.parent_id, now),
      c.env.DB.prepare(
        `DELETE FROM folders WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3
          AND deleted_at = ?4`,
      ).bind(id, userId, row.updated_at, now),
    ]
    const results = await c.env.DB.batch(statements)
    if (!results.at(-1)?.meta.changes)
      throw ApiError.conflict(
        'The folder changed elsewhere. Refresh and try again',
      )
  } else {
    const tree = subtreeCteWithRevision()
    const noteIds = `SELECT n.id FROM notes n WHERE n.user_id = ?2 AND n.folder_id IN (SELECT id FROM subtree)`
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `${tree} INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'folder', id, 'delete', ?4 FROM subtree`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `${tree} INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'note', id, 'upsert', ?4 FROM notes
          WHERE user_id = ?2 AND folder_id IN (SELECT id FROM subtree)`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `${tree} INSERT OR REPLACE INTO ai_index_queue (user_id, note_id, kind, created_at)
         SELECT ?2, id, 'delete', ?4 FROM notes
          WHERE user_id = ?2 AND folder_id IN (SELECT id FROM subtree)
            AND ${aiDeleteNeededSql('?2', 'notes.id')}`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `${tree} DELETE FROM links WHERE source_note_id IN (${noteIds})`,
      ).bind(id, userId, row.updated_at),
      c.env.DB.prepare(
        `${tree} UPDATE links SET target_note_id = (
           SELECT candidate.id FROM notes candidate
            WHERE candidate.user_id = links.user_id AND candidate.deleted_at IS NULL
              AND candidate.title_key = links.target_key
              AND candidate.id NOT IN (${noteIds})
            ORDER BY candidate.created_at ASC, candidate.id ASC LIMIT 1
         ) WHERE user_id = ?2 AND target_note_id IN (${noteIds})`,
      ).bind(id, userId, row.updated_at),
    ]
    if (ftsEnabled) {
      statements.push(
        c.env.DB.prepare(
          `${tree}
          INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
          SELECT ?2, id, 'delete', ?4 FROM notes WHERE id IN (${noteIds})
          ${FTS_QUEUE_CONFLICT_SQL}`,
        ).bind(id, userId, row.updated_at, now),
      )
    }
    statements.push(
      c.env.DB.prepare(
        `${tree} UPDATE notes SET folder_id = NULL, deleted_at = COALESCE(deleted_at, ?4),
          updated_at = MAX(updated_at + 1, ?4), rev = rev + 1
          WHERE user_id = ?2 AND folder_id IN (SELECT id FROM subtree)`,
      ).bind(id, userId, row.updated_at, now),
      c.env.DB.prepare(
        `${tree} DELETE FROM folders WHERE user_id = ?2 AND id IN (SELECT id FROM subtree)`,
      ).bind(id, userId, row.updated_at),
    )
    const results = await c.env.DB.batch(statements)
    if (!results.at(-1)?.meta.changes)
      throw ApiError.conflict(
        'The folder changed elsewhere. Refresh and try again',
      )
  }

  await broadcastCursor(c)
  return c.json({ ok: true })
})
