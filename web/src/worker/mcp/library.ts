import type { McpWriteContext } from './writes'

export {
  listMcpAttachments,
  readMcpAttachment,
  uploadMcpAttachment,
  deleteMcpAttachment,
  runMcpBackup,
  getMcpShare,
  createMcpShare,
  revokeMcpShare,
} from './library-storage'
export {
  bulkOrganizeMcpNotes,
  exploreMcpGraph,
  listMcpBackupRuns,
} from './library-graph'
export {
  duplicateMcpNote,
  listMcpNoteVersions,
  readMcpNoteVersion,
  restoreMcpNoteVersion,
  getMcpNoteProperties,
  updateMcpNoteProperties,
  queryMcpNoteProperties,
} from './library-notes'
export {
  createMcpFolder,
  updateMcpFolder,
  removeMcpFolderAndPromote,
  previewMcpFolderRemoval,
} from './library-folders'
export {
  createMcpTag,
  updateMcpTag,
  deleteMcpTag,
  previewMcpTagChange,
} from './library-tags'

export interface LibraryContext extends McpWriteContext {
  origin: string
}

export interface FolderRow {
  id: string
  parent_id: string | null
  name: string
  icon: string | null
  color: string | null
  position: number
  created_at: number
  updated_at: number
}

export interface ShareRow {
  slug: string
  note_id: string
  password_hash: string | null
  expires_at: number | null
  views: number
  created_at: number
}
