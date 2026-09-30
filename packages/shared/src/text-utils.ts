export function sliceText(value: string, start = 0, end = value.length): string {
  let from = clampIndex(start, value.length)
  let to = clampIndex(end, value.length)
  if (to < from) to = from

  if (from > 0 && isLowSurrogate(value.charCodeAt(from)) && isHighSurrogate(value.charCodeAt(from - 1))) {
    from++
  }
  if (to > from && to < value.length && isLowSurrogate(value.charCodeAt(to)) && isHighSurrogate(value.charCodeAt(to - 1))) {
    to--
  }
  return value.slice(from, to)
}

export function truncateText(value: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength <= 0) return ''
  const limit = Math.min(value.length, Math.floor(maxLength))
  return sliceText(value, 0, limit)
}

export function duplicateNoteTitle(
  title: string,
  maxLength: number,
  fallback = 'Untitled note',
  suffix = ' copy',
): string {
  const normalizedSuffix = truncateText(suffix, maxLength)
  const base = title.trim() || fallback
  return truncateText(base, Math.max(0, maxLength - normalizedSuffix.length)) + normalizedSuffix
}

const utf8Encoder = new TextEncoder()

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value)) return value === Infinity ? length : 0
  return Math.min(length, Math.max(0, Math.trunc(value)))
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}
