import { truncateText } from '@shared/text-utils'

export function lineOffsets(content: string): number[] {
  const offsets = [0]
  for (let index = 0; index < content.length; index++)
    if (content[index] === '\n') offsets.push(index + 1)
  return offsets
}

export function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

export function escapeQuote(value: string): string {
  return truncateText(value.replace(/"/g, ''), 120)
}
