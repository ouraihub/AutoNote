export {
  collectReferences as collectObsidianReferences,
  normalizePath as normalizeObsidianPath,
  rewriteReferences as rewriteObsidianReferences,
  stripComments as stripObsidianComments,
} from './obsidian-reference'
import { normalizePath } from './obsidian-reference'

export interface ObsidianAsset {
  path: string
  name: string
  bytes: Uint8Array
}

export interface ObsidianAssetIndex {
  byPath: Map<string, ObsidianAsset>
  byName: Map<string, ObsidianAsset>
}

export function buildObsidianAssetIndex(
  entries: readonly { path: string; data: Uint8Array }[],
): ObsidianAssetIndex {
  const byPath = new Map<string, ObsidianAsset>()
  const byName = new Map<string, ObsidianAsset>()
  for (const entry of entries) {
    const path = normalizePath(entry.path)
    const name = path.split('/').pop() ?? path
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
  const normalized = normalizePath(reference)
  if (!normalized) return null
  const direct = index.byPath.get(normalized.toLowerCase())
  if (direct) return direct
  if (dir) {
    const relative = index.byPath.get(
      normalizePath(`${dir}/${normalized}`).toLowerCase(),
    )
    if (relative) return relative
  }
  return index.byName.get(normalized.split('/').pop()!.toLowerCase()) ?? null
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
