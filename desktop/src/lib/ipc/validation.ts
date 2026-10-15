import { isBackendSession, isNote, isNoteWriteResult, isPublicUser, NoteSchema } from '@shared/backend-types'
import type { SyncResponse } from '@shared/types'
import type { CommandArgs } from './commands'
import { invalidResponse } from './errors'

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const ids = /^[0-9a-hjkmnp-tv-z]{26}$/
const text = (value: unknown): value is string => typeof value === 'string'
const nullableText = (value: unknown): value is string | null => value === null || text(value)
const noteSummarySchema = NoteSchema.omit({ content: true })
const noteSummary = (value: unknown): boolean => noteSummarySchema.safeParse(value).success
const folder = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  ids.test(value.id) &&
  nullableText(value.parentId) &&
  (value.parentId === null || ids.test(value.parentId)) &&
  text(value.name) &&
  nullableText(value.icon) &&
  nullableText(value.color) &&
  typeof value.position === 'number' &&
  Number.isFinite(value.position) &&
  integer(value.createdAt) &&
  integer(value.updatedAt) &&
  (value.noteCount === undefined || integer(value.noteCount))
const tag = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  ids.test(value.id) &&
  text(value.name) &&
  nullableText(value.color) &&
  integer(value.count) &&
  integer(value.createdAt)
const attachment = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  ids.test(value.id) &&
  nullableText(value.noteId) &&
  (value.noteId === null || ids.test(value.noteId)) &&
  text(value.filename) &&
  text(value.mime) &&
  integer(value.size) &&
  (value.width === null || integer(value.width)) &&
  (value.height === null || integer(value.height)) &&
  text(value.url) &&
  integer(value.createdAt)
const versionMeta = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  ids.test(value.id) &&
  text(value.noteId) &&
  ids.test(value.noteId) &&
  text(value.title) &&
  integer(value.size) &&
  integer(value.createdAt)
const syncUser = (value: unknown): boolean => record(value) && text(value.id) && text(value.username)
const syncSession = (value: unknown): boolean =>
  record(value) &&
  (value.user === null || syncUser(value.user)) &&
  record(value.site) &&
  text(value.site.name) &&
  typeof value.site.initialized === 'boolean' &&
  typeof value.site.registrationOpen === 'boolean' &&
  typeof value.site.r2Enabled === 'boolean' &&
  typeof value.site.kvEnabled === 'boolean' &&
  (value.site.attachmentStorage === null ||
    value.site.attachmentStorage === 'r2' ||
    value.site.attachmentStorage === 'kv') &&
  typeof value.site.realtimeEnabled === 'boolean' &&
  text(value.site.version) &&
  (value.settings === null || record(value.settings))
const syncLogin = (value: unknown): boolean =>
  syncSession(value) ||
  (record(value) &&
    value.twoFactorRequired === true &&
    text(value.challengeToken) &&
    value.challengeToken.length > 0 &&
    integer(value.expiresAt))
const syncStatus = (value: unknown): boolean =>
  record(value) &&
  nullableText(value.bindingId) &&
  (value.epoch === null || integer(value.epoch)) &&
  text(value.phase) &&
  integer(value.localCursor) &&
  integer(value.remoteCursor) &&
  integer(value.pending) &&
  integer(value.blocked) &&
  integer(value.conflicts) &&
  typeof value.online === 'boolean' &&
  nullableText(value.errorCode) &&
  typeof value.terminal === 'boolean' &&
  nullableText(value.siteOrigin) &&
  nullableText(value.accountHint) &&
  typeof value.metadataRisk === 'boolean' &&
  Array.isArray(value.conflictItems) &&
  value.conflictItems.every(
    (item: unknown) =>
      record(item) &&
      text(item.id) &&
      text(item.bindingId) &&
      integer(item.epoch) &&
      text(item.entity) &&
      text(item.reason),
  ) &&
  Array.isArray(value.quarantined) &&
  value.quarantined.every(
    (item: unknown) =>
      record(item) &&
      text(item.bindingId) &&
      integer(item.epoch) &&
      text(item.siteOrigin) &&
      text(item.accountHint) &&
      integer(item.pending),
  )
const bindPreview = (value: unknown): boolean =>
  record(value) &&
  text(value.previewId) &&
  record(value.counts) &&
  integer(value.counts.local) &&
  integer(value.counts.remote) &&
  integer(value.counts.matched) &&
  integer(value.counts.conflicts) &&
  integer(value.counts.attachments) &&
  integer(value.counts.networkWrites) &&
  integer(value.expiresAt)
export function isSyncResponse(value: unknown): value is SyncResponse {
  return (
    record(value) &&
    integer(value.cursor) &&
    typeof value.full === 'boolean' &&
    typeof value.hasMore === 'boolean' &&
    (value.nextKey === null || typeof value.nextKey === 'string') &&
    typeof value.facetsFull === 'boolean' &&
    typeof value.settingsChanged === 'boolean' &&
    integer(value.serverTime) &&
    Array.isArray(value.notes) &&
    value.notes.every(noteSummary) &&
    Array.isArray(value.folders) &&
    value.folders.every(folder) &&
    Array.isArray(value.tags) &&
    value.tags.every(tag) &&
    Array.isArray(value.deletions) &&
    value.deletions.every(
      (item: unknown) =>
        record(item) &&
        typeof item.id === 'string' &&
        ids.test(item.id) &&
        ['note', 'folder', 'tag'].includes(String(item.entity)),
    )
  )
}
const mcpStatus = (value: unknown): boolean =>
  record(value) &&
  typeof value.running === 'boolean' &&
  nullableText(value.endpoint) &&
  integer(value.port) &&
  nullableText(value.error)
const mcpKey = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  text(value.name) &&
  Array.isArray(value.scopes) &&
  value.scopes.every(text) &&
  integer(value.createdAt) &&
  (value.lastUsedAt === null || integer(value.lastUsedAt))
const mcpPreferences = (value: unknown): boolean =>
  record(value) &&
  typeof value.writeEnabled === 'boolean' &&
  typeof value.trashEnabled === 'boolean' &&
  integer(value.updatedAt)
const aiRoleBinding = (value: unknown): boolean =>
  record(value) &&
  (value.role === 'chat' || value.role === 'writing' || value.role === 'painting') &&
  typeof value.isFallback === 'boolean' &&
  (value.binding === null ||
    (record(value.binding) &&
      text(value.binding.endpointId) &&
      text(value.binding.modelId) &&
      text(value.binding.label)))
export function validateResponse(command: keyof CommandArgs, value: unknown): void {
  let valid: boolean
  switch (command) {
    case 'ai_endpoint_key_reveal':
      valid = record(value) && text(value.key)
      break
    case 'ai_roles_get':
    case 'ai_roles_set':
      valid = Array.isArray(value) && value.every(aiRoleBinding)
      break
    case 'ai_reply_export':
      valid = record(value) && typeof value.saved === 'boolean'
      break
    case 'mcp_status':
    case 'mcp_start':
    case 'mcp_stop':
    case 'mcp_set_port':
      valid = mcpStatus(value)
      break
    case 'mcp_list_keys':
      valid = Array.isArray(value) && value.every(mcpKey)
      break
    case 'mcp_create_key':
      valid = record(value) && mcpKey(value.key) && text(value.token)
      break
    case 'mcp_revoke_key':
      valid = record(value) && value.ok === true
      break
    case 'mcp_get_preferences':
    case 'mcp_save_preferences':
      valid = mcpPreferences(value)
      break
    case 'session_load':
      valid = isBackendSession(value)
      break
    case 'session_update_profile':
      valid = isPublicUser(value)
      break
    case 'sync_login':
      valid = record(value) && text(value.loginId) && record(value.result) && syncLogin(value.result)
      break
    case 'sync_complete_totp':
      valid =
        record(value) &&
        text(value.loginId) &&
        record(value.result) &&
        syncSession(value.result) &&
        typeof value.result.recoveryCodeUsed === 'boolean' &&
        (value.result.recoveryCodesRemaining === null || integer(value.result.recoveryCodesRemaining))
      break
    case 'sync_status':
    case 'sync_bind_confirm':
    case 'sync_unbind':
    case 'sync_start':
    case 'sync_stop':
    case 'sync_now':
    case 'sync_resolve_conflict':
    case 'sync_discard_quarantined':
      valid = syncStatus(value)
      break
    case 'sync_bind_preview':
      valid = bindPreview(value)
      break
    case 'sync_export_quarantined':
      valid = record(value)
      break
    case 'notes_snapshot':
    case 'library_changes':
      valid = isSyncResponse(value)
      break
    case 'notes_get':
    case 'notes_create':
    case 'notes_remove':
    case 'notes_restore':
    case 'notes_duplicate':
    case 'notes_restore_version':
      valid = isNote(value)
      break
    case 'notes_patch':
      valid = isNoteWriteResult(value) && !value.queued
      break
    case 'session_logout':
      valid = value === null || value === undefined
      break
    case 'jobs_cancel':
      valid = typeof value === 'boolean'
      break
    case 'folders_list':
      valid = Array.isArray(value) && value.every(folder)
      break
    case 'tags_list':
      valid = Array.isArray(value) && value.every(tag)
      break
    case 'notes_versions':
      valid = Array.isArray(value) && value.every(versionMeta)
      break
    case 'notes_version':
      valid = versionMeta(value) && record(value) && text(value.content)
      break
    case 'notes_backlinks':
      valid =
        Array.isArray(value) &&
        value.every(
          (item: unknown) =>
            record(item) && text(item.id) && ids.test(item.id) && text(item.title) && text(item.context),
        )
      break
    case 'app_logs_tail':
      valid =
        Array.isArray(value) &&
        value.every(
          (item: unknown) =>
            record(item) &&
            integer(item.seq) &&
            text(item.time) &&
            text(item.level) &&
            text(item.target) &&
            text(item.message),
        )
      break
    case 'folders_create':
    case 'folders_patch':
      valid = folder(value)
      break
    case 'tags_create':
      valid = tag(value)
      break
    case 'tags_patch':
      valid = record(value) && (value.tag === null || tag(value.tag)) && integer(value.renamed)
      break
    case 'files_upload_finish':
      valid = attachment(value)
      break
    case 'notes_flush':
      valid = record(value) && integer(value.pending) && integer(value.failed)
      break
    case 'notes_list':
      valid =
        record(value) &&
        Array.isArray(value.notes) &&
        value.notes.every(noteSummary) &&
        integer(value.total) &&
        nullableText(value.nextCursor)
      break
    case 'files_list':
      valid =
        record(value) &&
        Array.isArray(value.files) &&
        value.files.every((file: unknown) => attachment(file) && record(file) && integer(file.references)) &&
        nullableText(value.nextCursor)
      break
    case 'files_upload_begin':
      valid =
        record(value) &&
        typeof value.uploadId === 'string' &&
        integer(value.chunkMaxBytes) &&
        value.chunkMaxBytes > 0 &&
        value.chunkMaxBytes <= 256 * 1024
      break
    case 'search_query':
      valid = record(value) && Array.isArray(value.results)
      break
    case 'search_graph':
      valid = record(value) && Array.isArray(value.nodes) && Array.isArray(value.edges) && record(value.meta)
      break
    case 'settings_get':
    case 'settings_save':
      valid =
        record(value) &&
        record(value.appearance) &&
        record(value.editor) &&
        record(value.preview) &&
        record(value.sync) &&
        record(value.backup)
      break
    case 'app_info':
      valid =
        record(value) &&
        typeof value.version === 'string' &&
        typeof value.dataDir === 'string' &&
        integer(value.schemaVersion)
      break
    case 'desktop_prefs_get':
    case 'desktop_prefs_save':
      valid =
        record(value) &&
        typeof value.closeToTray === 'boolean' &&
        typeof value.globalShortcutEnabled === 'boolean' &&
        typeof value.globalShortcut === 'string' &&
        typeof value.trayAvailable === 'boolean' &&
        typeof value.logAvailable === 'boolean'
      break
    case 'transfer_cancel':
      valid = record(value) && typeof value.accepted === 'boolean'
      break
    case 'notes_purge':
      valid = record(value) && value.ok === true && integer(value.cursor)
      break
    case 'notes_empty_trash':
      valid = record(value) && integer(value.purged)
      break
    case 'files_prune':
      valid = record(value) && integer(value.removed) && integer(value.freedBytes)
      break
    case 'tags_remove':
      valid = record(value) && value.ok === true && integer(value.affected)
      break
    case 'app_log':
      valid = record(value) && value.ok === true && typeof value.available === 'boolean'
      break
    case 'files_remove':
    case 'files_upload_cancel':
    case 'folders_remove':
    case 'desktop_close_ack':
    case 'app_open_log_dir':
      valid = record(value) && value.ok === true
      break
    default:
      valid = record(value)
      break
  }
  if (!valid) throw invalidResponse()
}
