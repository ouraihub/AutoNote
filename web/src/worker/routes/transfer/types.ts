import type { AttachmentObjectStorage } from '../../attachments/keys'
import type { ImportResult } from '@shared/types'
import type { ObsidianAssetIndex } from '../../lib/obsidian-import'
import type { PersistedAttachment } from '../../attachments/storage'

export interface ImportContext {
  conflict?: ImportConflict
  byId?: Map<string, ExistingNoteIndex | null>
  folderCache: Map<string, string>
  result: ImportResult
  ftsEnabled: boolean
  attachmentEntries?: Map<string, Uint8Array>
  assets?: ObsidianAssetIndex
}

export interface SelectedImportFile {
  file: File
  path: string
}

export interface ExistingNoteIndex {
  id: string
  title: string
  rev: number
  updated_at: number
}

export interface SourceFolder {
  id: string
  parentId: string | null
  name: string
  icon: string | null
  color: string | null
  position?: number
  createdAt?: number
  updatedAt?: number
}

export interface FolderImportMetadata {
  icon: string | null
  color: string | null
  position?: number
  createdAt?: number
  updatedAt?: number
}

export interface PreparedAttachmentCandidate {
  sourceId: string
  sourceNoteId: string | null
  filename: string
  reportedMime: string
  bytes: Uint8Array
  sha256: string
  createdAt: number
}

export interface CreatedImportedAttachment {
  sourceId: string
  sourceNoteId: string | null
  persisted: PersistedAttachment
}

export interface PreparedAttachmentImport {
  idMap: Map<string, string>
  created: CreatedImportedAttachment[]
}

export interface ExistingAttachmentRow {
  id: string
  user_id: string
  filename: string
  mime: string
  size: number
  sha256: string
  storage: AttachmentObjectStorage
}

export interface InsertInput {
  id?: string
  content: string
  title: string
  folderId: string | null
  isStarred?: boolean
  isPinned?: boolean
  isArchived?: boolean
  position?: number
  createdAt?: number
  updatedAt?: number
  deletedAt?: number
}

export type ImportConflict = 'skip' | 'newer' | 'duplicate'
