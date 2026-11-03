import type { Folder, Note, NoteSummary } from './types-1'
export interface Tag {
  id: string
  name: string
  color: string | null
  count: number
  createdAt: number
}

export interface NoteVersionMeta {
  id: string
  noteId: string
  title: string
  size: number
  createdAt: number
}

export interface NoteVersion extends NoteVersionMeta {
  content: string
}

export interface Backlink {
  id: string
  title: string
  context: string
}

export interface Attachment {
  id: string
  noteId: string | null
  filename: string
  mime: string
  size: number
  width: number | null
  height: number | null
  url: string
  createdAt: number
}

export interface AttachmentWithUsage extends Attachment {
  references: number
}

export type ViewKind =
  | 'all'
  | 'recent'
  | 'starred'
  | 'unfiled'
  | 'archived'
  | 'trash'
  | 'folder'
  | 'tag'

export type SortKey = 'updated' | 'created' | 'title'
export type SortOrder = 'asc' | 'desc'

export interface ListNotesQuery {
  view?: ViewKind
  folderId?: string
  tag?: string
  sort?: SortKey
  order?: SortOrder
  limit?: number
  cursor?: string
}

export interface ListNotesResponse {
  notes: NoteSummary[]
  nextCursor: string | null
  total: number
}

export interface CreateNoteBody {
  id?: string
  title?: string
  content?: string
  folderId?: string | null
  isStarred?: boolean
}

export interface PatchNoteBody {
  rev: number
  title?: string
  content?: string
  folderId?: string | null
  isPinned?: boolean
  isStarred?: boolean
  isArchived?: boolean

  quiet?: boolean
  preserveVersion?: boolean
}

export interface ConflictPayload {
  code: 'conflict'
  message: string
  server: Note
}

export type SearchMode = 'fts' | 'like'

export interface SearchHit {
  note: NoteSummary
  snippet: string
  score: number
}

export interface SearchResponse {
  results: SearchHit[]
  mode: SearchMode
  took: number
  query: {
    text: string
    tags: string[]
    folder: string | null
    starred: boolean | null
    archived: boolean | null
  }
}

export interface GraphNode {
  id: string
  title: string
  kind: 'note' | 'unresolved'
  degree: number
  inDegree: number
  outDegree: number
  folderId: string | null
  folderName: string | null
  folderColor: string | null
  tags: Array<{ name: string; color: string | null }>
}

export interface GraphEdge {
  source: string
  target: string
}

export interface GraphResponse {
  nodes: GraphNode[]
  edges: GraphEdge[]
  meta: {
    mode: 'global' | 'local'
    centerId: string | null
    depth: number
    totalNodes: number
    totalEdges: number
    truncated: boolean
    limit: number
  }
}

export interface GraphQuery {
  mode?: 'global' | 'local'
  center?: string
  depth?: number
  q?: string
  folderId?: string
  tag?: string
  includeOrphans?: boolean
  includeUnresolved?: boolean
  limit?: number
}

export interface SyncDeletion {
  entity: 'note' | 'folder' | 'tag'
  id: string
}

export interface SyncResponse {
  cursor: number
  full: boolean

  hasMore: boolean

  nextKey: string | null

  facetsFull: boolean

  settingsChanged: boolean
  profileChanged?: boolean
  siteChanged?: boolean
  notes: NoteSummary[]
  folders: Folder[]
  tags: Tag[]
  deletions: SyncDeletion[]
  serverTime: number
}

export type RealtimeMessage =
  | { type: 'changed'; cursor: number; origin: string | null }
  | { type: 'ping' }
  | { type: 'pong'; serverTime: number }
