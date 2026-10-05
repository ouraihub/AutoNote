import type { Folder, NoteSummary, Tag } from '@shared/types'
import type { BackendSession } from '@shared/backend-types'
import type { KvStore } from './kv-store'

export interface ShellData {
  notes: NoteSummary[]
  folders: Folder[]
  tags: Tag[]
  cursor: number
}

export interface CachedNoteContent {
  content: string
  rev: number
  updatedAt: number
  writeId?: string
  pendingTitle?: string
  contentDirty?: boolean
}

export interface OutboxPayload {
  rev: number
  content: string
  contentDirty: boolean
  title?: string
  preserveVersion?: true
  recoveryId?: string
  readonly [key: string]: unknown
}

export interface OutboxItem {
  id: string
  clientId: string
  writeId: string
  dependsOnWriteId?: string
  noteId: string
  payload: OutboxPayload
  attempts: number
  createdAt: number
  lastError?: string
}

export interface LocalDbOptions {
  kv: KvStore
  userIdKey?: string
  sessionKey?: string
  timers?: LocalDbTimers
  onReadFailure?: (key: string, error: unknown) => void
  onMigrationFailure?: () => void
}

export interface LocalDbTimers {
  setTimeout(listener: () => void, delayMs: number): number
  clearTimeout(id: number): void
}

export interface LocalDb {
  bindUser(userId: string): Promise<void>
  activeUserId(): string | null
  loadSession(): Promise<BackendSession | null>
  saveSession(info: BackendSession): Promise<void>
  clearSession(): Promise<void>
  loadShell(): Promise<ShellData | null>
  saveShell(data: ShellData, userId?: string): Promise<void>
  scheduleShellSave(data: ShellData, userId?: string): void
  getContent(id: string): Promise<CachedNoteContent | undefined>
  setContent(id: string, value: CachedNoteContent, userId?: string): Promise<void>
  dropContent(id: string, userId?: string): Promise<void>
  getOutbox(): Promise<OutboxItem[]>
  enqueueOutbox(item: OutboxItem): Promise<void>
  completeOutboxItem(id: string, writeId: string): Promise<void>
  updateOutboxRevision(id: string, writeId: string, rev: number, preserveVersion?: boolean): Promise<void>
  setOutboxRecoveryId(id: string, writeId: string, recoveryId: string): Promise<void>
  advanceOutboxDependents(noteId: string, sourceWriteId: string, expectedRev: number, nextRev: number): Promise<void>
  markOutboxFailure(id: string, writeId: string, message: string): Promise<void>
  getAllOutbox(): Promise<OutboxItem[]>
  clear(): Promise<void>
}
