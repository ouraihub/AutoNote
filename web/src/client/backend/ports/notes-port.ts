import type { CallOptions, NotesPort, NoteWriteOptions } from '@app/backend'
import { BackendError } from '@app/backend/errors'
import type { NoteWriteResult } from '@shared/backend-types'
import type {
  Backlink,
  CreateNoteBody,
  ListNotesQuery,
  ListNotesResponse,
  Note,
  NoteVersion,
  NoteVersionMeta,
  PatchNoteBody,
  SyncResponse,
} from '@shared/types'
import type { HttpTransport } from '../transport'
import type { LocalDb } from '../../local'
import { SyncPuller } from '../../sync/puller'
import type { ChangeEvent } from '@app/backend'
import type { Clock } from '@app/platform/clock'
import type { Logger } from '@app/log/logger'
import type { Timers } from '../../platform'
import type { TabBus } from '../tab-bus'
import type { ReplayLock } from '../../outbox/replay-lock'
import { OutboxReplayer } from '../../outbox/replayer'
import { LocalOutboxStore } from '../../outbox/outbox-store'
import { HttpNotesTextWriter } from './notes'

export interface HttpNotesPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
  readonly localDb: LocalDb
  readonly clientId: string
  readonly bus: TabBus
  readonly lock: ReplayLock
  readonly clock: Clock
  readonly logger: Logger
  readonly timers: Timers
  readonly emitChange: (event: ChangeEvent) => void
  readonly getAutoSaveDelay: () => number
}

export class HttpNotesPort implements NotesPort {
  readonly #deps: HttpNotesPortDeps
  readonly #writer: HttpNotesTextWriter
  readonly #puller: SyncPuller
  readonly #replayer: OutboxReplayer
  readonly #unsubscribe: () => void
  #timer: number | null = null
  #disposed = false

  constructor(deps: HttpNotesPortDeps) {
    this.#deps = deps
    this.#puller = new SyncPuller(deps)
    this.#writer = new HttpNotesTextWriter({
      transport: deps.transport,
      localDb: deps.localDb,
      clientId: deps.clientId,
      replay: () => this.#replayer.replay(),
      onWriteEvent: (payload) => deps.emitChange({ kind: 'write', payload }),
    })
    this.#replayer = new OutboxReplayer({
      ...deps,
      outbox: new LocalOutboxStore(deps.localDb),
      pending: this.#writer,
      content: deps.localDb,
      requestPull: ({ force }) => {
        void this.#puller.pull(force).catch(this.#backgroundFailure)
      },
    })
    this.#unsubscribe = this.#replayer.consumeBus()
  }

  readonly #backgroundFailure = (error: unknown): void => {
    if (this.#disposed) return
    this.#deps.logger.warn('notes.background.failed', { code: error instanceof BackendError ? error.code : 'internal' })
    if (error instanceof BackendError && error.code === 'unauthenticated') this.#deps.emitChange({ kind: 'settings' })
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer !== null) this.#deps.timers.clearTimeout(this.#timer)
    this.#unsubscribe()
    this.#replayer.dispose()
    this.#puller.dispose()
  }

  snapshot(options?: CallOptions): Promise<SyncResponse> {
    return this.#puller.snapshot(options)
  }
  list(query: ListNotesQuery, options?: CallOptions): Promise<ListNotesResponse> {
    return this.#deps.transport.json<ListNotesResponse>({
      path: '/api/notes',
      query: { ...query },
      signal: options?.signal,
    })
  }
  get(id: string, options?: CallOptions): Promise<Note> {
    return this.#writer.get(id, options)
  }
  create(body: CreateNoteBody, options?: CallOptions): Promise<Note> {
    return this.#deps.transport.json<Note>({
      path: '/api/notes',
      method: 'POST',
      body,
      signal: options?.signal,
      timeoutMs: 30_000,
    })
  }
  async patch(id: string, body: PatchNoteBody, options: NoteWriteOptions): Promise<NoteWriteResult> {
    const result = await this.#writer.patch(id, body, options)
    if (result.queued && !this.#disposed) {
      if (this.#timer !== null) this.#deps.timers.clearTimeout(this.#timer)
      this.#timer = this.#deps.timers.setTimeout(
        () => {
          this.#timer = null
          void this.#replayer.replay().catch(this.#backgroundFailure)
        },
        Math.max(100, this.#deps.getAutoSaveDelay()),
      )
    }
    return result
  }
  async remove(id: string, options?: CallOptions): Promise<Note> {
    await this.#assertSaved(id, options)
    return this.#deps.transport.json<Note>({
      path: `/api/notes/${encodeURIComponent(id)}`,
      method: 'DELETE',
      signal: options?.signal,
    })
  }
  async restore(id: string, options?: CallOptions): Promise<Note> {
    await this.#assertSaved(id, options)
    return this.#deps.transport.json<Note>({
      path: `/api/notes/${encodeURIComponent(id)}/restore`,
      method: 'POST',
      signal: options?.signal,
    })
  }
  async purge(id: string, options?: CallOptions): Promise<{ ok: true; cursor: number }> {
    await this.#assertSaved(id, options)
    return this.#deps.transport.json<{ ok: true; cursor: number }>({
      path: `/api/notes/${encodeURIComponent(id)}/purge`,
      method: 'DELETE',
      signal: options?.signal,
    })
  }
  async duplicate(id: string, body: { id?: string } = {}, options?: CallOptions): Promise<Note> {
    await this.#assertSaved(id, options)
    return this.#deps.transport.json<Note>({
      path: `/api/notes/${encodeURIComponent(id)}/duplicate`,
      method: 'POST',
      body,
      signal: options?.signal,
    })
  }
  async emptyTrash(options?: CallOptions): Promise<{ purged: number }> {
    await this.#assertSaved(undefined, options)
    return this.#deps.transport.json<{ purged: number }>({
      path: '/api/notes/trash/empty',
      method: 'POST',
      signal: options?.signal,
    })
  }
  async versions(id: string, options?: CallOptions): Promise<NoteVersionMeta[]> {
    const result = await this.#deps.transport.json<{ versions: NoteVersionMeta[] }>({
      path: `/api/notes/${encodeURIComponent(id)}/versions`,
      signal: options?.signal,
    })
    return result.versions
  }
  version(id: string, versionId: string, options?: CallOptions): Promise<NoteVersion> {
    return this.#deps.transport.json<NoteVersion>({
      path: `/api/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}`,
      signal: options?.signal,
    })
  }
  async restoreVersion(id: string, versionId: string, options?: CallOptions): Promise<Note> {
    await this.#assertSaved(id, options)
    return this.#deps.transport.json<Note>({
      path: `/api/notes/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
      method: 'POST',
      signal: options?.signal,
    })
  }
  async backlinks(id: string, options?: CallOptions): Promise<Backlink[]> {
    const result = await this.#deps.transport.json<{ backlinks: Backlink[] }>({
      path: `/api/notes/${encodeURIComponent(id)}/backlinks`,
      signal: options?.signal,
    })
    return result.backlinks
  }
  async flush(noteId?: string, options?: CallOptions): Promise<{ pending: number; failed: number }> {
    if (options?.signal?.aborted) throw new BackendError('cancelled', 0, 'Flush cancelled')
    return this.#writer.flush(noteId)
  }
  async syncNow(options?: CallOptions): Promise<void> {
    await this.#puller.pull(true, options)
    await this.flush(undefined, options)
    await this.#puller.pull(false, options)
  }
  async #assertSaved(id: string | undefined, options?: CallOptions): Promise<void> {
    const result = await this.flush(id, options)
    if (options?.signal?.aborted) throw new BackendError('cancelled', 0, 'Mutation cancelled')
    const journal = await this.#deps.localDb.getOutbox()
    if (result.pending || result.failed || journal.some((item) => id === undefined || item.noteId === id))
      throw new BackendError('conflict', 409, 'Local changes are still pending')
  }
}
