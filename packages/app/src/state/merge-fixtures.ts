import type { Folder, NoteSummary, SyncResponse, Tag } from '@shared/types'
import {
  EMPTY_SYNC_SHELL,
  type LocalNoteStates,
  type NoteTombstones,
  type SyncShell,
} from './merge'

export const NO_DIRTY: LocalNoteStates = new Map()
export const NO_TOMBSTONES: NoteTombstones = new Map()

export function note(
  id: string,
  overrides: Partial<NoteSummary> = {},
): NoteSummary {
  return {
    id,
    title: `Title ${id}`,
    excerpt: '',
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 0,
    charCount: 0,
    rev: 1,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  }
}

export function folder(id: string, overrides: Partial<Folder> = {}): Folder {
  return {
    id,
    parentId: null,
    name: id,
    icon: null,
    color: null,
    position: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

export function tag(id: string, overrides: Partial<Tag> = {}): Tag {
  return { id, name: id, color: null, count: 0, createdAt: 1, ...overrides }
}

export function payload(
  overrides: Partial<SyncResponse> = {},
): SyncResponse {
  return {
    cursor: 1,
    full: false,
    hasMore: false,
    nextKey: null,
    facetsFull: false,
    settingsChanged: false,
    profileChanged: false,
    siteChanged: false,
    notes: [],
    folders: [],
    tags: [],
    deletions: [],
    serverTime: 1,
    ...overrides,
  }
}

export function shellOf(
  notes: NoteSummary[],
  extra: Partial<SyncShell> = {},
): SyncShell {
  return {
    ...EMPTY_SYNC_SHELL,
    notes: Object.fromEntries(notes.map((item) => [item.id, item])),
    ...extra,
  }
}
