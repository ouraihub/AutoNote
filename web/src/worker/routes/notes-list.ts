import { Hono } from 'hono'
import type { AppBindings } from '../env'
import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../lib/encoding'
import type { ListNotesResponse, SortKey, SortOrder, ViewKind } from '@shared/types'
import { NOTE_COLUMNS, type NoteRow, toNoteSummary } from '../db/rows'
import { ApiError } from '../lib/errors'
import { clampInt } from '../lib/request'

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

interface NotesListCursor {
  view: ViewKind
  sort: SortKey
  order: SortOrder
  pinned: number
  value: string | number
  id: string
}
type ParsedNotesListCursor =
  | { kind: 'first' }
  | { kind: 'legacy'; offset: number }
  | { kind: 'keyset'; cursor: NotesListCursor }
export function restoredVersionTitle(title: string): string {
  return resolveNoteTitle(title)
}

export function resolveNoteTitle(
  title: string | undefined,
  current = '',
): string {
  return title === undefined
    ? current
    : truncateText(title.trim(), LIMITS.titleMaxLength)
}

export function nextNotesCursor(
  offset: number,
  returned: number,
  total: number,
): string | null {
  const next = offset + returned
  return returned > 0 && next < total ? String(next) : null
}

export function encodeNotesListCursor(
  row: NoteRow,
  view: ViewKind,
  sort: SortKey,
  order: SortOrder,
): string {
  const value =
    view === 'trash'
      ? row.deleted_at
      : sort === 'created'
        ? row.created_at
        : sort === 'title'
          ? row.title
          : row.updated_at
  const payload: NotesListCursor = {
    view,
    sort,
    order,
    pinned: view === 'trash' ? 0 : row.is_pinned,
    value: value ?? 0,
    id: row.id,
  }
  return `n1.${toBase64Url(utf8(JSON.stringify(payload)))}`
}

export function parseNotesListCursor(
  raw: string | undefined,
  view: ViewKind,
  sort: SortKey,
  order: SortOrder,
): ParsedNotesListCursor {
  if (!raw) return { kind: 'first' }
  if (/^\d+$/.test(raw)) {
    return { kind: 'legacy', offset: clampInt(raw, 0, 1_000_000, 0) }
  }
  if (raw.length > 4096 || !raw.startsWith('n1.'))
    throw ApiError.badRequest('Invalid notes cursor')
  try {
    const value = JSON.parse(
      fromUtf8(fromBase64Url(raw.slice(3))),
    ) as Partial<NotesListCursor>
    const expectedTitle = view !== 'trash' && sort === 'title'
    const validValue = expectedTitle
      ? typeof value.value === 'string' &&
        value.value.length <= LIMITS.titleMaxLength
      : typeof value.value === 'number' &&
        Number.isSafeInteger(value.value) &&
        value.value >= 0
    if (
      value.view !== view ||
      value.sort !== sort ||
      value.order !== order ||
      (value.pinned !== 0 && value.pinned !== 1) ||
      !validValue ||
      typeof value.id !== 'string' ||
      value.id.length < 1 ||
      value.id.length > 128
    ) {
      throw new Error('invalid')
    }
    return { kind: 'keyset', cursor: value as NotesListCursor }
  } catch {
    throw ApiError.badRequest('Invalid notes cursor')
  }
}
export function registerNotesListRoutes(routes: Hono<AppBindings>): void {
  const notesRoutes = routes
notesRoutes.get('/', async (c) => {
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
    where += ` AND EXISTS (SELECT 1 FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
                 WHERE nt.note_id = n.id AND t.user_id = n.user_id
                   AND t.name = ?${binds.length} COLLATE NOCASE)`
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
      where += ` AND (${valueColumn}${valueCollation} ${comparison} ?${valueBind}
        OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind}))`
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
      where += ` AND (n.is_pinned < ?${firstPinnedBind}
        OR (n.is_pinned = ?${repeatedPinnedBind} AND (
          ${valueColumn}${valueCollation} ${comparison} ?${valueBind}
          OR (${valueColumn}${valueCollation} = ?${repeatedValueBind} AND n.id > ?${idBind})
        )))`
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
}
