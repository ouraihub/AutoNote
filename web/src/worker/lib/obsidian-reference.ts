const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g
const WIKI_ASSET_RE = /!\[\[([^[\]#^|]{1,300}?)(?:\|([^\]\n]{0,100}))?\]\]/g
const ASSET_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|pdf)$/i

export function collectReferences(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const consider = (href: string) => {
    const normalized = normalizePath(href)
    if (normalized && !isManaged(href) && !seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }
  content.replace(MD_IMAGE_RE, (_full, _alt, href) => {
    consider(href)
    return _full
  })
  content.replace(WIKI_ASSET_RE, (full, target) => {
    if (ASSET_EXT_RE.test(target)) consider(target)
    return full
  })
  return out
}

export function rewriteReferences(
  content: string,
  resolve: (reference: string) => string | null,
): string {
  let next = content.replace(MD_IMAGE_RE, (full, alt, href) => {
    if (isManaged(href)) return full
    const url = resolve(normalizePath(href))
    return url ? `![${alt}](${url})` : full
  })
  next = next.replace(WIKI_ASSET_RE, (full, target, alias) => {
    if (!ASSET_EXT_RE.test(target)) return full
    const url = resolve(normalizePath(target))
    return url ? `![${alias?.trim() || displayName(target)}](${url})` : full
  })
  return next
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\/+/, '').trim()
}

export function isManaged(href: string): boolean {
  const clean = href.trim()
  return (
    /^(?:https?:|data:|file:|\/api\/)/i.test(clean) ||
    clean.startsWith('#') ||
    clean.startsWith('^')
  )
}


export function stripComments(content: string): string {
  return content.replace(
    /%%([\s\S]*?)%%/g,
    (_full, inner: string) => `<!--${inner.replace(/--/g, '—')}-->`,
  )
}
function displayName(path: string): string {
  return path.split('/').pop()?.replace(/\.[a-z0-9]+$/i, '') ?? path
}
