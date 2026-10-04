import { BackendError } from '@app/backend'
import type { BackendSession } from '@shared/backend-types'
import { browserTimers, type Timers } from '../platform'
import { isCachedNoteContent, isOutboxList, isSessionInfo, isShellData } from './guards'
import type { KvStore } from './kv-store'
import type { CachedNoteContent, LocalDb, LocalDbOptions, OutboxItem, ShellData } from './types'

const KEY = {
  userId: 'userId',
  session: 'session',
  notes: 'notes',
  folders: 'folders',
  tags: 'tags',
  cursor: 'cursor',
  outbox: 'outbox',
  lease: 'outboxReplayLease',
  content: (id: string) => `note:${id}`,
} as const

const LEGACY_KEYS = new Set<string>([KEY.notes, KEY.folders, KEY.tags, KEY.cursor, KEY.outbox, KEY.lease])

const defaultTimers: Timers = browserTimers

function isLegacyKey(key: string): boolean {
  return LEGACY_KEYS.has(key) || key.startsWith('note:')
}

function localError(): BackendError {
  return new BackendError('internal', 0, 'Local persistence failed')
}

function copyItem(item: OutboxItem): OutboxItem {
  return { ...item, payload: { ...item.payload } }
}
function mergeOutboxValues(scoped: unknown, legacy: unknown): unknown {
  if (!isOutboxList(scoped) || !isOutboxList(legacy)) return scoped
  const merged = [...scoped]
  for (const oldItem of legacy) {
    if (!merged.some((item) => item.id === oldItem.id)) merged.push(oldItem)
  }
  return merged
}

function advanceItem(item: OutboxItem, rev: number, preserveVersion: boolean): OutboxItem {
  const next: OutboxItem = {
    ...item,
    payload: { ...item.payload, rev, ...(preserveVersion ? { preserveVersion: true } : {}) },
  }
  delete next.dependsOnWriteId
  return next
}

export class LocalDbImpl implements LocalDb {
  readonly #kv: KvStore
  readonly #userIdKey: string
  readonly #sessionKey: string
  readonly #timers: LocalDbOptions['timers']
  readonly #onReadFailure: (key: string, error: unknown) => void
  #activeUser: string | null = null
  #shellTimer: number | null = null
  #pendingShell: { data: ShellData; userId: string } | null = null

  constructor(options: LocalDbOptions) {
    this.#kv = options.kv
    this.#userIdKey = options.userIdKey ?? KEY.userId
    this.#sessionKey = options.sessionKey ?? KEY.session
    this.#timers = options.timers ?? defaultTimers
    this.#onReadFailure = options.onReadFailure ?? (() => undefined)
  }

  activeUserId(): string | null {
    return this.#activeUser
  }

  async bindUser(userId: string): Promise<void> {
    if (!userId) throw localError()
    if (this.#activeUser === userId) {
      await this.#kv.set(this.#userIdKey, userId).catch(() => {
        throw localError()
      })
      return
    }
    try {
      const storedUser = await this.#kv.get<string>(this.#userIdKey)
      if (storedUser === userId) await this.#migrateLegacy(userId)
      this.#activeUser = userId
      await this.#kv.set(this.#userIdKey, userId)
    } catch {
      throw localError()
    }
  }

  async loadSession(): Promise<BackendSession | null> {
    try {
      const value = await this.#kv.get(this.#sessionKey)
      if (!isSessionInfo(value) || value.user === null) return null
      const storedUser = await this.#kv.get<string>(this.#userIdKey)
      if (storedUser !== value.user.id) return null
      await this.bindUser(value.user.id)
      return value
    } catch (error) {
      this.#onReadFailure(this.#sessionKey, error)
      return null
    }
  }

  async saveSession(info: BackendSession): Promise<void> {
    if (info.user === null) return
    try {
      await this.bindUser(info.user.id)
      await this.#kv.set(this.#sessionKey, info)
    } catch {
      throw localError()
    }
  }

  async clearSession(): Promise<void> {
    try {
      await this.#kv.del(this.#sessionKey)
    } catch {
      throw localError()
    }
  }

  async loadShell(): Promise<ShellData | null> {
    const userId = this.#requireUser()
    const keys = this.#shellKeys(userId)
    try {
      const [notes, folders, tags, cursor] = await this.#kv.getMany(keys)
      const value = { notes, folders, tags, cursor }
      if (!isShellData(value)) return null
      return value
    } catch (error) {
      this.#onReadFailure(keys.join(','), error)
      return null
    }
  }

  async saveShell(data: ShellData, userId = this.#requireUser()): Promise<void> {
    if (!isShellData(data)) throw localError()
    try {
      await this.#kv.setMany([
        [this.#scoped(KEY.notes, userId), data.notes],
        [this.#scoped(KEY.folders, userId), data.folders],
        [this.#scoped(KEY.tags, userId), data.tags],
        [this.#scoped(KEY.cursor, userId), data.cursor],
      ])
    } catch {
      throw localError()
    }
  }

  scheduleShellSave(data: ShellData, userId = this.#requireUser()): void {
    if (this.#shellTimer !== null) this.#timers?.clearTimeout(this.#shellTimer)
    this.#pendingShell = { data, userId }
    this.#shellTimer =
      this.#timers?.setTimeout(() => {
        const pending = this.#pendingShell
        this.#pendingShell = null
        this.#shellTimer = null
        if (pending) void this.saveShell(pending.data, pending.userId).catch(() => undefined)
      }, 80) ?? null
  }

  async getContent(id: string): Promise<CachedNoteContent | undefined> {
    const key = this.#scoped(KEY.content(id), this.#requireUser())
    try {
      const value = await this.#kv.get(key)
      if (!isCachedNoteContent(value)) return undefined
      return value
    } catch (error) {
      this.#onReadFailure(key, error)
      return undefined
    }
  }

  async setContent(id: string, value: CachedNoteContent, userId = this.#requireUser()): Promise<void> {
    if (!isCachedNoteContent(value)) throw localError()
    try {
      await this.#kv.set(this.#scoped(KEY.content(id), userId), value)
    } catch {
      throw localError()
    }
  }

  async dropContent(id: string, userId = this.#requireUser()): Promise<void> {
    try {
      await this.#kv.del(this.#scoped(KEY.content(id), userId))
    } catch {
      throw localError()
    }
  }

  async getOutbox(): Promise<OutboxItem[]> {
    const key = this.#scoped(KEY.outbox, this.#requireUser())
    try {
      const value = await this.#kv.get(key)
      if (value === undefined) return []
      if (!isOutboxList(value)) throw new BackendError('internal', 0, 'Local outbox is invalid')
      return value.map(copyItem)
    } catch (error) {
      this.#onReadFailure(key, error)
      throw error instanceof BackendError ? error : localError()
    }
  }
  async getAllOutbox(): Promise<OutboxItem[]> {
    try {
      const entries = await this.#kv.entries()
      const outboxEntries = entries.filter(([key]) => key.startsWith('user:') && key.endsWith(`:${KEY.outbox}`))
      const values = outboxEntries.map(([, value]) => value)
      const all: OutboxItem[] = []
      for (const value of values) {
        if (!isOutboxList(value)) throw new BackendError('internal', 0, 'Local outbox is invalid')
        all.push(...value.map(copyItem))
      }
      return all
    } catch (error) {
      throw error instanceof BackendError ? error : localError()
    }
  }

  async enqueueOutbox(item: OutboxItem): Promise<void> {
    if (!isOutboxList([item])) throw localError()
    await this.#updateOutbox((items) => {
      const previous = items.find((entry) => entry.id === item.id)
      return [
        ...items.filter((entry) => entry.id !== item.id),
        { ...copyItem(item), createdAt: previous?.createdAt ?? item.createdAt },
      ]
    })
  }

  async completeOutboxItem(id: string, writeId: string): Promise<void> {
    await this.#updateOutbox((items) => items.filter((item) => item.id !== id || item.writeId !== writeId))
  }

  async updateOutboxRevision(id: string, writeId: string, rev: number, preserveVersion = false): Promise<void> {
    if (!Number.isSafeInteger(rev) || rev < 1) throw localError()
    await this.#updateOutbox((items) =>
      items.map((item) =>
        item.id === id && item.writeId === writeId ? advanceItem(item, rev, preserveVersion) : item,
      ),
    )
  }

  async setOutboxRecoveryId(id: string, writeId: string, recoveryId: string): Promise<void> {
    await this.#updateOutbox((items) =>
      items.map((item) =>
        item.id === id && item.writeId === writeId ? { ...item, payload: { ...item.payload, recoveryId } } : item,
      ),
    )
  }

  async advanceOutboxDependents(
    noteId: string,
    sourceWriteId: string,
    expectedRev: number,
    nextRev: number,
  ): Promise<void> {
    await this.#updateOutbox((items) =>
      items.map((item) => {
        if (item.noteId !== noteId || item.dependsOnWriteId !== sourceWriteId || item.payload.rev !== expectedRev)
          return item
        return advanceItem(item, nextRev, false)
      }),
    )
  }

  async markOutboxFailure(id: string, writeId: string, message: string): Promise<void> {
    await this.#updateOutbox((items) =>
      items.map((item) =>
        item.id === id && item.writeId === writeId
          ? { ...item, attempts: item.attempts + 1, lastError: message }
          : item,
      ),
    )
  }

  async clear(): Promise<void> {
    if (this.#shellTimer !== null) this.#timers?.clearTimeout(this.#shellTimer)
    this.#shellTimer = null
    this.#pendingShell = null
    try {
      await this.#kv.clear()
      this.#activeUser = null
    } catch {
      throw localError()
    }
  }

  async #updateOutbox(updater: (items: OutboxItem[]) => OutboxItem[]): Promise<void> {
    const key = this.#scoped(KEY.outbox, this.#requireUser())
    try {
      await this.#kv.update<unknown>(key, (current) => {
        if (current === undefined) return updater([])
        if (!isOutboxList(current)) throw new BackendError('internal', 0, 'Local outbox is invalid')
        return updater(current)
      })
    } catch (error) {
      throw error instanceof BackendError ? error : localError()
    }
  }

  async #migrateLegacy(userId: string): Promise<void> {
    const entries = await this.#kv.entries()
    const legacy = entries.filter(([key]) => isLegacyKey(key))
    if (legacy.length === 0) return
    const scopedKeys = legacy.map(([key]) => this.#scoped(key, userId))
    const existing = await this.#kv.getMany(scopedKeys)
    for (let index = 0; index < legacy.length; index += 1) {
      const [legacyKey, legacyValue] = legacy[index]!
      const targetValue = existing[index]
      if (targetValue !== undefined) {
        if (legacyKey === KEY.outbox) {
          const merged = mergeOutboxValues(targetValue, legacyValue)
          if (merged !== targetValue) {
            await this.#kv.set(scopedKeys[index]!, merged)
            await this.#kv.del(legacyKey)
          }
        } else {
          await this.#kv.del(legacyKey)
        }
        continue
      }
      await this.#kv.set(scopedKeys[index]!, legacyValue)
      await this.#kv.del(legacyKey)
    }
  }

  #requireUser(): string {
    if (this.#activeUser === null) throw new BackendError('internal', 0, 'No local user is bound')
    return this.#activeUser
  }

  #scoped(key: string, userId: string): string {
    return `user:${userId}:${key}`
  }

  #shellKeys(userId: string): string[] {
    return [KEY.notes, KEY.folders, KEY.tags, KEY.cursor].map((key) => this.#scoped(key, userId))
  }
}

export function createLocalDb(options: LocalDbOptions): LocalDb {
  return new LocalDbImpl(options)
}
