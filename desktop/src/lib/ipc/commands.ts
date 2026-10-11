import type {
  Attachment,
  Backlink,
  CreateNoteBody,
  Folder,
  GraphQuery,
  GraphResponse,
  ImportResult,
  ListNotesQuery,
  ListNotesResponse,
  Note,
  NoteVersion,
  NoteVersionMeta,
  PatchNoteBody,
  SearchResponse,
  SyncResponse,
  Tag,
  UserSettings,
} from '@shared/types'
import type {
  AttachmentPage,
  BackendSession,
  FlushResult,
  FolderCreate,
  FolderPatch,
  NoteWriteResult,
  SettingsPatch,
  TagCreate,
  TagPatch,
  TagPatchResult,
} from '@shared/backend-types'
import type {
  BindPreview,
  BindStrategy,
  ConflictChoice,
  SyncLoginReply,
  SyncStatus,
  SyncTotpReply,
} from './ports/remote-sync'
import type { AppInfo, LogEntry } from '../host/desktop-types'
import type { McpApiKey, McpPreferences } from '@shared/types'
import type { McpLocalStatus } from '@shared/backend-types'
import type {
  AiConversation,
  AiConversationSummary,
  AiModelRef,
  AiProbeResult,
  AiProvider,
  AiProviderSave,
  AiRole,
  AiRoleBinding,
  AiWriteRequest,
} from './ports/ai'

export interface DesktopPrefs {
  closeToTray: boolean
  globalShortcutEnabled: boolean
  globalShortcut: string
}
export interface DesktopStatus extends DesktopPrefs {
  trayAvailable: boolean
  logAvailable: boolean
}
export interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  fields: Record<string, string | number | boolean | null>
}
type Empty = undefined
export interface CommandArgs {
  mcp_status: Empty
  ai_providers_list: Empty
  ai_provider_save: { provider: AiProviderSave }
  ai_provider_delete: { id: string }
  ai_endpoint_key_reveal: { id: string }
  ai_endpoint_probe: { id: string; jobId: string }
  ai_roles_get: Empty
  ai_roles_set: { role: AiRole; binding: AiModelRef | null }
  ai_conversations_list: Empty
  ai_conversation_get: { id: string }
  ai_conversation_delete: { id: string }
  ai_write: { jobId: string; request: AiWriteRequest; onEvent: unknown }
  mcp_start: Empty
  mcp_stop: Empty
  mcp_set_port: { port: number }
  mcp_list_keys: Empty
  mcp_create_key: { name: string }
  mcp_revoke_key: { id: string }
  mcp_get_preferences: Empty
  mcp_save_preferences: { patch: Partial<Pick<McpPreferences, 'writeEnabled' | 'trashEnabled'>> }
  sync_login: { origin: string; username: string; password: string }
  sync_complete_totp: { loginId: string; challengeToken: string; code: string }
  sync_status: Empty
  sync_bind_preview: { loginId: string; strategy: BindStrategy }
  sync_bind_confirm: { previewId: string }
  sync_unbind: { bindingId: string; epoch: number }
  sync_start: Empty
  sync_stop: Empty
  sync_now: Empty
  sync_resolve_conflict: { conflictId: string; choice: ConflictChoice; bindingId: string; epoch: number }
  sync_export_quarantined: { bindingId: string; epoch: number }
  sync_discard_quarantined: { bindingId: string; epoch: number }
  session_load: Empty
  session_logout: Empty
  notes_snapshot: Empty
  library_changes: { since: number }
  notes_list: { query: ListNotesQuery }
  notes_get: { id: string }
  notes_create: { body: CreateNoteBody }
  notes_patch: { id: string; body: PatchNoteBody; writeId: string }
  notes_remove: { id: string }
  notes_restore: { id: string }
  notes_purge: { id: string }
  notes_duplicate: { id: string; body?: { id?: string } }
  notes_empty_trash: Empty
  notes_versions: { id: string }
  notes_version: { id: string; versionId: string }
  notes_restore_version: { id: string; versionId: string; rev: number }
  notes_backlinks: { id: string }
  notes_flush: { noteId?: string }
  folders_list: Empty
  folders_create: { body: FolderCreate }
  folders_patch: { id: string; body: FolderPatch }
  folders_remove: { id: string; strategy: 'move-up' | 'delete' }
  tags_list: Empty
  tags_create: { body: TagCreate }
  tags_patch: { id: string; body: TagPatch }
  tags_remove: { id: string }
  search_query: { query: { q: string; limit?: number } }
  search_graph: { query: GraphQuery }
  jobs_cancel: { jobId: string }
  files_list: { cursor?: string }
  files_upload_begin: { filename: string; mime: string; size: number; noteId?: string }
  files_upload_finish: { uploadId: string }
  files_upload_cancel: { uploadId: string }
  files_remove: { id: string }
  files_prune: Empty
  settings_get: Empty
  settings_save: { patch: SettingsPatch }
  settings_stats: Empty
  app_info: Empty
  app_logs_tail: { limit: number }
  app_log: { entries: readonly LogRecord[]; droppedCount: number }
  app_open_log_dir: Empty
  desktop_prefs_get: Empty
  desktop_prefs_save: { prefs: DesktopPrefs }
  desktop_close_ack: { requestId: number; pending: number; failed: number }
  transfer_cancel: { jobId: string }
}
export interface CommandResults {
  mcp_status: McpLocalStatus
  ai_providers_list: AiProvider[]
  ai_provider_save: AiProvider[]
  ai_provider_delete: { ok: true }
  ai_endpoint_key_reveal: { key: string }
  ai_endpoint_probe: AiProbeResult
  ai_roles_get: AiRoleBinding[]
  ai_roles_set: AiRoleBinding[]
  ai_conversations_list: AiConversationSummary[]
  ai_conversation_get: AiConversation
  ai_conversation_delete: { ok: true }
  ai_write: { ok: true; model: AiModelRef; isFallback: boolean }
  mcp_start: McpLocalStatus
  mcp_stop: McpLocalStatus
  mcp_set_port: McpLocalStatus
  mcp_list_keys: McpApiKey[]
  mcp_create_key: { key: McpApiKey; token: string }
  mcp_revoke_key: { ok: true }
  mcp_get_preferences: McpPreferences
  mcp_save_preferences: McpPreferences
  sync_login: SyncLoginReply
  sync_complete_totp: SyncTotpReply
  sync_status: SyncStatus
  sync_bind_preview: BindPreview
  sync_bind_confirm: SyncStatus
  sync_unbind: SyncStatus
  sync_start: SyncStatus
  sync_stop: SyncStatus
  sync_now: SyncStatus
  sync_resolve_conflict: SyncStatus
  sync_export_quarantined: unknown
  sync_discard_quarantined: SyncStatus
  session_load: BackendSession
  session_logout: void
  notes_snapshot: SyncResponse
  library_changes: SyncResponse
  notes_list: ListNotesResponse
  notes_get: Note
  notes_create: Note
  notes_patch: NoteWriteResult
  notes_remove: Note
  notes_restore: Note
  notes_purge: { ok: true; cursor: number }
  notes_duplicate: Note
  notes_empty_trash: { purged: number }
  notes_versions: NoteVersionMeta[]
  notes_version: NoteVersion
  notes_restore_version: Note
  notes_backlinks: Backlink[]
  notes_flush: FlushResult
  folders_list: Folder[]
  folders_create: Folder
  folders_patch: Folder
  folders_remove: { ok: true }
  tags_list: Tag[]
  tags_create: Tag
  tags_patch: TagPatchResult
  tags_remove: { ok: true; affected: number }
  search_query: SearchResponse
  search_graph: GraphResponse
  jobs_cancel: boolean
  files_list: AttachmentPage
  files_upload_begin: { uploadId: string; chunkMaxBytes: number }
  files_upload_finish: Attachment
  files_upload_cancel: { ok: true }
  files_remove: { ok: true }
  files_prune: { removed: number; freedBytes: number }
  settings_get: UserSettings
  settings_save: UserSettings
  settings_stats: Record<string, number>
  app_info: AppInfo
  app_logs_tail: LogEntry[]
  app_log: { ok: true; available: boolean; accepted: number; rejected: number }
  app_open_log_dir: { ok: true }
  desktop_prefs_get: DesktopStatus
  desktop_prefs_save: DesktopStatus
  desktop_close_ack: { ok: true }
  transfer_cancel: { accepted: boolean }
}
export type TransferArgs =
  { format: 'zip' | 'json' } | { source: 'files' | 'folder'; conflict: 'skip' | 'newer' | 'duplicate' }
export type TransferValue = { saved: true } | ImportResult
