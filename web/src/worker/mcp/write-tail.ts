import { LIMITS } from '@shared/constants'
import { truncateText } from '@shared/text-utils'

export function resolveTitle(value: string): string {
  return truncateText(value.trim(), LIMITS.titleMaxLength)
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
export function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(
    /\?(\d+)/g,
    (_match, value: string) => `?${Number(value) + offset}`,
  )
}
export function lineOffsets(content: string): number[] {
  const offsets = [0]
  for (let index = 0; index < content.length; index++)
    if (content[index] === '\n') offsets.push(index + 1)
  return offsets
}
