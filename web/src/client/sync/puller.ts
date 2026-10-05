import { BackendError } from '@app/backend/errors'
import type { CallOptions, ChangeEvent } from '@app/backend'
import { consolidateFullSync, EMPTY_SYNC_SHELL, mergeSync, nextFullSyncPage } from '@app/state/merge'
import type { SyncShell } from '@app/state/merge'
import type { SyncResponse } from '@shared/types'
import type { LocalDb, ShellData } from '../local'
import { isShellData } from '../local'
import type { HttpTransport } from '../backend/transport'
import type { Logger } from '@app/log/logger'
import type { Clock } from '@app/platform/clock'

export interface SyncPullerDeps {
  readonly transport: Pick<HttpTransport, 'json'>
  readonly localDb: LocalDb
  readonly emitChange: (event: ChangeEvent) => void
  readonly logger?: Logger
  readonly clock?: Clock
}

function invalidResponse(): BackendError {
  return new BackendError('invalid_response', 502, 'Invalid sync response')
}

function validatePage(value: SyncResponse): SyncResponse {
  if (
    !value ||
    !isShellData(value) ||
    typeof value.full !== 'boolean' ||
    typeof value.hasMore !== 'boolean' ||
    !(value.nextKey === null || typeof value.nextKey === 'string') ||
    typeof value.facetsFull !== 'boolean' ||
    typeof value.settingsChanged !== 'boolean' ||
    !Number.isFinite(value.serverTime) ||
    (value.profileChanged !== undefined && typeof value.profileChanged !== 'boolean') ||
    (value.siteChanged !== undefined && typeof value.siteChanged !== 'boolean') ||
    !Array.isArray(value.deletions) ||
    !value.deletions.every(
      (item) =>
        item &&
        typeof item.id === 'string' &&
        (item.entity === 'note' || item.entity === 'folder' || item.entity === 'tag'),
    )
  )
    throw invalidResponse()
  return value
}

export function shellSnapshot(shell: ShellData): SyncResponse {
  return {
    ...shell,
    full: true,
    hasMore: false,
    nextKey: null,
    facetsFull: true,
    settingsChanged: false,
    profileChanged: false,
    siteChanged: false,
    deletions: [],
    serverTime: Date.now(),
  }
}

export class SyncPuller {
  readonly #deps: SyncPullerDeps
  #running: Promise<SyncResponse> | null = null
  #forceQueued = false
  #user: string | null = null
  #shell: SyncShell = EMPTY_SYNC_SHELL
  #controller: AbortController | null = null
  #disposed = false
  #pages = 0

  constructor(deps: SyncPullerDeps) {
    this.#deps = deps
  }

  async snapshot(options?: CallOptions): Promise<SyncResponse> {
    if (this.#disposed) throw new BackendError('cancelled', 0, 'Sync is disposed')
    const user = this.#deps.localDb.activeUserId()
    const cached = await this.#deps.localDb.loadShell()
    if (this.#disposed || options?.signal?.aborted || this.#deps.localDb.activeUserId() !== user)
      throw new BackendError('cancelled', 0, 'Sync cancelled')
    if (cached) return shellSnapshot(cached)
    return this.pull(true, options)
  }

  pull(force = false, options?: CallOptions): Promise<SyncResponse> {
    if (this.#disposed || options?.signal?.aborted)
      return Promise.reject(new BackendError('cancelled', 0, 'Sync cancelled'))
    if (this.#running) {
      this.#forceQueued ||= force
      return this.#running
    }
    const controller = new AbortController()
    this.#controller = controller
    this.#forceQueued = false
    const abort = () => controller.abort()
    options?.signal?.addEventListener('abort', abort, { once: true })
    this.#running = this.#run(force, controller.signal).finally(() => {
      options?.signal?.removeEventListener('abort', abort)
      this.#running = null
      this.#controller = null
    })
    return this.#running
  }

  dispose(): void {
    this.#disposed = true
    this.#controller?.abort()
  }

  async #run(force: boolean, signal: AbortSignal): Promise<SyncResponse> {
    const user = this.#deps.localDb.activeUserId()
    const startedAt = this.#deps.clock?.now() ?? Date.now()
    this.#pages = 0
    if (!user) throw new BackendError('unauthenticated', 401, 'No active user')
    const assertCurrent = () => {
      if (signal.aborted || this.#deps.localDb.activeUserId() !== user)
        throw new BackendError('cancelled', 0, 'Sync superseded')
    }
    if (this.#user !== user) {
      const cached = await this.#deps.localDb.loadShell()
      assertCurrent()
      this.#shell = cached
        ? { ...cached, notes: Object.fromEntries(cached.notes.map((note) => [note.id, note])) }
        : EMPTY_SYNC_SHELL
      this.#user = user
    }
    let result: SyncResponse
    do {
      result = await this.#collect(force ? 0 : this.#shell.cursor, signal)
      assertCurrent()
      const next = mergeSync(this.#shell, result, new Map(), new Map()).shell
      const checkpoint = {
        notes: Object.values(next.notes),
        folders: [...next.folders],
        tags: [...next.tags],
        cursor: next.cursor,
      }
      await this.#deps.localDb.saveShell(checkpoint, user)
      assertCurrent()
      this.#shell = next
      this.#deps.emitChange({ kind: 'sync', payload: result })
      force = this.#forceQueued
      this.#forceQueued = false
    } while (force)
    this.#deps.logger?.info('sync.pull.completed', {
      full: result.full,
      pages: this.#pages,
      cursor: result.cursor,
      count: result.notes.length,
      durationMs: (this.#deps.clock?.now() ?? Date.now()) - startedAt,
    })
    return result
  }

  async #page(since: number, signal: AbortSignal, after?: string, snapshot?: number): Promise<SyncResponse> {
    if (signal.aborted || this.#deps.localDb.activeUserId() !== this.#user)
      throw new BackendError('cancelled', 0, 'Sync superseded')
    this.#pages++
    return validatePage(
      await this.#deps.transport.json<SyncResponse>({
        path: '/api/sync',
        query: { since, after, snapshot },
        signal,
        timeoutMs: 30_000,
      }),
    )
  }

  async #collect(since: number, signal: AbortSignal): Promise<SyncResponse> {
    let first = await this.#page(since, signal)
    for (let restart = 0; restart < 2; restart++) {
      if (first.full) {
        const pages = [first]
        let request = nextFullSyncPage(pages)
        while (request) {
          pages.push(await this.#page(0, signal, request.after, request.snapshot))
          request = nextFullSyncPage(pages)
        }
        const increments: SyncResponse[] = []
        let cursor = first.cursor
        if (cursor > 0) {
          while (true) {
            const page = await this.#page(cursor, signal)
            if (page.full) {
              first = page
              break
            }
            this.#assertProgress(page, cursor)
            increments.push(page)
            cursor = page.cursor
            if (!page.hasMore) return consolidateFullSync(pages, increments)
          }
        } else return consolidateFullSync(pages, increments)
      } else {
        const updates = [first]
        this.#assertProgress(first, since)
        let last = first
        while (last.hasMore) {
          const page = await this.#page(last.cursor, signal)
          if (page.full) {
            first = page
            break
          }
          this.#assertProgress(page, last.cursor)
          updates.push(page)
          last = page
        }
        if (!last.hasMore) {
          let shell = this.#shell
          const notes = new Map<string, SyncResponse['notes'][number]>()
          const deletions = new Map<string, SyncResponse['deletions'][number]>()
          for (const page of updates) {
            shell = mergeSync(shell, page, new Map(), new Map()).shell
            for (const note of page.notes) {
              notes.set(note.id, note)
              deletions.delete(`note:${note.id}`)
            }
            for (const deletion of page.deletions) {
              deletions.set(`${deletion.entity}:${deletion.id}`, deletion)
              if (deletion.entity === 'note') notes.delete(deletion.id)
            }
          }
          return {
            full: false,
            hasMore: false,
            nextKey: null,
            facetsFull: true,
            cursor: shell.cursor,
            notes: [...notes.values()],
            folders: [...shell.folders],
            tags: [...shell.tags],
            deletions: [...deletions.values()],
            settingsChanged: updates.some((page) => page.settingsChanged),
            profileChanged: updates.some((page) => page.profileChanged),
            siteChanged: updates.some((page) => page.siteChanged),
            serverTime: last.serverTime,
          }
        }
      }
    }
    throw invalidResponse()
  }

  #assertProgress(page: SyncResponse, since: number): void {
    if (page.cursor < since || (page.hasMore && page.cursor <= since)) throw invalidResponse()
  }
}
