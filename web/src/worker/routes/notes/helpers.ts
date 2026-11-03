import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'
import type { SortKey, SortOrder, ViewKind } from '@shared/types'
import type { NoteRow } from '../../db/rows'
import { fromBase64Url, fromUtf8, toBase64Url, utf8 } from '../../lib/encoding'
import { ApiError } from '../../lib/errors'
import { clampInt } from '../../lib/request'

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
  if (raw.length > 4096 || !raw.startsWith('n1.')) {
    throw ApiError.badRequest('Invalid notes cursor')
  }
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
    )
      throw new Error('invalid')
    return { kind: 'keyset', cursor: value as NotesListCursor }
  } catch {
    throw ApiError.badRequest('Invalid notes cursor')
  }
}

export function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(
    /\?(\d+)/g,
    (_match, value: string) => `?${Number(value) + offset}`,
  )
}

export function push(
  sets: string[],
  binds: unknown[],
  column: string,
  value: unknown,
): void {
  binds.push(value)
  sets.push(`${column} = ?${binds.length}`)
}
