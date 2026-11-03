import { NoteSchema } from '@shared/backend-types'
import type { SyncResponse } from '@shared/types'

export const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const ids = /^[0-9a-hjkmnp-tv-z]{26}$/
const text = (value: unknown): value is string => typeof value === 'string'
const nullableText = (value: unknown): value is string | null =>
  value === null || text(value)
export { integer, ids, text, nullableText }
const noteSummarySchema = NoteSchema.omit({ content: true })
export const noteSummary = (value: unknown): boolean =>
  noteSummarySchema.safeParse(value).success
export const folder = (value: unknown): boolean =>
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
export const tag = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  ids.test(value.id) &&
  text(value.name) &&
  nullableText(value.color) &&
  integer(value.count) &&
  integer(value.createdAt)
export const attachment = (value: unknown): boolean =>
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
export const versionMeta = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  ids.test(value.id) &&
  text(value.noteId) &&
  ids.test(value.noteId) &&
  text(value.title) &&
  integer(value.size) &&
  integer(value.createdAt)
const syncUser = (value: unknown): boolean =>
  record(value) && text(value.id) && text(value.username)
export const syncSession = (value: unknown): boolean =>
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
export const syncLogin = (value: unknown): boolean =>
  syncSession(value) ||
  (record(value) &&
    value.twoFactorRequired === true &&
    text(value.challengeToken) &&
    value.challengeToken.length > 0 &&
    integer(value.expiresAt))
const SYNC_PHASES: Record<string, true> = {
  unbound: true,
  idle: true,
  syncing: true,
  paused: true,
}
export const syncStatus = (value: unknown): boolean =>
  record(value) &&
  typeof value.phase === 'string' &&
  SYNC_PHASES[value.phase] === true &&
  nullableText(value.siteOrigin) &&
  nullableText(value.account) &&
  integer(value.cursor) &&
  integer(value.pending) &&
  (value.lastSuccessAt === null || integer(value.lastSuccessAt)) &&
  nullableText(value.errorCode)
export const bindPreview = (value: unknown): boolean =>
  record(value) &&
  text(value.previewId) &&
  integer(value.localOnly) &&
  integer(value.remoteOnly) &&
  integer(value.same) &&
  integer(value.different) &&
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
export const mcpStatus = (value: unknown): boolean =>
  record(value) &&
  typeof value.running === 'boolean' &&
  nullableText(value.endpoint) &&
  integer(value.port) &&
  nullableText(value.error)
export const mcpKey = (value: unknown): boolean =>
  record(value) &&
  text(value.id) &&
  text(value.name) &&
  Array.isArray(value.scopes) &&
  value.scopes.every(text) &&
  integer(value.createdAt) &&
  (value.lastUsedAt === null || integer(value.lastUsedAt))
export const mcpPreferences = (value: unknown): boolean =>
  record(value) &&
  typeof value.writeEnabled === 'boolean' &&
  typeof value.trashEnabled === 'boolean' &&
  integer(value.updatedAt)
export const aiRoleBinding = (value: unknown): boolean =>
  record(value) &&
  (value.role === 'chat' ||
    value.role === 'writing' ||
    value.role === 'painting') &&
  typeof value.isFallback === 'boolean' &&
  (value.binding === null ||
    (record(value.binding) &&
      text(value.binding.endpointId) &&
      text(value.binding.modelId) &&
      text(value.binding.label)))
