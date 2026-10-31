import type {
  BackupMode,
  BackupTarget,
  BackupTargetConfig,
  BackupTargetInput,
  Folder,
  ShareInfo,
} from '@shared/types'
import { extractAttachmentIds } from '@shared/markdown-utils'
import type { DemoState } from './state'
import { newDemoId } from './state'

export function demoFolderSiblings(state: DemoState, parentId: string | null, excludeId?: string): Folder[] {
  return [...state.folders.values()]
    .filter((folder) => folder.parentId === parentId && folder.id !== excludeId)
    .sort((left, right) => left.position - right.position || left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}
export function availableDemoFolderName(siblings: Folder[], base: string): string {
  const names = new Set(siblings.map((folder) => folder.name.toLocaleLowerCase()))
  if (!names.has(base.toLocaleLowerCase())) return base
  let suffix = 2
  while (names.has(`${base} ${suffix}`.toLocaleLowerCase())) suffix++
  return `${base} ${suffix}`
}
export function demoFolderDepth(state: DemoState, id: string): number {
  let depth = 1
  let cursor = state.folders.get(id)?.parentId ?? null
  const visited = new Set([id])
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor)
    depth++
    cursor = state.folders.get(cursor)?.parentId ?? null
  }
  return depth
}
export function demoFolderHeight(state: DemoState, rootId: string): number {
  let height = 1
  const queue: Array<[string, number]> = [[rootId, 1]]
  const visited = new Set<string>()
  while (queue.length) {
    const item = queue.shift()
    if (!item) break
    const [id, depth] = item
    if (visited.has(id)) continue
    visited.add(id)
    height = Math.max(height, depth)
    for (const folder of state.folders.values())
      if (folder.parentId === id) queue.push([folder.id, depth + 1])
  }
  return height
}
export function promoteDemoFolderChildren(state: DemoState, root: Folder): void {
  const siblings = demoFolderSiblings(state, root.parentId)
  const children = demoFolderSiblings(state, root.id)
  const index = siblings.findIndex((folder) => folder.id === root.id)
  if (index < 0) return
  siblings.splice(index, 1, ...children)
  const now = Date.now()
  siblings.forEach((folder, orderIndex) => state.folders.set(folder.id, {
    ...folder,
    parentId: folder.parentId === root.id ? root.parentId : folder.parentId,
    position: (orderIndex + 1) * 1000,
    updatedAt: folder.parentId === root.id ? now : folder.updatedAt,
  }))
}
export function folderDescendants(state: DemoState, rootId: string): Set<string> {
  const ids = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const folder of state.folders.values()) {
      if (folder.parentId && ids.has(folder.parentId) && !ids.has(folder.id)) {
        ids.add(folder.id)
        changed = true
      }
    }
  }
  return ids
}
export function attachmentReferenceCounts(state: DemoState): Map<string, number> {
  const references = new Map<string, number>()
  for (const note of state.notes.values()) {
    for (const id of extractAttachmentIds(note.content)) {
      if (state.attachments.has(id)) references.set(id, (references.get(id) ?? 0) + 1)
    }
    for (const attachment of state.attachments.values()) {
      if (note.content.includes(attachment.meta.url))
        references.set(attachment.meta.id, (references.get(attachment.meta.id) ?? 0) + 1)
    }
  }
  return references
}
export function absoluteShare(info: ShareInfo, requestUrl: string): ShareInfo {
  return { ...info, url: `${new URL(requestUrl).origin}/s/${info.slug}` }
}
export function createBackupTarget(input: BackupTargetInput): BackupTarget {
  const now = Date.now()
  return {
    id: newDemoId(), type: input.type, name: input.name.trim(),
    enabled: input.enabled ?? true, config: demoBackupConfig(input),
    hasSecret: hasDemoBackupSecret(input.type, input.secret),
    lastRunAt: null, lastStatus: null, lastError: null,
    createdAt: now, updatedAt: now,
  }
}
export function demoBackupConfig(input: BackupTargetInput): BackupTargetConfig {
  const mode: BackupMode = input.config.mode === 'mirror' ? 'mirror' : 'archive'
  return input.type === 's3'
    ? { endpoint: input.config.endpoint ?? '', region: input.config.region ?? 'auto', bucket: input.config.bucket ?? '', prefix: input.config.prefix ?? '', pathStyle: input.config.pathStyle ?? true, mode }
    : { url: input.config.url ?? '', username: input.config.username ?? '', prefix: input.config.prefix ?? '', mode }
}
export function hasDemoBackupSecret(type: BackupTargetInput['type'], secret: BackupTargetInput['secret']): boolean {
  return type === 's3'
    ? Boolean(secret?.accessKeyId?.trim() && secret.secretAccessKey?.trim())
    : Boolean(secret?.password?.trim())
}
export function demoBackupTargetError(input: BackupTargetInput, requireSecret: boolean): string | null {
  if (input.type !== 's3' && input.type !== 'webdav') return 'type must be s3 or webdav'
  if (typeof input.name !== 'string' || !input.name.trim()) return 'Enter a name'
  if (input.name.trim().length > 120) return 'The name must not exceed 120 characters'
  if (!input.config || typeof input.config !== 'object' || Array.isArray(input.config)) return 'config must be an object'
  if (input.type === 's3') {
    if (typeof input.config.bucket !== 'string' || !input.config.bucket.trim()) return 'Enter a bucket name'
    if (requireSecret && !hasDemoBackupSecret('s3', input.secret)) return 'Enter an Access Key and Secret Key'
    return null
  }
  if (typeof input.config.url !== 'string' || !input.config.url.trim()) return 'Enter a WebDAV URL'
  if (typeof input.config.username !== 'string' || !input.config.username.trim()) return 'Enter a username'
  if (requireSecret && !hasDemoBackupSecret('webdav', input.secret)) return 'Enter a password'
  return null
}
