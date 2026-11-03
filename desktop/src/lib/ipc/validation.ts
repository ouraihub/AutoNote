import type { CommandArgs } from './commands'
import { invalidResponse } from './errors'
import {
  aiRoleBinding,
  attachment,
  bindPreview,
  folder,
  integer,
  ids,
  isSyncResponse,
  mcpKey,
  mcpPreferences,
  mcpStatus,
  nullableText,
  noteSummary,
  record,
  syncLogin,
  syncSession,
  syncStatus,
  tag,
  text,
  versionMeta,
} from './response-validators'
import {
  isBackendSession,
  isNote,
  isNoteWriteResult,
  isPublicUser,
} from '@shared/backend-types'

export { isSyncResponse, record }
export function validateResponse(
  command: keyof CommandArgs,
  value: unknown,
): void {
  let valid: boolean
  switch (command) {
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
      valid =
        record(value) &&
        text(value.loginId) &&
        record(value.result) &&
        syncLogin(value.result)
      break
    case 'sync_complete_totp':
      valid =
        record(value) &&
        text(value.loginId) &&
        record(value.result) &&
        syncSession(value.result) &&
        typeof value.result.recoveryCodeUsed === 'boolean' &&
        (value.result.recoveryCodesRemaining === null ||
          integer(value.result.recoveryCodesRemaining))
      break
    case 'sync_status':
    case 'sync_bind_confirm':
    case 'sync_unbind':
    case 'sync_start':
    case 'sync_stop':
    case 'sync_now':
      valid = syncStatus(value)
      break
    case 'sync_bind_preview':
      valid = bindPreview(value)
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
            record(item) &&
            text(item.id) &&
            ids.test(item.id) &&
            text(item.title) &&
            text(item.context),
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
      valid =
        record(value) &&
        (value.tag === null || tag(value.tag)) &&
        integer(value.renamed)
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
        value.files.every(
          (file: unknown) =>
            attachment(file) && record(file) && integer(file.references),
        ) &&
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
      valid =
        record(value) &&
        Array.isArray(value.nodes) &&
        Array.isArray(value.edges) &&
        record(value.meta)
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
      valid =
        record(value) && integer(value.removed) && integer(value.freedBytes)
      break
    case 'tags_remove':
      valid = record(value) && value.ok === true && integer(value.affected)
      break
    case 'app_log':
      valid =
        record(value) &&
        value.ok === true &&
        typeof value.available === 'boolean'
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
