import type { NoteWriteResult, WriteQueueEvent } from '@shared/backend-types'
import type { PatchNoteBody } from '@shared/types'
import type { NotesPort } from '@app/backend'

export type NoteSaveState = 'idle' | 'dirty' | 'persisting' | 'saved-local' | 'synced' | 'failed' | 'recovered'

export interface PendingContentWrite {
  readonly noteId: string
  readonly writeId: string
  readonly body: PatchNoteBody
  readonly state: NoteSaveState
}

export interface NoteWriteStateOptions {
  readonly port: NotesPort
  readonly kind: 'web' | 'desktop'
  readonly debounceMs?: number
  readonly onResult?: (result: NoteWriteResult, submitted: PendingContentWrite) => void
  readonly onError?: (error: unknown, submitted: PendingContentWrite) => void
  readonly onStateChange?: (noteId: string, state: NoteSaveState) => void
  readonly makeWriteId?: () => string
}

interface WriteRecord {
  latest: PendingContentWrite
  timer: ReturnType<typeof setTimeout> | null
  sending: Map<string, Promise<void>>
  state: NoteSaveState
}

const DEFAULT_DESKTOP_DEBOUNCE_MS = 260

/**
 * Owns the one text-write stream used by NotesState. It never stores a second
 * outbox: NotesPort is the persistence boundary and remains responsible for
 * its local journal/network queue.
 */
export class NoteWriteState {
  readonly #port: NotesPort
  readonly #kind: 'web' | 'desktop'
  readonly #debounceMs: number
  readonly #onResult: ((result: NoteWriteResult, submitted: PendingContentWrite) => void) | undefined
  readonly #onError: ((error: unknown, submitted: PendingContentWrite) => void) | undefined
  readonly #onStateChange: ((noteId: string, state: NoteSaveState) => void) | undefined
  readonly #makeWriteId: () => string
  readonly #records = new Map<string, WriteRecord>()

  constructor(options: NoteWriteStateOptions) {
    this.#port = options.port
    this.#kind = options.kind
    this.#debounceMs = Math.max(0, options.debounceMs ?? DEFAULT_DESKTOP_DEBOUNCE_MS)
    this.#onResult = options.onResult
    this.#onError = options.onError
    this.#onStateChange = options.onStateChange
    this.#makeWriteId = options.makeWriteId ?? (() => crypto.randomUUID())
  }

  get(noteId: string): PendingContentWrite | null {
    return this.#records.get(noteId)?.latest ?? null
  }

  get stateById(): ReadonlyMap<string, NoteSaveState> {
    return new Map([...this.#records].map(([id, record]) => [id, record.state]))
  }

  get dirtyIds(): ReadonlySet<string> {
    return new Set(
      [...this.#records].filter(([, record]) => record.state !== 'idle' && record.state !== 'synced').map(([id]) => id),
    )
  }

  edit(noteId: string, body: PatchNoteBody): string {
    const previous = this.#records.get(noteId)
    if (previous?.timer !== null && previous?.timer !== undefined) {
      clearTimeout(previous.timer)
      previous.timer = null
    }
    const submitted: PendingContentWrite = {
      noteId,
      writeId: this.#makeWriteId(),
      body: { ...body },
      state: 'dirty',
    }
    const record: WriteRecord = previous ?? { latest: submitted, timer: null, sending: new Map(), state: 'dirty' }
    record.latest = submitted
    record.state = 'dirty'
    record.timer = null
    this.#records.set(noteId, record)
    this.#notify(noteId, 'dirty')
    if (this.#kind === 'web') {
      if (record.sending.size === 0) void this.#send(noteId, submitted)
    } else
      record.timer = setTimeout(() => {
        record.timer = null
        if (record.sending.size === 0) void this.#send(noteId, record.latest)
      }, this.#debounceMs)
    return submitted.writeId
  }

  rebase(noteId: string, writeId: string, rev: number): void {
    const record = this.#records.get(noteId)
    if (!record || record.latest.writeId !== writeId) return
    record.latest = { ...record.latest, body: { ...record.latest.body, rev } }
  }
  async flush(noteId?: string): Promise<{ pending: number; failed: number }> {
    const ids = noteId === undefined ? [...this.#records.keys()] : [noteId]
    for (const id of ids) {
      const record = this.#records.get(id)
      if (!record) continue
      if (record.timer !== null) {
        clearTimeout(record.timer)
        record.timer = null
        if (record.sending.size === 0) void this.#send(id, record.latest)
      }
    }
    await this.#waitForSends(ids)
    const result = await this.#port.flush(noteId)
    const localFailed = ids.reduce((count, id) => count + (this.#records.get(id)?.state === 'failed' ? 1 : 0), 0)
    const finalResult = { pending: result.pending, failed: Math.max(result.failed, localFailed) }
    for (const id of ids) {
      const record = this.#records.get(id)
      if (!record || record.sending.size > 0) continue
      if (record.state === 'saved-local' && finalResult.pending === 0 && finalResult.failed === 0) {
        record.state = 'synced'
        this.#notify(id, 'synced')
      }
    }
    return finalResult
  }

  handle(event: WriteQueueEvent): void {
    if (event.kind === 'pending') return
    const record = this.#records.get(event.noteId)
    if (!record || record.latest.writeId !== event.writeId) return
    if (event.kind === 'settled') {
      record.state = 'synced'
      this.#notify(event.noteId, 'synced')
    } else if (event.kind === 'recovered') {
      record.state = 'recovered'
      this.#notify(event.noteId, 'recovered')
    } else {
      record.state = 'failed'
      this.#notify(event.noteId, 'failed')
    }
  }

  dispose(): void {
    for (const record of this.#records.values()) if (record.timer !== null) clearTimeout(record.timer)
    this.#records.clear()
  }

  #notify(noteId: string, state: NoteSaveState): void {
    this.#onStateChange?.(noteId, state)
  }

  async #send(noteId: string, submitted: PendingContentWrite): Promise<void> {
    const record = this.#records.get(noteId)
    if (!record || record.latest.writeId !== submitted.writeId) return
    if (record.timer !== null) {
      clearTimeout(record.timer)
      record.timer = null
    }
    record.state = 'persisting'
    this.#notify(noteId, 'persisting')
    const task = this.#port.patch(noteId, submitted.body, { writeId: submitted.writeId }).then(
      (result) => {
        const current = this.#records.get(noteId)
        if (!current || current.latest.writeId !== submitted.writeId) {
          this.#onResult?.(result, submitted)
          return
        }
        current.state = result.queued ? 'saved-local' : 'synced'
        this.#notify(noteId, current.state)
        this.#onResult?.(result, submitted)
      },
      (error: unknown) => {
        const current = this.#records.get(noteId)
        if (current?.latest.writeId === submitted.writeId) {
          current.state = 'failed'
          this.#notify(noteId, 'failed')
        }
        this.#onError?.(error, submitted)
      },
    )
    record.sending.set(submitted.writeId, task)
    await task
    const current = this.#records.get(noteId)
    current?.sending.delete(submitted.writeId)
    if (current && current.latest.writeId !== submitted.writeId && current.state === 'dirty')
      void this.#send(noteId, current.latest)
  }

  async #waitForSends(ids: readonly string[]): Promise<void> {
    while (true) {
      const sends = ids.flatMap((id) => [...(this.#records.get(id)?.sending.values() ?? [])])
      if (sends.length === 0) return
      await Promise.all(sends)
    }
  }
}
