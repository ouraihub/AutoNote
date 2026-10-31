import type { CallOptions, NoteWriteOptions } from '@app/backend'
import { BackendError } from '@app/backend/errors'
import type { Note, PatchNoteBody } from '@shared/types'
import type { NoteWriteResult, WriteQueueEvent } from '@shared/backend-types'
import type { HttpTransport } from '../transport'
import type { LocalDb } from '../../local'
import { LocalOutboxStore, type OutboxItem } from '../../outbox'
import { offlineError } from '../errors'

export interface NotesTextWriterDeps {
  readonly transport: Pick<HttpTransport, 'json'>
  readonly localDb: LocalDb
  readonly clientId: string
  readonly onWriteEvent?: (event: WriteQueueEvent) => void
  readonly replay?: (noteId?: string) => Promise<void>
}

const TEXT_KEYS: Record<string, true> = {
  rev: true,
  content: true,
  title: true,
  preserveVersion: true,
}

/** Text writes are durable before confirmation; network replay is independently scheduled. */
export class HttpNotesTextWriter {
  readonly #transport: Pick<HttpTransport, 'json'>
  readonly #localDb: LocalDb
  readonly #outbox: LocalOutboxStore
  readonly #clientId: string
  readonly #onWriteEvent: ((event: WriteQueueEvent) => void) | undefined
  readonly #replay: ((noteId?: string) => Promise<void>) | undefined
  readonly #enqueueChains = new Map<string, Promise<void>>()
  readonly #latestWrites = new Map<string, string>()
  readonly #failed = new Set<string>()

  constructor(deps: NotesTextWriterDeps) {
    this.#transport = deps.transport
    this.#localDb = deps.localDb
    this.#outbox = new LocalOutboxStore(deps.localDb)
    this.#clientId = deps.clientId
    this.#replay = deps.replay
    this.#onWriteEvent = deps.onWriteEvent
  }

  async waitForQueued(noteId: string): Promise<void> {
    await this.#enqueueChains.get(noteId)
  }

  async onOutboxBaseAdvanced(message: {
    noteId: string
    writeId: string
    expectedRev: number
    nextRev: number
  }): Promise<void> {
    await this.waitForQueued(message.noteId)
    await this.#outbox.advanceDependents(
      message.noteId,
      message.writeId,
      message.expectedRev,
      message.nextRev,
    )
  }

  async onOutboxResult(message: {
    noteId: string
    writeId: string
    outcome: 'saved' | 'recovered'
    rev?: number
    copyId?: string
    recoveryReason?: 'conflict' | 'deleted'
    note?: Note
  }): Promise<boolean> {
    await this.waitForQueued(message.noteId)
    const latest = this.#latestWrites.get(message.noteId)
    if (latest !== message.writeId) {
      if (message.outcome === 'saved' && message.rev !== undefined) {
        const item = (await this.#outbox.list()).find(
          (entry) => entry.id === `patch:${this.#clientId}:${message.noteId}`,
        )
        if (item && item.payload.rev < message.rev)
          await this.#outbox.updateRevision(item.id, item.writeId, message.rev)
      }
      return false
    }
    if (
      message.outcome === 'recovered' &&
      (message.recoveryReason !== 'deleted' || !message.copyId)
    )
      return false
    const note =
      message.note ??
      (await this.#transport.json<Note>({
        path: `/api/notes/${encodeURIComponent(message.outcome === 'recovered' ? message.copyId! : message.noteId)}`,
      }))
    if (this.#latestWrites.get(message.noteId) !== message.writeId) return false
    this.#latestWrites.delete(message.noteId)
    if (message.note) return true
    if (message.outcome === 'recovered')
      this.#onWriteEvent?.({
        kind: 'recovered',
        noteId: message.noteId,
        writeId: message.writeId,
        copy: note,
        reason: 'deleted',
      })
    else
      this.#onWriteEvent?.({
        kind: 'settled',
        noteId: message.noteId,
        writeId: message.writeId,
        note,
      })
    return true
  }

  async get(id: string, options?: CallOptions): Promise<Note> {
    const user = this.#localDb.activeUserId()
    await this.#enqueueChains.get(id)
    await this.#outbox.list()
    let note: Note
    try {
      note = await this.#transport.json<Note>({
        path: `/api/notes/${encodeURIComponent(id)}`,
        signal: options?.signal,
      })
      this.#assertUser(user)
      // A title-only journal still needs a real server body for subsequent offline reads.
      // Serialize this tab's cache writes with queued edits; dirty journal entries
      // in either tab remain authoritative until replay confirms them.
      const previous = this.#enqueueChains.get(id) ?? Promise.resolve()
      const cache = previous.then(async () => {
        this.#assertUser(user)
        if (
          !(await this.#outbox.list()).some(
            (item) => item.noteId === id && item.payload.contentDirty,
          )
        ) {
          await this.#localDb
            .setContent(
              id,
              {
                content: note.content,
                rev: note.rev,
                updatedAt: note.updatedAt,
              },
              user!,
            )
            .catch(() => undefined)
        }
      })
      this.#enqueueChains.set(
        id,
        cache.catch(() => undefined),
      )
      await cache
    } catch (error) {
      this.#assertUser(user)
      if (!(error instanceof BackendError && error.code === 'offline'))
        throw error
      await this.#enqueueChains.get(id)
      const shell = await this.#localDb.loadShell()
      const summary = shell?.notes.find((item) => item.id === id)
      const current = (await this.#outbox.list()).filter(
        (item) => item.noteId === id,
      )
      const content =
        current.filter((item) => item.payload.contentDirty).at(-1)?.payload
          .content ?? (await this.#localDb.getContent(id))?.content
      if (content === undefined || !summary) throw offlineError()
      note = { ...summary, content }
    }
    await this.#enqueueChains.get(id)
    const latest = (await this.#outbox.list()).filter(
      (item) => item.noteId === id,
    )
    this.#assertUser(user)
    const content = latest.filter((item) => item.payload.contentDirty).at(-1)
      ?.payload.content
    const title = latest
      .filter((item) => item.payload.title !== undefined)
      .at(-1)?.payload.title
    return {
      ...note,
      ...(content === undefined ? {} : { content }),
      ...(title === undefined ? {} : { title }),
    }
  }

  async flush(noteId?: string): Promise<{ pending: number; failed: number }> {
    const chains =
      noteId === undefined
        ? [...this.#enqueueChains.values()]
        : [this.#enqueueChains.get(noteId)]
    await Promise.all(chains)
    await this.#replay?.(noteId)
    const items = (await this.#outbox.list()).filter(
      (item) => noteId === undefined || item.noteId === noteId,
    )
    const pending = new Set(items.map((item) => item.noteId))
    const failed = new Set(
      items.filter((item) => item.attempts > 0).map((item) => item.noteId),
    )
    for (const id of this.#failed) {
      if (noteId === undefined || id === noteId) {
        pending.add(id)
        failed.add(id)
      }
    }
    return { pending: pending.size, failed: failed.size }
  }

  async waitForLocalCommit(): Promise<void> {
    let chains: Promise<void>[]
    do {
      chains = [...this.#enqueueChains.values()]
      await Promise.all(chains)
    } while (
      [...this.#enqueueChains.values()].some(
        (chain, index) => chain !== chains[index],
      )
    )
    if (this.#failed.size)
      throw new BackendError('internal', 0, 'Local changes are not persisted')
  }

  patch(
    id: string,
    body: PatchNoteBody,
    options: NoteWriteOptions,
  ): Promise<NoteWriteResult> {
    if (!Object.keys(body).every((key) => TEXT_KEYS[key]))
      return this.#patchRemote(id, body, options)
    return this.#queueTextPatch(id, body, options)
  }

  async #patchRemote(
    id: string,
    body: PatchNoteBody,
    options: NoteWriteOptions,
  ): Promise<NoteWriteResult> {
    const user = this.#localDb.activeUserId()
    const note = await this.#transport.json<Note>({
      method: 'PATCH',
      path: `/api/notes/${encodeURIComponent(id)}`,
      body,
      signal: options.signal,
      timeoutMs: 30_000,
    })
    this.#assertUser(user)
    if (
      !options.signal?.aborted &&
      !(await this.#outbox.list()).some(
        (item) => item.noteId === id && item.payload.contentDirty,
      )
    ) {
      await this.#localDb
        .setContent(
          id,
          { content: note.content, rev: note.rev, updatedAt: note.updatedAt },
          user!,
        )
        .catch(() => undefined)
    }
    this.#assertUser(user)
    return { queued: false, writeId: options.writeId, note }
  }

  #queueTextPatch(
    id: string,
    body: PatchNoteBody,
    options: NoteWriteOptions,
  ): Promise<NoteWriteResult> {
    const user = this.#localDb.activeUserId()
    const previous = this.#enqueueChains.get(id) ?? Promise.resolve()
    const result = previous.then(async () => {
      try {
        this.#assertUser(user)
        return await this.#enqueueTextPatch(id, body, options)
      } catch (error) {
        this.#failed.add(id)
        throw error
      }
    })
    this.#enqueueChains.set(
      id,
      result.then(
        () => undefined,
        () => undefined,
      ),
    )
    return result
  }

  async #enqueueTextPatch(
    id: string,
    body: PatchNoteBody,
    options: NoteWriteOptions,
  ): Promise<NoteWriteResult> {
    const user = this.#localDb.activeUserId()
    const cached = await this.#localDb.getContent(id)
    const entries = await this.#outbox.list()
    this.#assertUser(user)
    const queueId = `patch:${this.#clientId}:${id}`
    const stored = entries.find((item) => item.id === queueId)
    const contentDirty =
      stored?.payload.contentDirty === true || body.content !== undefined
    const content =
      body.content ?? stored?.payload.content ?? cached?.content ?? ''
    const title = body.title ?? stored?.payload.title
    const dependsOnWriteId =
      stored?.dependsOnWriteId ??
      entries.find(
        (item) =>
          item.noteId === id &&
          item.clientId !== this.#clientId &&
          item.payload.rev === body.rev,
      )?.writeId
    const item: OutboxItem = {
      id: queueId,
      clientId: this.#clientId,
      writeId: options.writeId,
      ...(dependsOnWriteId === undefined ? {} : { dependsOnWriteId }),
      noteId: id,
      payload: {
        ...stored?.payload,
        rev: Math.max(body.rev, stored?.payload.rev ?? body.rev),
        content,
        contentDirty,
        ...(title === undefined ? {} : { title }),
        ...(body.preserveVersion || stored?.payload.preserveVersion
          ? { preserveVersion: true }
          : {}),
        ...(stored?.payload.recoveryId
          ? { recoveryId: stored.payload.recoveryId }
          : {}),
      },
      attempts: 0,
      createdAt: Date.now(),
    }
    try {
      await this.#outbox.enqueue(item)
    } catch (error) {
      this.#failed.add(id)
      throw error
    }
    this.#assertUser(user)
    this.#latestWrites.set(id, item.writeId)
    this.#failed.delete(id)
    if (contentDirty || cached !== undefined) {
      await this.#localDb
        .setContent(
          id,
          {
            content,
            rev: item.payload.rev,
            updatedAt: Date.now(),
            writeId: options.writeId,
            ...(title === undefined ? {} : { pendingTitle: title }),
            ...(contentDirty ? { contentDirty: true } : {}),
          },
          user!,
        )
        .catch(() => undefined)
    }
    this.#onWriteEvent?.({
      kind: 'pending',
      count: new Set([...entries.map((entry) => entry.noteId), id]).size,
    })
    return {
      queued: true,
      noteId: id,
      rev: item.payload.rev,
      writeId: options.writeId,
    }
  }

  #assertUser(user: string | null): void {
    if (!user || this.#localDb.activeUserId() !== user)
      throw new BackendError('cancelled', 0, 'Note request superseded')
  }
}
