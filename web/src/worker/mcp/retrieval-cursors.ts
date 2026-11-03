import { ApiError } from '../lib/errors'
import { isValidId } from '../lib/id'

export type ListCursor =
  | { kind: 'offset'; offset: number }
  | { kind: 'key'; updatedAt: number; id: string }
export function parseCursor(value: string | undefined): number {
  if (!value) return 0
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0)
    throw ApiError.badRequest('Invalid cursor')
  return parsed
}
export function parseListCursor(value: string | undefined): ListCursor {
  if (!value) return { kind: 'offset', offset: 0 }
  if (!value.startsWith('k1.'))
    return { kind: 'offset', offset: parseCursor(value) }
  const separator = value.indexOf('.', 3)
  const encodedTime = separator >= 0 ? value.slice(3, separator) : ''
  const updatedAt = /^[0-9a-z]+$/.test(encodedTime)
    ? Number.parseInt(encodedTime, 36)
    : Number.NaN
  const id =
    separator >= 0 ? decodeURIComponentSafe(value.slice(separator + 1)) : ''
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || !isValidId(id))
    throw ApiError.badRequest('Invalid cursor')
  return { kind: 'key', updatedAt, id }
}
export function encodeListCursor(updatedAt: number, id: string): string {
  return `k1.${updatedAt.toString(36)}.${encodeURIComponent(id)}`
}
function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw ApiError.badRequest('Invalid cursor')
  }
}
