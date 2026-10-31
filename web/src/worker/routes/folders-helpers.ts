import type { Folder } from '@shared/types'
import { toFolder, type FolderRow } from '../db/rows'
import { ApiError } from '../lib/errors'

export const FOLDER_SELECT = `f.id, f.parent_id, f.name, f.icon, f.color, f.position, f.created_at, f.updated_at`

export async function loadFolder(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Folder> {
  const row = await db
    .prepare(
      `SELECT ${FOLDER_SELECT} FROM folders f WHERE f.id = ?1 AND f.user_id = ?2`,
    )
    .bind(id, userId)
    .first<FolderRow>()
  if (!row) throw ApiError.notFound('Folder not found')
  return toFolder(row)
}

interface FolderGraph {
  parents: Map<string, string | null>
  children: Map<string, string[]>
  siblingNames: Map<string, Set<string>>
}

interface FolderOrderRow {
  id: string
  position: number
  created_at: number
}

interface FolderPromotionRow extends FolderOrderRow {
  parent_id: string | null
}

export async function loadFolderGraph(
  db: D1Database,
  userId: string,
): Promise<FolderGraph> {
  const { results } = await db
    .prepare(
      `SELECT id, parent_id, name FROM folders WHERE user_id = ?1 AND deleted_at IS NULL`,
    )
    .bind(userId)
    .all<{ id: string; parent_id: string | null; name: string }>()
  const parents = new Map<string, string | null>()
  const children = new Map<string, string[]>()
  const siblingNames = new Map<string, Set<string>>()
  for (const row of results) {
    parents.set(row.id, row.parent_id)
    const key = row.parent_id ?? ''
    const list = children.get(key) ?? []
    list.push(row.id)
    children.set(key, list)
    const names = siblingNames.get(key) ?? new Set<string>()
    names.add(row.name.toLocaleLowerCase())
    siblingNames.set(key, names)
  }
  return { parents, children, siblingNames }
}

export function availableFolderName(
  graph: FolderGraph,
  parentId: string | null,
  base: string,
): string {
  const names = graph.siblingNames.get(parentId ?? '') ?? new Set<string>()
  if (!names.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix++
  return `${base} ${suffix}`
}

export async function resolveFolderPosition(
  db: D1Database,
  userId: string,
  id: string,
  currentParentId: string | null,
  parentId: string | null,
  beforeId: string | null,
): Promise<number | null> {
  let rows = await loadSiblingOrder(db, userId, parentId)
  const currentOrder = rows.map((row) => row.id)
  let siblings = rows.filter((row) => row.id !== id)
  let index =
    beforeId === null
      ? siblings.length
      : siblings.findIndex((row) => row.id === beforeId)
  if (index < 0)
    throw ApiError.badRequest('The target folder is not in the destination')

  const desiredOrder = siblings.map((row) => row.id)
  desiredOrder.splice(index, 0, id)
  if (
    currentParentId === parentId &&
    currentOrder.length === desiredOrder.length &&
    currentOrder.every(
      (folderId, orderIndex) => folderId === desiredOrder[orderIndex],
    )
  ) {
    return null
  }

  let position = insertionPosition(
    siblings[index - 1]?.position,
    siblings[index]?.position,
  )
  if (position !== null) return position

  await normalizeSiblingPositions(db, userId, siblings)
  rows = await loadSiblingOrder(db, userId, parentId)
  siblings = rows.filter((row) => row.id !== id)
  index =
    beforeId === null
      ? siblings.length
      : siblings.findIndex((row) => row.id === beforeId)
  if (index < 0)
    throw ApiError.conflict('The destination folder order changed. Try again')
  position = insertionPosition(
    siblings[index - 1]?.position,
    siblings[index]?.position,
  )
  if (position === null)
    throw ApiError.conflict('The folder order changed. Try again')
  return position
}

export async function loadSiblingOrder(
  db: D1Database,
  userId: string,
  parentId: string | null,
): Promise<FolderOrderRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, position, created_at FROM folders
      WHERE user_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL
      ORDER BY position ASC, created_at ASC, id ASC`,
    )
    .bind(userId, parentId)
    .all<FolderOrderRow>()
  return results
}

export function insertionPosition(
  previous: number | undefined,
  next: number | undefined,
): number | null {
  if (previous === undefined && next === undefined) return 1000
  if (previous === undefined) return next! - 1000
  if (next === undefined) return previous + 1000
  const position = previous + (next - previous) / 2
  return Number.isFinite(position) && position > previous && position < next
    ? position
    : null
}

export async function normalizeSiblingPositions(
  db: D1Database,
  userId: string,
  siblings: FolderOrderRow[],
): Promise<void> {
  const MAX_BATCH_STATEMENTS = 80
  const now = Date.now()
  const statements: D1PreparedStatement[] = []
  for (let index = 0; index < siblings.length; index++) {
    const sibling = siblings[index]!
    const position = (index + 1) * 1000
    if (sibling.position === position) continue
    statements.push(
      db
        .prepare(
          `UPDATE folders SET position = ?3, updated_at = MAX(updated_at + 1, ?4)
          WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
        )
        .bind(sibling.id, userId, position, now),
      db
        .prepare(
          `INSERT INTO changes (user_id, entity, entity_id, op, at)
         SELECT ?2, 'folder', ?1, 'upsert', ?3
          WHERE EXISTS (SELECT 1 FROM folders WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL)`,
        )
        .bind(sibling.id, userId, now),
    )
  }
  for (
    let start = 0;
    start < statements.length;
    start += MAX_BATCH_STATEMENTS
  ) {
    await db.batch(statements.slice(start, start + MAX_BATCH_STATEMENTS))
  }
}

export async function folderPromotionOrder(
  db: D1Database,
  userId: string,
  folder: { id: string; parent_id: string | null; position: number },
): Promise<Array<{ id: string; position: number }>> {
  const { results } = await db
    .prepare(
      `SELECT id, parent_id, position, created_at FROM folders
      WHERE user_id = ?1 AND deleted_at IS NULL
        AND (parent_id IS ?2 OR parent_id = ?3)`,
    )
    .bind(userId, folder.parent_id, folder.id)
    .all<FolderPromotionRow>()
  const compare = (left: FolderOrderRow, right: FolderOrderRow) =>
    left.position - right.position ||
    left.created_at - right.created_at ||
    left.id.localeCompare(right.id)
  const siblings = results
    .filter((row) => row.parent_id === folder.parent_id)
    .sort(compare)
  const children = results
    .filter((row) => row.parent_id === folder.id)
    .sort(compare)
  if (!children.length) return []

  const folderIndex = siblings.findIndex((row) => row.id === folder.id)
  if (folderIndex < 0)
    throw ApiError.conflict(
      'The folder hierarchy changed. Refresh and try again',
    )
  const previous = siblings[folderIndex - 1]?.position
  const next = siblings[folderIndex + 1]?.position
  const positions = positionsBetween(previous, next, children.length)
  if (positions) {
    return children.map((child, index) => ({
      id: child.id,
      position: positions[index]!,
    }))
  }

  const desired = [...siblings]
  desired.splice(folderIndex, 1, ...children)
  return desired.flatMap((row, index) => {
    const position = (index + 1) * 1000
    return row.parent_id === folder.id || row.position !== position
      ? [{ id: row.id, position }]
      : []
  })
}

function positionsBetween(
  previous: number | undefined,
  next: number | undefined,
  count: number,
): number[] | null {
  if (!count) return []
  if (previous === undefined && next === undefined) {
    return Array.from({ length: count }, (_, index) => (index + 1) * 1000)
  }
  if (previous === undefined) {
    return Array.from(
      { length: count },
      (_, index) => next! - (count - index) * 1000,
    )
  }
  if (next === undefined) {
    return Array.from(
      { length: count },
      (_, index) => previous + (index + 1) * 1000,
    )
  }
  const step = (next - previous) / (count + 1)
  if (!Number.isFinite(step) || step <= 0) return null
  const positions = Array.from(
    { length: count },
    (_, index) => previous + step * (index + 1),
  )
  return positions.every(
    (position, index) =>
      Number.isFinite(position) &&
      position > (index === 0 ? previous : positions[index - 1]!) &&
      position < next,
  )
    ? positions
    : null
}

export function validateParent(
  graph: FolderGraph,
  parentId: string | null | undefined,
  selfId?: string,
): string | null {
  if (!parentId) return null
  if (!graph.parents.has(parentId))
    throw ApiError.badRequest('The parent folder does not exist')

  const visited = new Set<string>()
  let cursor: string | null = parentId
  while (cursor) {
    if (cursor === selfId)
      throw ApiError.badRequest(
        'A folder cannot be moved into its own descendant',
      )
    if (visited.has(cursor))
      throw ApiError.badRequest('The folder hierarchy contains a cycle')
    visited.add(cursor)
    cursor = graph.parents.get(cursor) ?? null
  }
  return parentId
}

export function subtreeCteWithRevision(): string {
  return `WITH RECURSIVE subtree(id) AS (
    SELECT id FROM folders
     WHERE id = ?1 AND user_id = ?2 AND updated_at = ?3 AND deleted_at IS NULL
    UNION
    SELECT f.id FROM folders f JOIN subtree s ON f.parent_id = s.id
     WHERE f.user_id = ?2 AND f.deleted_at IS NULL
  )`
}

export function parseFolderDeleteStrategy(
  value: unknown,
): 'move-up' | 'delete' {
  if (value === undefined || value === null || value === '') return 'move-up'
  if (value === 'move-up' || value === 'delete') return value
  throw ApiError.badRequest('strategy must be move-up or delete')
}

export function folderDepth(graph: FolderGraph, id: string): number {
  let depth = 1
  let cursor = graph.parents.get(id) ?? null
  const guard = new Set<string>([id])
  while (cursor && !guard.has(cursor) && depth < 64) {
    guard.add(cursor)
    cursor = graph.parents.get(cursor) ?? null
    depth++
  }
  return depth
}

export function subtreeHeight(graph: FolderGraph, rootId: string): number {
  let height = 1
  const visited = new Set<string>()
  const stack: Array<[string, number]> = [[rootId, 1]]
  while (stack.length) {
    const [id, depth] = stack.pop()!
    if (visited.has(id)) continue
    visited.add(id)
    height = Math.max(height, depth)
    for (const child of graph.children.get(id) ?? [])
      stack.push([child, depth + 1])
  }
  return height
}
