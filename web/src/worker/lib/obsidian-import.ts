export interface ObsidianAsset {
  path: string
  name: string
  bytes: Uint8Array
}

export interface ObsidianAssetIndex {
  byPath: Map<string, ObsidianAsset>
  byName: Map<string, ObsidianAsset>
}

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g
const WIKI_ASSET_RE = /!\[\[([^[\]#^|]{1,300}?)(?:\|([^\]\n]{0,100}))?\]\]/g
const ASSET_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|pdf)$/i

export function buildObsidianAssetIndex(
  entries: readonly { path: string; data: Uint8Array }[],
): ObsidianAssetIndex {
  const byPath = new Map<string, ObsidianAsset>()
  const byName = new Map<string, ObsidianAsset>()
  for (const entry of entries) {
    const path = normalizeObsidianPath(entry.path)
    const name = pathBasename(path)
    const asset: ObsidianAsset = { path, name, bytes: entry.data }
    if (!byPath.has(path.toLowerCase())) byPath.set(path.toLowerCase(), asset)
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), asset)
  }
  return { byPath, byName }
}

export function findObsidianAsset(
  index: ObsidianAssetIndex,
  reference: string,
  dir: string,
): ObsidianAsset | null {
  const normalized = normalizeObsidianPath(reference)
  if (!normalized) return null
  const direct = index.byPath.get(normalized.toLowerCase())
  if (direct) return direct
  if (dir) {
    const relative = index.byPath.get(normalizeObsidianPath(`${dir}/${normalized}`).toLowerCase())
    if (relative) return relative
  }
  return index.byName.get(pathBasename(normalized).toLowerCase()) ?? null
}

export function collectObsidianReferences(content: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const consider = (href: string) => {
    const normalized = normalizeObsidianPath(href)
    if (normalized && !isManagedReference(href) && !seen.has(normalized)) {
      seen.add(normalized)
      out.push(normalized)
    }
  }
  content.replace(MD_IMAGE_RE, (_full, _alt, href) => {
    consider(href)
    return _full
  })
  content.replace(WIKI_ASSET_RE, (full, target, _alias) => {
    if (ASSET_EXT_RE.test(target)) consider(target)
    return full
  })
  return out
}

export function rewriteObsidianReferences(
  content: string,
  resolve: (reference: string) => string | null,
): string {
  let next = content.replace(MD_IMAGE_RE, (full, alt, href) => {
    if (isManagedReference(href)) return full
    const url = resolve(normalizeObsidianPath(href))
    return url ? `![${alt}](${url})` : full
  })
  next = next.replace(WIKI_ASSET_RE, (full, target, alias) => {
    if (!ASSET_EXT_RE.test(target)) return full
    const url = resolve(normalizeObsidianPath(target))
    return url ? `![${alias?.trim() || assetDisplayName(target)}](${url})` : full
  })
  return next
}

export function stripObsidianComments(content: string): string {
  return content.replace(/%%([\s\S]*?)%%/g, (_full, inner: string) => `<!--${inner.replace(/--/g, '—')}-->`)
}

export function normalizeObsidianPath(value: string): string {
  return value
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .trim()
}

export function mimeForAttachmentName(name: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? ''
  const byExt: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
  }
  return byExt[ext] ?? 'application/octet-stream'
}

function isManagedReference(href: string): boolean {
  const clean = href.trim()
  return /^(?:https?:|data:|file:|\/api\/)/i.test(clean) || clean.startsWith('#') || clean.startsWith('^')
}

function pathBasename(path: string): string {
  return path.split('/').pop() ?? path
}

function assetDisplayName(path: string): string {
  return pathBasename(path).replace(/\.[a-z0-9]+$/i, '')
}
