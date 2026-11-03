import { extractAttachmentIds } from '@shared/markdown-utils'
import type {
  Folder,
  McpSettingsInfo,
  Note,
  NoteVersion,
  ShareInfo,
  SessionInfo,
} from '@shared/types'
import { newDemoId, type DemoState } from './state'
import { APP_VERSION } from '../../release'

export function demoMcpSettings(now = Date.now()): McpSettingsInfo {
  return {
    enabled: true,
    canManageGlobal: true,
    endpoint: '/mcp',
    oauth: true,
    preferences: {
      writeEnabled: true,
      trashEnabled: false,
      updatedAt: now - 24 * 60 * 60 * 1000,
    },
    apiKeys: [
      {
        id: 'demo-api-key',
        name: 'Automation key',
        scopes: ['notes:read', 'notes:write'],
        createdAt: now - 14 * 24 * 60 * 60 * 1000,
        lastUsedAt: now - 18 * 60 * 1000,
      },
    ],
    aiSearch: {
      available: false,
      enabled: false,
      model: '@cf/baai/bge-m3',
      indexedCount: 0,
      pendingCount: 0,
      reason: 'no_ai_binding',
    },
    grants: [
      {
        id: 'demo-grant',
        clientId: 'demo-desktop-client',
        clientName: 'Desktop MCP client',
        clientUri: 'https://example.com',
        scopes: ['notes:read', 'notes:write'],
        createdAt: now - 7 * 24 * 60 * 60 * 1000,
        expiresAt: null,
      },
    ],
    privacy: {
      publicEndpoint: false,
      perUserIndex: true,
      externalClientReceivesSelectedContent: true,
    },
  }
}

export function siteInfo(state: DemoState) {
  return {
    name: 'AutoNote Demo',
    initialized: true,
    registrationOpen: state.registrationOpen,
    r2Enabled: true,
    kvEnabled: false,
    attachmentStorage: 'r2',
    realtimeEnabled: false,
    version: APP_VERSION,
  } as const
}

export function sessionInfo(state: DemoState): SessionInfo {
  return {
    user: state.authenticated ? state.user : null,
    site: siteInfo(state),
    settings: state.authenticated ? state.settings : null,
  }
}

export async function jsonBody(
  request: Request,
): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.includes('application/json'))
    return {}
  const value: unknown = await request.json()
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SyntaxError('Invalid JSON object')
  return value as Record<string, unknown>
}

export function saveVersion(state: DemoState, note: Note): void {
  const version: NoteVersion = {
    id: newDemoId(),
    noteId: note.id,
    title: note.title,
    size: new TextEncoder().encode(note.content).byteLength,
    createdAt: Date.now(),
    content: note.content,
  }
  state.versions.set(
    note.id,
    [version, ...(state.versions.get(note.id) ?? [])].slice(0, 50),
  )
}

export function findVersion(
  state: DemoState,
  noteId: string,
  versionId: string,
): NoteVersion | null {
  return (
    state.versions.get(noteId)?.find((version) => version.id === versionId) ??
    null
  )
}

export function purgeNote(state: DemoState, id: string): void {
  state.notes.delete(id)
  state.versions.delete(id)
  state.shares.delete(id)
  state.cursor++
}

export function demoFolderSiblings(
  state: DemoState,
  parentId: string | null,
  excludeId?: string,
): Folder[] {
  return [...state.folders.values()]
    .filter((folder) => folder.parentId === parentId && folder.id !== excludeId)
    .sort(
      (left, right) =>
        left.position - right.position ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id),
    )
}

export function availableDemoFolderName(
  siblings: Folder[],
  base: string,
): string {
  const names = new Set(
    siblings.map((folder) => folder.name.toLocaleLowerCase()),
  )
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
    for (const folder of state.folders.values()) {
      if (folder.parentId === id) queue.push([folder.id, depth + 1])
    }
  }
  return height
}

export function promoteDemoFolderChildren(
  state: DemoState,
  root: Folder,
): void {
  const siblings = demoFolderSiblings(state, root.parentId)
  const children = demoFolderSiblings(state, root.id)
  const index = siblings.findIndex((folder) => folder.id === root.id)
  if (index < 0) return
  siblings.splice(index, 1, ...children)
  const now = Date.now()
  siblings.forEach((folder, orderIndex) => {
    state.folders.set(folder.id, {
      ...folder,
      parentId: folder.parentId === root.id ? root.parentId : folder.parentId,
      position: (orderIndex + 1) * 1000,
      updatedAt: folder.parentId === root.id ? now : folder.updatedAt,
    })
  })
}

export function folderDescendants(
  state: DemoState,
  rootId: string,
): Set<string> {
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

export function attachmentReferenceCounts(
  state: DemoState,
): Map<string, number> {
  const references = new Map<string, number>()
  for (const note of state.notes.values()) {
    for (const id of extractAttachmentIds(note.content)) {
      if (!state.attachments.has(id)) continue
      references.set(id, (references.get(id) ?? 0) + 1)
    }
    for (const attachment of state.attachments.values()) {
      if (!note.content.includes(attachment.meta.url)) continue
      references.set(
        attachment.meta.id,
        (references.get(attachment.meta.id) ?? 0) + 1,
      )
    }
  }
  return references
}

export function absoluteShare(info: ShareInfo, requestUrl: string): ShareInfo {
  return { ...info, url: `${new URL(requestUrl).origin}/s/${info.slug}` }
}
