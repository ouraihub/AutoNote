import { parseStoredAvatarUrl } from '@shared/avatar'

const FILE_PATH = /^\/api\/files\/[0-9A-HJKMNP-TV-Z]{26}\/?$/i

export function addShareAccess(url: string, slug: string, origin: string): string {
  let parsed: URL
  try {
    parsed = new URL(url, origin)
  } catch {
    return url
  }
  if (parsed.origin !== origin) return url
  if (parseStoredAvatarUrl(parsed.pathname)) return `${parsed.pathname}${parsed.search}`
  if (!FILE_PATH.test(parsed.pathname))
    return /^\/(?:api(?:\/|$)|authorize(?:\/|$)|oauth(?:\/|$)|mcp(?:\/|$)|\.well-known(?:\/|$))/.test(parsed.pathname)
      ? 'data:,'
      : url
  parsed.searchParams.set('share', slug)
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}
