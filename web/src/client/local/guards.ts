import type { Folder, NoteSummary, Tag } from '@shared/types'
import type { BackendSession } from '@shared/backend-types'
import type { CachedNoteContent, OutboxItem, OutboxPayload, ShellData } from './types'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}
function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value)
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || finite(value)
}

export function isNoteSummary(value: unknown): value is NoteSummary {
  if (!record(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    typeof value.excerpt === 'string' &&
    nullableString(value.folderId) &&
    Array.isArray(value.tags) &&
    value.tags.every((tag) => typeof tag === 'string') &&
    typeof value.isPinned === 'boolean' &&
    typeof value.isStarred === 'boolean' &&
    typeof value.isArchived === 'boolean' &&
    finite(value.wordCount) &&
    finite(value.charCount) &&
    safeInteger(value.rev) &&
    value.rev >= 1 &&
    finite(value.position) &&
    finite(value.createdAt) &&
    finite(value.updatedAt) &&
    nullableNumber(value.deletedAt)
  )
}

export function isFolder(value: unknown): value is Folder {
  if (!record(value)) return false
  return (
    typeof value.id === 'string' &&
    nullableString(value.parentId) &&
    typeof value.name === 'string' &&
    (value.color === undefined || nullableString(value.color)) &&
    finite(value.position) &&
    finite(value.createdAt) &&
    finite(value.updatedAt) &&
    (value.noteCount === undefined || finite(value.noteCount))
  )
}

export function isTag(value: unknown): value is Tag {
  if (!record(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    nullableString(value.color) &&
    finite(value.count) &&
    finite(value.createdAt)
  )
}

export function isSessionInfo(value: unknown): value is BackendSession {
  if (!record(value) || !record(value.site)) return false
  if (value.user !== null && !isPublicUser(value.user)) return false
  if (value.settings !== null && !record(value.settings)) return false
  return (
    typeof value.site.name === 'string' &&
    typeof value.site.initialized === 'boolean' &&
    typeof value.site.registrationOpen === 'boolean' &&
    typeof value.site.r2Enabled === 'boolean' &&
    typeof value.site.kvEnabled === 'boolean' &&
    (value.site.attachmentStorage === null ||
      value.site.attachmentStorage === 'r2' ||
      value.site.attachmentStorage === 'kv' ||
      value.site.attachmentStorage === 'local') &&
    typeof value.site.realtimeEnabled === 'boolean' &&
    typeof value.site.version === 'string'
  )
}

function isPublicUser(value: unknown): boolean {
  if (!record(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.login === 'string' &&
    typeof value.name === 'string' &&
    typeof value.avatarUrl === 'string' &&
    (value.role === 'owner' || value.role === 'member') &&
    finite(value.createdAt) &&
    typeof value.username === 'string'
  )
}

export function isCachedNoteContent(value: unknown): value is CachedNoteContent {
  if (!record(value)) return false
  return (
    typeof value.content === 'string' &&
    safeInteger(value.rev) &&
    value.rev >= 1 &&
    finite(value.updatedAt) &&
    (value.writeId === undefined || typeof value.writeId === 'string') &&
    (value.pendingTitle === undefined || typeof value.pendingTitle === 'string') &&
    (value.contentDirty === undefined || typeof value.contentDirty === 'boolean')
  )
}

export function isOutboxPayload(value: unknown): value is OutboxPayload {
  if (!record(value)) return false
  return (
    safeInteger(value.rev) &&
    value.rev >= 1 &&
    typeof value.content === 'string' &&
    typeof value.contentDirty === 'boolean' &&
    (value.title === undefined || typeof value.title === 'string') &&
    (value.preserveVersion === undefined || value.preserveVersion === true) &&
    (value.recoveryId === undefined || typeof value.recoveryId === 'string')
  )
}

export function isOutboxItem(value: unknown): value is OutboxItem {
  if (!record(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.writeId === 'string' &&
    (value.dependsOnWriteId === undefined || typeof value.dependsOnWriteId === 'string') &&
    typeof value.noteId === 'string' &&
    isOutboxPayload(value.payload) &&
    safeInteger(value.attempts) &&
    value.attempts >= 0 &&
    finite(value.createdAt) &&
    (value.lastError === undefined || typeof value.lastError === 'string')
  )
}

export function isOutboxList(value: unknown): value is OutboxItem[] {
  return Array.isArray(value) && value.every(isOutboxItem)
}

export function isShellData(value: unknown): value is ShellData {
  if (!record(value)) return false
  return (
    Array.isArray(value.notes) &&
    value.notes.every(isNoteSummary) &&
    Array.isArray(value.folders) &&
    value.folders.every(isFolder) &&
    Array.isArray(value.tags) &&
    value.tags.every(isTag) &&
    safeInteger(value.cursor) &&
    value.cursor >= 0
  )
}
