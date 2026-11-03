import { Hono } from 'hono'
import { LIMITS } from '@shared/constants'
import { wikiNoteTarget } from '@shared/markdown-utils'
import type { GraphResponse } from '@shared/types'
import type { AppBindings } from '../env'
import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'
import { clampInt } from '../lib/request'
import { requireAuth } from '../middleware/auth'
const GRAPH_EDGE_CANDIDATE_LIMIT = 10_000

export function registerGraphRoute(routes: Hono<AppBindings>): void {
  routes.get('/graph', requireAuth, async (c) => {
    const userId = c.get('userId')
    const mode = c.req.query('mode') === 'local' ? 'local' : 'global'
    const rawCenter = (c.req.query('center') ?? '').trim()
    const centerId = rawCenter && isValidId(rawCenter) ? rawCenter : null
    const depth = clampInt(c.req.query('depth'), 1, 3, 1)
    const limit = clampInt(c.req.query('limit'), 50, 600, 350)
    const query = (c.req.query('q') ?? '').trim()
    const rawFolderId = (c.req.query('folderId') ?? '').trim()
    const folderId = rawFolderId && isValidId(rawFolderId) ? rawFolderId : ''
    const tag = (c.req.query('tag') ?? '').trim()
    const includeOrphans = c.req.query('includeOrphans') !== '0'
    const includeUnresolved = c.req.query('includeUnresolved') === '1'

    if (rawCenter && !centerId) {
      throw new ApiError(
        400,
        'bad_request',
        'The center note id is not a valid note id',
      )
    }
    if (rawFolderId && !folderId) {
      throw new ApiError(
        400,
        'bad_request',
        'The folder id is not a valid folder id',
      )
    }
    if (query.length > 200) {
      throw new ApiError(
        400,
        'bad_request',
        'The graph search query cannot exceed 200 characters',
      )
    }
    if (tag.length > LIMITS.tagNameMaxLength) {
      throw new ApiError(
        400,
        'bad_request',
        `The graph tag cannot exceed ${LIMITS.tagNameMaxLength} characters`,
      )
    }
    if (mode === 'local' && !centerId) {
      throw new ApiError(
        400,
        'bad_request',
        'A center note is required for the local graph',
      )
    }

    const filters: string[] = [
      'n.user_id = ?',
      'n.deleted_at IS NULL',
      'n.is_archived = 0',
    ]
    const filterBinds: unknown[] = [userId]
    if (query) {
      filters.push(`n.title LIKE ? ESCAPE '\\' COLLATE NOCASE`)
      filterBinds.push(`%${escapeLike(query)}%`)
    }
    if (folderId) {
      filters.push('n.folder_id = ?')
      filterBinds.push(folderId)
    }
    if (tag) {
      filters.push(
        'EXISTS (\n      SELECT 1 FROM note_tags nt_filter\n      ' +
          'JOIN tags t_filter ON t_filter.id = nt_filter.tag_id ' +
          'AND t_filter.user_id = n.user_id\n      WHERE ' +
          'nt_filter.note_id = n.id AND t_filter.name = ? COLLATE ' +
          'NOCASE\n    )',
      )
      filterBinds.push(tag)
    }
    if (!includeOrphans) {
      filters.push(
        'EXISTS (\n      SELECT 1 FROM links connected\n      ' +
          'WHERE connected.user_id = n.user_id AND ' +
          'connected.target_note_id IS NOT NULL\n        AND ' +
          '(connected.source_note_id = n.id OR ' +
          'connected.target_note_id = n.id)\n    )',
      )
    }

    const degreeSelect =
      '\n    (SELECT COUNT(*) FROM (\n      SELECT target_key ' +
      'FROM links ld WHERE ld.source_note_id = n.id\n        ' +
      'AND ld.user_id = ? AND ld.target_note_id IS NOT NULL\n   ' +
      '   UNION ALL\n      SELECT target_key FROM links ld ' +
      'WHERE ld.target_note_id = n.id\n        AND ld.user_id = ' +
      'n.user_id AND ld.source_note_id != n.id\n    )) AS ' +
      'degree,\n    (SELECT COUNT(*) FROM links li WHERE ' +
      'li.user_id = ? AND li.target_note_id = n.id) AS ' +
      'in_degree,\n    (SELECT COUNT(*) FROM links lo WHERE ' +
      'lo.user_id = ? AND lo.source_note_id = n.id\n      AND ' +
      'lo.target_note_id IS NOT NULL) AS out_degree'

    const { rows, totalNodes } =
      mode === 'local'
        ? await loadLocalGraph(
            c.env.DB,
            centerId!,
            userId,
            depth,
            limit,
            filters,
            filterBinds,
            degreeSelect,
          )
        : await loadGlobalGraph(
            c.env.DB,
            userId,
            limit,
            filters,
            filterBinds,
            degreeSelect,
          )

    const noteLimit = includeUnresolved ? Math.max(1, limit - 50) : limit
    let truncated = rows.length > noteLimit || totalNodes > noteLimit
    const visibleRows = rows.slice(0, noteLimit)
    const known = new Set(visibleRows.map((row) => row.id))
    const ids = [...known]
    const edges: GraphResponse['edges'] = []
    const unresolved = new Map<
      string,
      { title: string; sources: Set<string> }
    >()
    const tagsByNote = new Map<
      string,
      Array<{ name: string; color: string | null }>
    >()
    if (ids.length) {
      const idSet = JSON.stringify(ids)
      const [linkResult, tagResult] = await Promise.all([
        c.env.DB.prepare(
          'SELECT source_note_id, target_note_id, target_key, ' +
            'target_title FROM links\n         WHERE user_id = ? AND ' +
            'source_note_id IN (SELECT value FROM json_each(?))\n     ' +
            '      AND (target_note_id IN (SELECT value FROM ' +
            'json_each(?))' +
            `${includeUnresolved ? ' OR target_note_id IS NULL' : ''}` +
            ')\n         ORDER BY source_note_id ASC, target_key ASC ' +
            'LIMIT ?',
        )
          .bind(userId, idSet, idSet, GRAPH_EDGE_CANDIDATE_LIMIT + 1)
          .all<{
            source_note_id: string
            target_note_id: string | null
            target_key: string
            target_title: string
          }>(),
        c.env.DB.prepare(
          'SELECT nt.note_id, t.name, t.color FROM note_tags nt\n   ' +
            '      JOIN tags t ON t.id = nt.tag_id AND t.user_id = ' +
            '?\n         WHERE nt.note_id IN (SELECT value FROM ' +
            'json_each(?)) ORDER BY t.name COLLATE NOCASE ASC',
        )
          .bind(userId, idSet)
          .all<{ note_id: string; name: string; color: string | null }>(),
      ])
      if (linkResult.results.length > GRAPH_EDGE_CANDIDATE_LIMIT)
        truncated = true
      const seen = new Set<string>()
      for (const link of linkResult.results.slice(
        0,
        GRAPH_EDGE_CANDIDATE_LIMIT,
      )) {
        if (link.target_note_id === null) {
          if (
            !includeUnresolved ||
            (unresolved.size >= 50 && !unresolved.has(link.target_key))
          )
            continue
          const current = unresolved.get(link.target_key) ?? {
            title: wikiNoteTarget(link.target_title),
            sources: new Set<string>(),
          }
          current.sources.add(link.source_note_id)
          unresolved.set(link.target_key, current)
          continue
        }
        if (link.source_note_id === link.target_note_id) continue
        const key = `${link.source_note_id}>${link.target_note_id}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push({ source: link.source_note_id, target: link.target_note_id })
      }
      for (const item of tagResult.results) {
        const values = tagsByNote.get(item.note_id) ?? []
        values.push({ name: item.name, color: item.color })
        tagsByNote.set(item.note_id, values)
      }
    }

    const nodes: GraphResponse['nodes'] = visibleRows.map((row) => ({
      id: row.id,
      title: row.title,
      kind: 'note',
      degree: Number(row.degree),
      inDegree: Number(row.in_degree),
      outDegree: Number(row.out_degree),
      folderId: row.folder_id,
      folderName: row.folder_name,
      folderColor: row.folder_color,
      tags: tagsByNote.get(row.id) ?? [],
    }))
    const nodeById = new Map(nodes.map((node) => [node.id, node]))
    for (const [key, missing] of unresolved) {
      const id = `unresolved:${key}`
      nodes.push({
        id,
        title: missing.title,
        kind: 'unresolved',
        degree: missing.sources.size,
        inDegree: missing.sources.size,
        outDegree: 0,
        folderId: null,
        folderName: null,
        folderColor: null,
        tags: [],
      })
      for (const source of missing.sources) {
        edges.push({ source, target: id })
        const sourceNode = nodeById.get(source)
        if (sourceNode) {
          sourceNode.degree++
          sourceNode.outDegree++
        }
      }
    }
    if (unresolved.size >= 50) truncated = true

    const body: GraphResponse = {
      nodes,
      edges,
      meta: {
        mode,
        centerId: mode === 'local' ? centerId : null,
        depth,
        totalNodes: totalNodes + unresolved.size,
        totalEdges: edges.length,
        truncated,
        limit,
      },
    }
    return c.json(body)
  })
}

type GraphRow = {
  id: string
  title: string
  folder_id: string | null
  folder_name: string | null
  folder_color: string | null
  degree: number
  in_degree: number
  out_degree: number
}

async function loadLocalGraph(
  db: D1Database,
  centerId: string,
  userId: string,
  depth: number,
  limit: number,
  filters: string[],
  filterBinds: unknown[],
  degreeSelect: string,
): Promise<{ rows: GraphRow[]; totalNodes: number }> {
  const neighborhood =
    'WITH RECURSIVE neighborhood(id, depth) AS (\n      ' +
    'SELECT ? AS id, 0 AS depth\n      UNION\n      SELECT ' +
    'CASE WHEN l.source_note_id = neighborhood.id THEN ' +
    'l.target_note_id ELSE l.source_note_id END,\n        ' +
    'neighborhood.depth + 1\n      FROM neighborhood\n      ' +
    'JOIN links l ON l.user_id = ? AND l.target_note_id IS ' +
    'NOT NULL\n        AND (l.source_note_id = ' +
    'neighborhood.id OR l.target_note_id = neighborhood.id)\n ' +
    '     JOIN notes adjacent ON adjacent.id = CASE\n        ' +
    'WHEN l.source_note_id = neighborhood.id THEN ' +
    'l.target_note_id ELSE l.source_note_id END\n        AND ' +
    'adjacent.user_id = l.user_id AND adjacent.deleted_at IS ' +
    'NULL AND adjacent.is_archived = 0\n      WHERE ' +
    'neighborhood.depth < ?\n    ), nearby AS (SELECT id, ' +
    'MIN(depth) AS depth FROM neighborhood GROUP BY id)'
  const prefixBinds = [centerId, userId, depth]
  const result = await db
    .prepare(
      `${neighborhood}` +
        '\n       SELECT n.id, n.title, n.folder_id, f.name AS ' +
        'folder_name, f.color AS folder_color,\n         ' +
        `${degreeSelect}` +
        ', nearby.depth\n       FROM nearby JOIN notes n ON n.id ' +
        '= nearby.id\n       LEFT JOIN folders f ON f.id = ' +
        'n.folder_id AND f.user_id = n.user_id\n       WHERE ' +
        `${filters.join(' AND ')}` +
        '\n       ORDER BY nearby.depth ASC, degree DESC, ' +
        'n.updated_at DESC, n.id ASC LIMIT ?',
    )
    .bind(...prefixBinds, userId, userId, userId, ...filterBinds, limit + 1)
    .all<GraphRow>()
  const count = await db
    .prepare(
      `${neighborhood}` +
        ' SELECT COUNT(*) AS count FROM nearby JOIN notes n ON ' +
        'n.id = nearby.id\n       WHERE ' +
        `${filters.join(' AND ')}`,
    )
    .bind(...prefixBinds, ...filterBinds)
    .first<{ count: number }>()
  return {
    rows: result.results,
    totalNodes: Number(count?.count ?? result.results.length),
  }
}

async function loadGlobalGraph(
  db: D1Database,
  userId: string,
  limit: number,
  filters: string[],
  filterBinds: unknown[],
  degreeSelect: string,
): Promise<{ rows: GraphRow[]; totalNodes: number }> {
  const result = await db
    .prepare(
      'SELECT n.id, n.title, n.folder_id, f.name AS ' +
        'folder_name, f.color AS folder_color,\n         ' +
        `${degreeSelect}` +
        '\n       FROM notes n LEFT JOIN folders f ON f.id = ' +
        'n.folder_id AND f.user_id = n.user_id\n       WHERE ' +
        `${filters.join(' AND ')}` +
        '\n       ORDER BY degree DESC, n.updated_at DESC, n.id ' +
        'ASC LIMIT ?',
    )
    .bind(userId, userId, userId, ...filterBinds, limit + 1)
    .all<GraphRow>()
  const count = await db
    .prepare(
      `SELECT COUNT(*) AS count FROM notes n WHERE ${filters.join(' AND ')}`,
    )
    .bind(...filterBinds)
    .first<{ count: number }>()
  return {
    rows: result.results,
    totalNodes: Number(count?.count ?? result.results.length),
  }
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
