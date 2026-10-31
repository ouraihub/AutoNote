import { hasExpectedImageSignature } from './image-signatures'
export { readImageSize } from './image-dimensions'
export { hasExpectedImageSignature } from './image-signatures'

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/zip': 'zip',
  'application/json': 'json',
}

export function hasReasonableImageDimensions(
  dimensions: { width: number; height: number } | null,
): boolean {
  if (!dimensions) return true
  const { width, height } = dimensions
  return (
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= 65_535 &&
    height <= 65_535 &&
    width * height <= 100_000_000
  )
}

export function extensionFor(mime: string, filename: string): string {
  const fromName = /\.([A-Za-z0-9]{1,8})$/.exec(filename)?.[1]
  return (fromName || EXT_BY_MIME[mime] || 'bin').toLowerCase()
}

export const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/octet-stream',
])

export function safeAttachmentMime(
  bytes: Uint8Array,
  reportedMime: string,
): string {
  const normalized =
    reportedMime.trim().toLowerCase().split(';', 1)[0] ||
    'application/octet-stream'
  if (!ALLOWED_MIME.has(normalized)) return 'application/octet-stream'
  if (
    isInlineSafe(normalized) &&
    !hasExpectedImageSignature(bytes, normalized)
  ) {
    return 'application/octet-stream'
  }
  return normalized
}

export function isInlineSafe(mime: string): boolean {
  return mime.startsWith('image/') && mime !== 'image/svg+xml'
}
