import { BackendError } from '@app/backend'
import type { Folder, NoteSummary, SyncDeletion, SyncResponse, Tag } from '@shared/types'

type NoteRecord = Readonly<Record<string, NoteSummary>>

export interface SyncShell {
  readonly notes: NoteRecord
  readonly folders: readonly Folder[]
  readonly tags: readonly Tag[]
  readonly cursor: number
}

export const EMPTY_SYNC_SHELL: SyncShell = { notes: {}, folders: [], tags: [], cursor: 0 }

export type LocalNoteState = { readonly kind: 'content'; readonly baseRev: number } | { readonly kind: 'pending' }

export type LocalNoteStates = ReadonlyMap<string, LocalNoteState>

export type NoteTombstones = ReadonlyMap<string, number | null>

export interface SyncMergeResult {
  readonly shell: SyncShell
  readonly tombstones: NoteTombstones
  readonly refetchIds: readonly string[]
  readonly removedIds: readonly string[]
}

export interface FullSyncPageRequest {
  readonly after: string
  readonly snapshot: number
}

export function mergeSync(
  shell: SyncShell,
  payload: SyncResponse,
  dirty: LocalNoteStates,
  tombstones: NoteTombstones,
): SyncMergeResult {
  if (payload.full && payload.hasMore) throw invalidResponse('A partial full sync page cannot be merged')
  if (!payload.full && payload.cursor < shell.cursor) return { shell, tombstones, refetchIds: [], removedIds: [] }

  const nextTombstones = advanceTombstones(tombstones, payload)
  const refetchIds = new Set<string>()
  const notes = payload.full
    ? replaceNotes(shell.notes, payload.notes, dirty, nextTombstones, refetchIds)
    : mergeNotes(shell.notes, payload, dirty, nextTombstones, refetchIds)
  const replaceFacets = payload.full || payload.facetsFull
  const folders = replaceFacets
    ? replaceList(shell.folders, payload.folders, folderEqual)
    : mergeList(shell.folders, payload.folders, payload.deletions, 'folder', folderEqual)
  const tags = replaceFacets
    ? replaceList(shell.tags, payload.tags, tagEqual)
    : mergeList(shell.tags, payload.tags, payload.deletions, 'tag', tagEqual)

  const unchanged =
    notes === shell.notes && folders === shell.folders && tags === shell.tags && payload.cursor === shell.cursor
  const removedIds = notes === shell.notes ? [] : Object.keys(shell.notes).filter((id) => !Object.hasOwn(notes, id))
  return {
    shell: unchanged ? shell : { notes, folders, tags, cursor: payload.cursor },
    tombstones: nextTombstones,
    refetchIds: [...refetchIds],
    removedIds,
  }
}

export function nextFullSyncPage(pages: readonly SyncResponse[]): FullSyncPageRequest | null {
  const { first, last, requestedKeys } = validateFullPages(pages)
  if (!last.hasMore) return null
  if (last.nextKey === null || requestedKeys.has(last.nextKey)) {
    throw invalidResponse('Full sync pagination is incomplete')
  }
  return { after: last.nextKey, snapshot: first.cursor }
}

export function consolidateFullSync(pages: readonly SyncResponse[], increments: readonly SyncResponse[]): SyncResponse {
  const { first, last } = validateFullPages(pages)
  if (last.hasMore) throw invalidResponse('Full sync pagination is incomplete')

  const notes = new Map<string, NoteSummary>()
  for (const page of pages) for (const note of page.notes) notes.set(note.id, note)
  let folders = new Map(first.folders.map((folder) => [folder.id, folder]))
  let tags = new Map(first.tags.map((tag) => [tag.id, tag]))
  let cursor = first.cursor
  let serverTime = last.serverTime
  let settingsChanged = pages.some((page) => page.settingsChanged)
  let profileChanged = pages.some((page) => page.profileChanged === true)
  let siteChanged = pages.some((page) => page.siteChanged === true)

  for (const update of increments) {
    if (update.full || update.cursor < cursor) throw invalidResponse('Full sync catch-up is out of order')
    settingsChanged ||= update.settingsChanged
    profileChanged ||= update.profileChanged === true
    siteChanged ||= update.siteChanged === true
    for (const note of update.notes) notes.set(note.id, note)
    if (update.facetsFull) {
      folders = new Map(update.folders.map((folder) => [folder.id, folder]))
      tags = new Map(update.tags.map((tag) => [tag.id, tag]))
    } else {
      for (const folder of update.folders) folders.set(folder.id, folder)
      for (const tag of update.tags) tags.set(tag.id, tag)
    }
    for (const deletion of update.deletions) {
      if (deletion.entity === 'note') notes.delete(deletion.id)
      else if (deletion.entity === 'folder') folders.delete(deletion.id)
      else tags.delete(deletion.id)
    }
    cursor = update.cursor
    serverTime = update.serverTime
  }

  return {
    cursor,
    full: true,
    hasMore: false,
    nextKey: null,
    facetsFull: true,
    settingsChanged,
    profileChanged,
    siteChanged,
    notes: [...notes.values()],
    folders: [...folders.values()],
    tags: [...tags.values()],
    deletions: [],
    serverTime,
  }
}

function validateFullPages(pages: readonly SyncResponse[]): {
  first: SyncResponse
  last: SyncResponse
  requestedKeys: ReadonlySet<string>
} {
  const first = pages[0]
  if (!first) throw invalidResponse('Full sync has no pages')
  const requestedKeys = new Set<string>()
  let last = first
  for (const [index, page] of pages.entries()) {
    if (!page.full || page.cursor !== first.cursor) throw invalidResponse('Full sync snapshot expired')
    last = page
    if (index === pages.length - 1) break
    if (!page.hasMore || page.nextKey === null || requestedKeys.has(page.nextKey)) {
      throw invalidResponse('Full sync pagination is incomplete')
    }
    requestedKeys.add(page.nextKey)
  }
  return { first, last, requestedKeys }
}

function advanceTombstones(tombstones: NoteTombstones, payload: SyncResponse): NoteTombstones {
  if (tombstones.size === 0) return tombstones
  const deleted = new Set(payload.deletions.filter((item) => item.entity === 'note').map((item) => item.id))
  const present = payload.full ? new Set(payload.notes.map((note) => note.id)) : null
  let next: Map<string, number | null> | null = null
  for (const [id, cursor] of tombstones) {
    if (cursor !== null && payload.cursor > cursor) {
      next ??= new Map(tombstones)
      next.delete(id)
    } else if (cursor === null && (deleted.has(id) || (present !== null && !present.has(id)))) {
      next ??= new Map(tombstones)
      next.set(id, payload.cursor)
    }
  }
  return next ?? tombstones
}

function replaceNotes(
  current: NoteRecord,
  incoming: readonly NoteSummary[],
  dirty: LocalNoteStates,
  tombstones: NoteTombstones,
  refetchIds: Set<string>,
): NoteRecord {
  const next: Record<string, NoteSummary> = {}
  for (const remote of incoming) {
    if (tombstones.has(remote.id)) continue
    const existing = ownNote(current, remote.id)
    const local = dirty.get(remote.id)
    const candidate = reconcileSummary(ownNote(next, remote.id) ?? existing, remote, local)
    next[remote.id] = existing && summaryEqual(existing, candidate) ? existing : candidate
    if (needsContent(existing, remote, local)) refetchIds.add(remote.id)
  }
  for (const [id, note] of Object.entries(current)) {
    if (dirty.has(id) && !tombstones.has(id) && !Object.hasOwn(next, id)) next[id] = note
  }
  const ids = Object.keys(next)
  const unchanged = ids.length === Object.keys(current).length && ids.every((id) => next[id] === current[id])
  return unchanged ? current : next
}

function mergeNotes(
  current: NoteRecord,
  payload: SyncResponse,
  dirty: LocalNoteStates,
  tombstones: NoteTombstones,
  refetchIds: Set<string>,
): NoteRecord {
  let next: Record<string, NoteSummary> | null = null
  for (const remote of payload.notes) {
    if (tombstones.has(remote.id)) continue
    const existing = ownNote(next ?? current, remote.id)
    const local = dirty.get(remote.id)
    const candidate = reconcileSummary(existing, remote, local)
    if (existing && summaryEqual(existing, candidate)) continue
    if (needsContent(existing, remote, local)) refetchIds.add(remote.id)
    next ??= { ...current }
    next[remote.id] = candidate
  }
  for (const deletion of payload.deletions) {
    if (deletion.entity !== 'note' || dirty.has(deletion.id) || !Object.hasOwn(next ?? current, deletion.id)) continue
    next ??= { ...current }
    delete next[deletion.id]
  }
  for (const id of tombstones.keys()) {
    if (!Object.hasOwn(next ?? current, id)) continue
    next ??= { ...current }
    delete next[id]
  }
  return next ?? current
}

function reconcileSummary(
  current: NoteSummary | undefined,
  incoming: NoteSummary,
  local: LocalNoteState | undefined,
): NoteSummary {
  if (current && current.rev > incoming.rev) return current
  if (!current || local?.kind !== 'content') return incoming
  return {
    ...incoming,
    title: current.title,
    excerpt: current.excerpt,
    tags: current.tags,
    wordCount: current.wordCount,
    charCount: current.charCount,
    rev: local.baseRev,
    updatedAt: current.updatedAt,
  }
}

function needsContent(
  current: NoteSummary | undefined,
  incoming: NoteSummary,
  local: LocalNoteState | undefined,
): boolean {
  return current !== undefined && incoming.rev > current.rev && local?.kind !== 'content'
}

function ownNote(notes: NoteRecord, id: string): NoteSummary | undefined {
  return Object.hasOwn(notes, id) ? notes[id] : undefined
}

function replaceList<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  equal: (a: T, b: T) => boolean,
): readonly T[] {
  const byId = new Map(current.map((item) => [item.id, item]))
  const next = incoming.map((item) => {
    const existing = byId.get(item.id)
    return existing && equal(existing, item) ? existing : item
  })
  return next.length === current.length && next.every((item, index) => item === current[index]) ? current : next
}

function mergeList<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
  deletions: readonly SyncDeletion[],
  entity: SyncDeletion['entity'],
  equal: (a: T, b: T) => boolean,
): readonly T[] {
  let next: Map<string, T> | null = null
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) {
    const existing = (next ?? byId).get(item.id)
    if (existing && equal(existing, item)) continue
    next ??= new Map(byId)
    next.set(item.id, item)
  }
  for (const deletion of deletions) {
    if (deletion.entity !== entity || !(next ?? byId).has(deletion.id)) continue
    next ??= new Map(byId)
    next.delete(deletion.id)
  }
  return next ? [...next.values()] : current
}

function summaryEqual(a: NoteSummary, b: NoteSummary): boolean {
  return (
    a.id === b.id &&
    a.title === b.title &&
    a.excerpt === b.excerpt &&
    a.folderId === b.folderId &&
    a.isPinned === b.isPinned &&
    a.isStarred === b.isStarred &&
    a.isArchived === b.isArchived &&
    a.wordCount === b.wordCount &&
    a.charCount === b.charCount &&
    a.rev === b.rev &&
    a.position === b.position &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.deletedAt === b.deletedAt &&
    a.tags.length === b.tags.length &&
    a.tags.every((tag, index) => tag === b.tags[index])
  )
}

function folderEqual(a: Folder, b: Folder): boolean {
  return (
    a.id === b.id &&
    a.parentId === b.parentId &&
    a.name === b.name &&
    a.icon === b.icon &&
    a.color === b.color &&
    a.position === b.position &&
    a.createdAt === b.createdAt &&
    a.updatedAt === b.updatedAt &&
    a.noteCount === b.noteCount
  )
}

function tagEqual(a: Tag, b: Tag): boolean {
  return a.id === b.id && a.name === b.name && a.color === b.color && a.count === b.count && a.createdAt === b.createdAt
}

function invalidResponse(message: string): BackendError {
  return new BackendError('invalid_response', 0, message)
}
