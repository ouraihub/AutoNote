import { LIMITS } from '@shared/constants'
import type { AppLocale, Folder, NoteSummary, SortKey, SortOrder, ViewKind } from '@shared/types'

export const RECENT_NOTES_LIMIT = 60

export interface NoteListQuery {
  readonly view: ViewKind
  readonly folderId: string | null
  readonly tag: string | null
  readonly sort: SortKey
  readonly order: SortOrder
  readonly locale: AppLocale
}

export interface NavigationCounts {
  readonly all: number
  readonly starred: number
  readonly unfiled: number
  readonly archived: number
  readonly trash: number
}

export interface NavigationProjection {
  readonly counts: NavigationCounts
  readonly folderCounts: ReadonlyMap<string, number>
}

export interface FolderNode extends Folder {
  readonly children: readonly FolderNode[]
  readonly depth: number
  readonly directNotes: number
  readonly totalNotes: number
}

export function matchesView(
  note: NoteSummary,
  view: ViewKind,
  folderId: string | null,
  tag: string | null,
  folderScope?: ReadonlySet<string>,
): boolean {
  if (view === 'trash') return note.deletedAt !== null
  if (note.deletedAt !== null) return false
  if (view === 'archived') return note.isArchived
  if (note.isArchived) return false
  switch (view) {
    case 'starred':
      return note.isStarred
    case 'unfiled':
      return note.folderId === null
    case 'folder':
      return note.folderId !== null && (folderScope?.has(note.folderId) ?? note.folderId === folderId)
    case 'tag':
      return tag !== null && note.tags.includes(tag)
    case 'recent':
    case 'all':
      return true
  }
}

export function compareNotes(
  a: NoteSummary,
  b: NoteSummary,
  sort: SortKey,
  order: SortOrder,
  locale: AppLocale,
): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1
  const direction = order === 'asc' ? 1 : -1
  let result: number
  switch (sort) {
    case 'created':
      result = (a.createdAt - b.createdAt) * direction
      break
    case 'title':
      result = a.title.localeCompare(b.title, locale, { numeric: true, sensitivity: 'base' }) * direction
      break
    case 'updated':
      result = (a.updatedAt - b.updatedAt) * direction
      break
  }
  return result || a.id.localeCompare(b.id)
}

export function compareTrash(a: NoteSummary, b: NoteSummary): number {
  return (b.deletedAt ?? b.updatedAt) - (a.deletedAt ?? a.updatedAt) || a.id.localeCompare(b.id)
}

export function selectVisibleNotes(
  notes: Readonly<Record<string, NoteSummary>>,
  folders: readonly Folder[],
  query: NoteListQuery,
): NoteSummary[] {
  const folderScope =
    query.view === 'folder' && query.folderId !== null ? folderDescendantIds(folders, query.folderId) : undefined
  const list = Object.values(notes).filter((note) =>
    matchesView(note, query.view, query.folderId, query.tag, folderScope),
  )
  if (query.view === 'recent') {
    return list.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)).slice(0, RECENT_NOTES_LIMIT)
  }
  if (query.view === 'trash') return list.sort(compareTrash)
  return list.sort((a, b) => compareNotes(a, b, query.sort, query.order, query.locale))
}

export function selectNavigation(notes: Readonly<Record<string, NoteSummary>>): NavigationProjection {
  const counts = { all: 0, starred: 0, unfiled: 0, archived: 0, trash: 0 }
  const folderCounts = new Map<string, number>()
  for (const note of Object.values(notes)) {
    if (note.deletedAt !== null) {
      counts.trash++
      continue
    }
    if (note.isArchived) {
      counts.archived++
      continue
    }
    counts.all++
    if (note.isStarred) counts.starred++
    if (note.folderId === null) counts.unfiled++
    else folderCounts.set(note.folderId, (folderCounts.get(note.folderId) ?? 0) + 1)
  }
  return { counts, folderCounts }
}

export function folderDescendantIds(folders: readonly Folder[], rootId: string): Set<string> {
  const children = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parentId === null) continue
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder.id)
    children.set(folder.parentId, siblings)
  }
  const ids = new Set<string>()
  const pending = [rootId]
  for (let id = pending.pop(); id !== undefined; id = pending.pop()) {
    if (ids.has(id)) continue
    ids.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  return ids
}

export function folderPath(folders: readonly Folder[], folderId: string | null): Folder[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const path: Folder[] = []
  const visited = new Set<string>()
  for (let id = folderId; id !== null && !visited.has(id);) {
    visited.add(id)
    const folder = byId.get(id)
    if (!folder) break
    path.unshift(folder)
    id = folder.parentId
  }
  return path
}

export function buildFolderTree(folders: readonly Folder[], directCounts: ReadonlyMap<string, number>): FolderNode[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]))
  const byParent = new Map<string, Folder[]>()
  const compare = (a: Folder, b: Folder) =>
    a.position - b.position || a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  for (const folder of folders) {
    const key = folder.parentId ?? ''
    const siblings = byParent.get(key) ?? []
    siblings.push(folder)
    byParent.set(key, siblings)
  }
  for (const siblings of byParent.values()) siblings.sort(compare)

  const visited = new Set<string>()
  const build = (folder: Folder, depth: number, parentId: string | null): FolderNode | null => {
    if (visited.has(folder.id)) return null
    visited.add(folder.id)
    const children =
      depth + 1 < LIMITS.folderDepthMax
        ? (byParent.get(folder.id) ?? []).flatMap((child) => build(child, depth + 1, folder.id) ?? [])
        : []
    const directNotes = directCounts.get(folder.id) ?? 0
    const totalNotes = directNotes + children.reduce((sum, child) => sum + child.totalNotes, 0)
    return { ...folder, parentId, children, depth, directNotes, totalNotes }
  }
  const roots = folders
    .filter((folder) => folder.parentId === null || !byId.has(folder.parentId))
    .sort(compare)
    .flatMap((folder) => build(folder, 0, null) ?? [])
  for (const folder of [...folders].sort(compare)) {
    const node = build(folder, 0, null)
    if (node) roots.push(node)
  }
  return roots.sort(compare)
}
