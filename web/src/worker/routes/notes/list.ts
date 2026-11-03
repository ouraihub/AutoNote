import { Hono } from 'hono'
import type {
  ListNotesResponse,
  SortKey,
  SortOrder,
  ViewKind,
} from '@shared/types'
import type { AppBindings } from '../../env'
import { NOTE_COLUMNS, toNoteSummary, type NoteRow } from '../../db/rows'
import {
  FTS_QUEUE_CONFLICT_SQL,
  LINK_TARGET_SUBQUERY,
  pruneOrphanTags,
} from '../../db/writes'
import { ApiError } from '../../lib/errors'
import { broadcastCursor, scheduleFtsDrain } from '../../lib/notify'
import { clampInt } from '../../lib/request'
import { aiDeleteNeededSql } from '../../mcp/ai-search'
import { encodeNotesListCursor, parseNotesListCursor } from './helpers'

export const listRoutes = new Hono<AppBindings>()
const NOTE_VIEWS = new Set<ViewKind>([
  'all',
  'recent',
  'starred',
  'unfiled',
  'archived',
  'trash',
  'folder',
  'tag',
])
const NOTE_SORTS = new Set<SortKey>(['updated', 'created', 'title'])
listRoutes.get('/', async (c) => {
  const userId = c.get('userId')
  const requestedView = c.req.query('view') as ViewKind | undefined
  const requestedSort = c.req.query('sort') as SortKey | undefined
  const view =
    requestedView && NOTE_VIEWS.has(requestedView) ? requestedView : 'all'
  const sort =
    requestedSort && NOTE_SORTS.has(requestedSort) ? requestedSort : 'updated'
  const order: SortOrder = c.req.query('order') === 'asc' ? 'asc' : 'desc'
  const limit = clampInt(c.req.query('limit'), 1, 1000, 500)
  const cursor = parseNotesListCursor(c.req.query('cursor'), view, sort, order)

  const binds: unknown[] = [userId]
  let where = 'n.user_id = ?1'

  if (view === 'trash') {
    where += ' AND n.deleted_at IS NOT NULL'
  } else {
    where += ' AND n.deleted_at IS NULL'
    where +=
      view === 'archived' ? ' AND n.is_archived = 1' : ' AND n.is_archived = 0'
  }

  if (view === 'starred') where += ' AND n.is_starred = 1'
  if (view === 'unfiled') where += ' AND n.folder_id IS NULL'

  if (view === 'folder') {
    const folderId = c.req.query('folderId')
    if (!folderId) throw ApiError.badRequest('Missing folderId')
    binds.push(folderId)
    where += ` AND n.folder_id = ?${binds.length}`
  }

  if (view === 'tag') {
    const tag = c.req.query('tag')
    if (!tag) throw ApiError.badRequest('Missing tag')
    binds.push(tag)
    where +=
      ' AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON ' +
      't.id = nt.tag_id\n                 WHERE nt.note_id = ' +
      'n.id AND t.user_id = n.user_id\n                   AND ' +
      't.name = ?' +
      `${binds.length}` +
      ' COLLATE NOCASE)'
  }

  const countWhere = where
  const countBinds = [...binds]

  const dir = order === 'asc' ? 'ASC' : 'DESC'
  const valueColumn =
    view === 'trash'
      ? 'n.deleted_at'
      : sort === 'created'
        ? 'n.created_at'
        : sort === 'title'
          ? 'n.title'
          : 'n.updated_at'
  const valueCollation =
    sort === 'title' && view !== 'trash' ? ' COLLATE NOCASE' : ''
  const orderBy =
    view === 'trash'
      ? `n.deleted_at ${dir}, n.id ASC`
      : ({
          updated: `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`,
          created: `n.is_pinned DESC, n.created_at ${dir}, n.id ASC`,
          title: `n.is_pinned DESC, n.title COLLATE NOCASE ${dir}, n.id ASC`,
        }[sort] ?? `n.is_pinned DESC, n.updated_at ${dir}, n.id ASC`)

  if (cursor.kind === 'keyset') {
    const comparison = order === 'asc' ? '>' : '<'
    if (view === 'trash') {
      binds.push(cursor.cursor.value, cursor.cursor.value, cursor.cursor.id)
      const valueBind = binds.length - 2
      const repeatedValueBind = binds.length - 1
      const idBind = binds.length
      where +=
        ' AND (' +
        `${valueColumn}` +
        `${valueCollation}` +
        ' ' +
        `${comparison}` +
        ' ?' +
        `${valueBind}` +
        '\n        OR (' +
        `${valueColumn}` +
        `${valueCollation}` +
        ' = ?' +
        `${repeatedValueBind}` +
        ' AND n.id > ?' +
        `${idBind}` +
        '))'
    } else {
      binds.push(
        cursor.cursor.pinned,
        cursor.cursor.pinned,
        cursor.cursor.value,
        cursor.cursor.value,
        cursor.cursor.id,
      )
      const firstPinnedBind = binds.length - 4
      const repeatedPinnedBind = binds.length - 3
      const valueBind = binds.length - 2
      const repeatedValueBind = binds.length - 1
      const idBind = binds.length
      where +=
        ' AND (n.is_pinned < ?' +
        `${firstPinnedBind}` +
        '\n        OR (n.is_pinned = ?' +
        `${repeatedPinnedBind}` +
        ' AND (\n          ' +
        `${valueColumn}` +
        `${valueCollation}` +
        ' ' +
        `${comparison}` +
        ' ?' +
        `${valueBind}` +
        '\n          OR (' +
        `${valueColumn}` +
        `${valueCollation}` +
        ' = ?' +
        `${repeatedValueBind}` +
        ' AND n.id > ?' +
        `${idBind}` +
        ')\n        )))'
    }
  }

  const listSql =
    cursor.kind === 'legacy'
      ? `SELECT ${NOTE_COLUMNS} FROM notes n WHERE ${where} ORDER BY ${orderBy}
       LIMIT ?${binds.length + 1} OFFSET ?${binds.length + 2}`
      : `SELECT ${NOTE_COLUMNS} FROM notes n WHERE ${where} ORDER BY ${orderBy}
       LIMIT ?${binds.length + 1}`
  const listStatement =
    cursor.kind === 'legacy'
      ? c.env.DB.prepare(listSql).bind(...binds, limit + 1, cursor.offset)
      : c.env.DB.prepare(listSql).bind(...binds, limit + 1)
  const [countResult, listResult] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS total FROM notes n WHERE ${countWhere}`,
    ).bind(...countBinds),
    listStatement,
  ])

  const total = Number(
    (countResult?.results?.[0] as { total?: unknown } | undefined)?.total ?? 0,
  )
  const rows = (listResult?.results as NoteRow[] | undefined) ?? []
  const pageRows = rows.slice(0, limit)
  const notes = pageRows.map(toNoteSummary)
  const body: ListNotesResponse = {
    notes,
    total,
    nextCursor:
      rows.length > limit && pageRows.length
        ? encodeNotesListCursor(
            pageRows[pageRows.length - 1]!,
            view,
            sort,
            order,
          )
        : null,
  }
  return c.json(body)
})

listRoutes.post('/trash/empty', async (c) => {
  const userId = c.get('userId')
  const { ftsEnabled } = c.get('database')
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) AS count FROM notes WHERE user_id = ?1 ' +
      'AND deleted_at IS NOT NULL',
  )
    .bind(userId)
    .first<{ count: number }>()
  let purged = 0
  let deletionCursor: number | undefined

  if ((row?.count ?? 0) > 0) {
    const trashed =
      'SELECT id FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL'
    const statements = [
      c.env.DB.prepare(
        `DELETE FROM note_tags WHERE note_id IN (${trashed})`,
      ).bind(userId),
      c.env.DB.prepare(
        `DELETE FROM links WHERE source_note_id IN (${trashed})`,
      ).bind(userId),
      c.env.DB.prepare(
        `UPDATE links SET target_note_id = ${LINK_TARGET_SUBQUERY}
          WHERE user_id = ?1 AND target_note_id IN (${trashed})`,
      ).bind(userId),
      c.env.DB.prepare(
        `DELETE FROM note_versions WHERE note_id IN (${trashed})`,
      ).bind(userId),
      c.env.DB.prepare(
        'DELETE FROM share_asset_sessions WHERE slug IN (\n       ' +
          '    SELECT slug FROM shares WHERE user_id = ?1 AND ' +
          'note_id IN (' +
          `${trashed}` +
          ')\n         )',
      ).bind(userId),
      c.env.DB.prepare(`DELETE FROM shares WHERE note_id IN (${trashed})`).bind(
        userId,
      ),
      c.env.DB.prepare(
        `UPDATE attachments SET note_id = NULL WHERE note_id IN (${trashed})`,
      ).bind(userId),
      c.env.DB.prepare(
        `DELETE FROM import_mappings
          WHERE user_id = ?1 AND entity = 'note' AND target_id IN (${trashed})`,
      ).bind(userId),
    ]
    if (ftsEnabled) {
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO fts_index_queue (user_id, note_id, kind, created_at)
           SELECT ?1, id, 'delete', ?2
             FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL
           ${FTS_QUEUE_CONFLICT_SQL}`,
        ).bind(userId, Date.now()),
      )
    }
    statements.push(
      c.env.DB.prepare(
        'INSERT OR REPLACE INTO ai_index_queue (user_id, ' +
          'note_id, kind, created_at)\n         SELECT ?1, id, ' +
          "'delete', ?2\n           FROM notes WHERE user_id = ?1 " +
          'AND deleted_at IS NOT NULL\n             AND ' +
          `${aiDeleteNeededSql('?1', 'notes.id')}`,
      ).bind(userId, Date.now()),
      c.env.DB.prepare(
        `INSERT INTO changes (user_id, entity, entity_id, op, at)
           SELECT ?1, 'note', id, 'delete', ?2
             FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL`,
      ).bind(userId, Date.now()),
      c.env.DB.prepare(
        `SELECT seq FROM changes WHERE user_id = ?1 ORDER BY seq DESC LIMIT 1`,
      ).bind(userId),
      c.env.DB.prepare(
        `DELETE FROM notes WHERE user_id = ?1 AND deleted_at IS NOT NULL`,
      ).bind(userId),
    )
    const results = await c.env.DB.batch(statements)
    const changeResult = results.at(-2) as D1Result<{ seq: number }> | undefined
    purged = results.at(-1)?.meta.changes ?? 0
    deletionCursor = changeResult?.results?.at(-1)?.seq
    if (purged) scheduleFtsDrain(c)
  }
  await pruneOrphanTags(c.env.DB, userId)
  await broadcastCursor(c, deletionCursor)
  return c.json({ purged })
})
