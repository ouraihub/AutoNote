import type { ChangeEvent } from '@app/backend'
import { BackendError } from '@app/backend/errors'
import type { Logger } from '@app/log/logger'
import type { Clock } from '@app/platform/clock'
import type { Note } from '@shared/types'
import type { HttpTransport } from '../backend/transport'
import type { TabBus } from '../backend/tab-bus'
import type { LocalDb } from '../local'
import { sortOutboxForReplay } from './order'
import type { OutboxItem, OutboxStore } from './types'
import type { ReplayLock } from './replay-lock'

export interface PendingWrites {
  waitForQueued(noteId: string): Promise<void>
  onOutboxResult(message: {
    noteId: string
    writeId: string
    outcome: 'saved' | 'recovered'
    rev?: number
    copyId?: string
    recoveryReason?: 'conflict' | 'deleted'
    note?: Note
  }): Promise<boolean>
  onOutboxBaseAdvanced(message: {
    noteId: string
    writeId: string
    expectedRev: number
    nextRev: number
  }): Promise<void>
}

export interface OutboxReplayerDeps {
  outbox: OutboxStore
  lock: ReplayLock
  transport: Pick<HttpTransport, 'json'>
  bus: TabBus
  pending: PendingWrites
  content: LocalDb
  clock: Clock
  logger: Logger
  clientId: string
  emitChange(event: ChangeEvent): void
  requestPull(options: { force: boolean }): void
  waitForCreate?: (id: string) => Promise<void>
  onUnauthenticated?(): void
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'
function newRecoveryId(now: number): string {
  let stamp = ''
  for (let index = 0; index < 10; index++) {
    stamp = ALPHABET[now % 32]! + stamp
    now = Math.floor(now / 32)
  }
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  let random = ''
  for (const byte of bytes) random += ALPHABET[byte & 31]
  return stamp + random
}

export class OutboxReplayer {
  readonly #deps: OutboxReplayerDeps
  #running: Promise<void> | null = null
  readonly #recovered = new Map<string, Note>()
  readonly #controller = new AbortController()
  #paused = false
  #failedCount = 0
  #lastCode: BackendError['code'] = 'internal'

  constructor(deps: OutboxReplayerDeps) {
    this.#deps = deps
  }

  dispose(): void {
    this.#controller.abort()
  }

  resume(): void {
    this.#paused = false
  }

  pause(): void {
    this.#paused = true
  }

  replay(): Promise<void> {
    if (this.#controller.signal.aborted || this.#paused) return Promise.resolve()
    if (this.#running) return this.#running
    const userId = this.#deps.content.activeUserId()
    const current = (): boolean => !this.#controller.signal.aborted && this.#deps.content.activeUserId() === userId
    const running = this.#deps.lock
      .run(this.#deps.clientId, async (valid) => this.#replayNow(async () => current() && (await valid()) && current()))
      .then(async (acquired) => {
        if (!acquired && current()) await this.#publishPending(current)
      })
      .catch((error: unknown) => {
        if (current())
          this.#deps.logger.error('outbox.replay.failed', {
            pending: 0,
            attempts: this.#failedCount,
            code: error instanceof BackendError ? error.code : 'internal',
          })
        throw error
      })
    this.#running = running.finally(() => {
      this.#running = null
    })
    return this.#running
  }
  consumeBus(): () => void {
    return this.#deps.bus.subscribe((message) => {
      if (this.#controller.signal.aborted) return
      if (message.clientId === this.#deps.clientId) return
      const result =
        message.type === 'outbox-base-advanced'
          ? this.#deps.pending.onOutboxBaseAdvanced(message)
          : message.type === 'outbox-result' && message.targetClientId === this.#deps.clientId
            ? this.#deps.pending.onOutboxResult(message)
            : undefined
      void result?.catch((error: unknown) => {
        if (!this.#controller.signal.aborted)
          this.#deps.logger.error('outbox.replay.failed', {
            pending: 1,
            attempts: 1,
            code: error instanceof BackendError ? error.code : 'internal',
          })
      })
    })
  }

  async pendingCount(): Promise<number> {
    return new Set((await this.#deps.outbox.list()).map((item) => item.noteId)).size
  }

  async #publishPending(valid: () => boolean | Promise<boolean>): Promise<void> {
    const count = await this.pendingCount()
    if (await valid()) this.#deps.emitChange({ kind: 'write', payload: { kind: 'pending', count } })
  }

  async #current(item: OutboxItem): Promise<OutboxItem | undefined> {
    await this.#deps.pending.waitForQueued(item.noteId)
    return (await this.#deps.outbox.list()).find((entry) => entry.id === item.id && entry.writeId === item.writeId)
  }

  async #failure(
    item: OutboxItem,
    error: BackendError | string,
    code: BackendError['code'] = 'internal',
  ): Promise<void> {
    this.#failedCount++
    this.#lastCode = typeof error === 'string' ? code : error.code
    const message = typeof error === 'string' ? error : error.message
    await this.#deps.outbox.markFailure(item.id, item.writeId, message).catch(() => undefined)
    this.#deps.emitChange({
      kind: 'write',
      payload: {
        kind: 'failed',
        noteId: item.noteId,
        writeId: item.writeId,
        code: typeof error === 'string' ? code : error.code,
        retained: true,
      },
    })
  }

  async #settle(item: OutboxItem, saved: Note, expectedRev: number, valid: () => Promise<boolean>): Promise<void> {
    const { outbox, bus, clientId } = this.#deps
    if (!(await valid())) return
    await outbox.advanceDependents(item.noteId, item.writeId, expectedRev, saved.rev)
    if (await valid())
      bus.post({
        type: 'outbox-base-advanced',
        clientId,
        noteId: item.noteId,
        writeId: item.writeId,
        expectedRev,
        nextRev: saved.rev,
      })
    const latest = (await outbox.list()).find((entry) => entry.id === item.id)
    if (!(await valid())) return
    if (latest && latest.writeId !== item.writeId && latest.payload.rev === expectedRev) {
      await outbox.updateRevision(latest.id, latest.writeId, saved.rev)
    }
    if (!(await valid())) return
    await outbox.complete(item.id, item.writeId)
    if (!(await valid())) return
    if (item.clientId !== clientId)
      bus.post({
        type: 'outbox-result',
        clientId,
        targetClientId: item.clientId,
        noteId: item.noteId,
        writeId: item.writeId,
        outcome: 'saved',
        rev: saved.rev,
        updatedAt: saved.updatedAt,
        savedTitle: saved.title,
        ...(!item.payload.contentDirty && saved.content !== item.payload.content ? { savedNote: saved } : {}),
      })
    else {
      const latest = await this.#deps.pending.onOutboxResult({
        noteId: item.noteId,
        writeId: item.writeId,
        outcome: 'saved',
        rev: saved.rev,
        note: saved,
      })
      if (latest && (await valid()))
        this.#deps.emitChange({
          kind: 'write',
          payload: { kind: 'settled', noteId: item.noteId, writeId: item.writeId, note: saved },
        })
    }
    if (await valid()) this.#deps.requestPull({ force: true })
  }

  async #recover(item: OutboxItem, valid: () => Promise<boolean>): Promise<void> {
    const { outbox, content, clientId, bus } = this.#deps
    const current = await this.#current(item)
    if (!(await valid())) return
    if (!current || current.writeId !== item.writeId) return
    const snapshot = {
      id: item.id,
      writeId: item.writeId,
      content: item.payload.content,
      title: item.payload.title ?? (await content.getContent(item.noteId))?.pendingTitle ?? '',
    }
    if (!(await this.#current(current))) return
    let recoveryId = item.payload.recoveryId ?? current.payload.recoveryId
    if (!recoveryId) {
      recoveryId = newRecoveryId(this.#deps.clock.now())
      try {
        if (!(await valid())) return
        await outbox.setRecoveryId(snapshot.id, snapshot.writeId, recoveryId)
      } catch {
        if (!(await valid())) return
        await this.#failure(item, 'could not persist the recovery note id')
        return
      }
    }
    if (!(await this.#current(current)) || !(await valid())) return
    const key = `${snapshot.id}\0${snapshot.writeId}`
    let copy = this.#recovered.get(key)
    if (!copy) {
      copy = await this.#deps.transport.json<Note>({
        method: 'POST',
        path: '/api/notes',
        timeoutMs: 30_000,
        signal: this.#controller.signal,
        body: { id: recoveryId, title: snapshot.title, content: snapshot.content },
      })
      if (!(await valid())) return
      if (copy.id !== recoveryId) throw new Error('Recovery copy id mismatch')
      if (copy.content !== snapshot.content || copy.title !== snapshot.title) {
        if (!(await valid())) return
        try {
          copy = await this.#deps.transport.json<Note>({
            method: 'PATCH',
            path: `/api/notes/${encodeURIComponent(copy.id)}`,
            timeoutMs: 30_000,
            signal: this.#controller.signal,
            body: { rev: copy.rev, content: snapshot.content, title: snapshot.title, preserveVersion: true },
          })
        } catch (error) {
          if (!(
            error instanceof BackendError &&
            error.status === 409 &&
            error.details?.server &&
            error.details.server.content === snapshot.content &&
            error.details.server.title === snapshot.title
          ))
            throw error
          copy = error.details.server
        }
      }
      if (copy.content !== snapshot.content || copy.title !== snapshot.title)
        throw new Error('Recovery copy does not match journal')
      this.#recovered.set(key, copy)
      if (this.#recovered.size > 200) this.#recovered.delete(this.#recovered.keys().next().value!)
    }
    if (!(await valid())) return
    await outbox.complete(snapshot.id, snapshot.writeId)
    if (!(await valid())) return
    this.#recovered.delete(key)
    if (item.clientId !== clientId)
      bus.post({
        type: 'outbox-result',
        clientId,
        targetClientId: item.clientId,
        noteId: item.noteId,
        writeId: item.writeId,
        outcome: 'recovered',
        recoveryReason: 'deleted',
        copyId: copy.id,
      })
    else {
      const latest = await this.#deps.pending.onOutboxResult({
        noteId: item.noteId,
        writeId: item.writeId,
        outcome: 'recovered',
        recoveryReason: 'deleted',
        copyId: copy.id,
        note: copy,
      })
      if (latest && (await valid()))
        this.#deps.emitChange({
          kind: 'write',
          payload: { kind: 'recovered', noteId: item.noteId, writeId: item.writeId, copy, reason: 'deleted' },
        })
    }
    if (await valid()) this.#deps.requestPull({ force: true })
    if (await valid())
      this.#deps.logger.warn('outbox.replay.recovered', {
        noteId: item.noteId,
        writeId: item.writeId,
        rev: copy.rev,
        reason: 'deleted',
      })
  }

  async #replayNow(valid: () => Promise<boolean>): Promise<void> {
    const { outbox, transport, logger } = this.#deps
    const startedAt = this.#deps.clock.now()
    this.#failedCount = 0
    let count = 0
    const attempted = new Set<string>()
    let stopped = false
    for (let round = 0; round < 20 && !stopped; round++) {
      if (!(await valid())) break
      const batch = sortOutboxForReplay(await outbox.list()).filter(
        (item) => !attempted.has(`${item.id}\0${item.writeId}\0${item.payload.rev}`),
      )
      if (!batch.length) break
      let restart = false
      for (const candidate of batch) {
        if (!(await valid())) {
          stopped = true
          break
        }
        await this.#deps.waitForCreate?.(candidate.noteId)
        const item = await this.#current(candidate)
        if (!item) continue
        if (!(await valid())) {
          stopped = true
          break
        }
        const key = `${item.id}\0${item.writeId}\0${item.payload.rev}`
        if (attempted.has(key)) continue
        attempted.add(key)
        const recovered = this.#recovered.get(`${item.id}\0${item.writeId}`)
        if (recovered) {
          try {
            await this.#recover(item, valid)
          } catch (error) {
            if (!(await valid())) {
              stopped = true
              break
            }
            await this.#failure(item, error instanceof BackendError ? error : String(error))
          }
          continue
        }
        const { rev, content, contentDirty, title, preserveVersion } = item.payload
        if (!Number.isSafeInteger(rev) || rev < 1 || typeof content !== 'string') {
          await this.#failure(item, 'invalid offline journal payload')
          continue
        }
        // IDB is authoritative. Freeze exactly this writeId's payload, not a later in-memory edit.
        const frozen = { ...item, payload: { ...item.payload } }
        if (!(await valid())) {
          stopped = true
          break
        }
        let saved: Note
        try {
          saved = await transport.json<Note>({
            method: 'PATCH',
            path: `/api/notes/${encodeURIComponent(item.noteId)}`,
            timeoutMs: 30_000,
            signal: this.#controller.signal,
            body: {
              rev,
              ...(contentDirty ? { content } : {}),
              ...(title !== undefined ? { title } : {}),
              ...(preserveVersion ? { preserveVersion: true } : {}),
            },
          })
        } catch (error) {
          if (!(await valid())) {
            stopped = true
            break
          }
          if (error instanceof BackendError && error.status === 409) {
            const server = error.details?.server
            if (!server) {
              await this.#failure(item, 'conflict response did not include the server note', 'conflict')
              continue
            }
            if ((!contentDirty || server.content === content) && (title === undefined || server.title === title)) {
              saved = server
            } else {
              if (!(await this.#current(item))) continue
              if (!(await valid())) {
                stopped = true
                break
              }
              try {
                await outbox.updateRevision(item.id, item.writeId, server.rev, true)
                logger.warn('outbox.replay.rebased', {
                  noteId: item.noteId,
                  writeId: item.writeId,
                  rev: server.rev,
                  reason: 'conflict',
                })
                this.#deps.requestPull({ force: true })
                restart = true
                break
              } catch {
                if (!(await valid())) {
                  stopped = true
                  break
                }
                await this.#failure(item, 'could not rebase the offline journal')
                continue
              }
            }
          } else if (error instanceof BackendError && error.status === 404) {
            try {
              await this.#recover(frozen, valid)
            } catch (failure) {
              if (!(await valid())) {
                stopped = true
                break
              }
              await this.#failure(item, failure instanceof BackendError ? failure : String(failure))
            }
            continue
          } else if (
            error instanceof BackendError &&
            (error.code === 'offline' || error.code === 'request_timeout' || error.status === 401)
          ) {
            this.#failedCount++
            this.#lastCode = error.code
            if (error.code === 'offline') this.#deps.emitChange({ kind: 'connectivity', online: false })
            if (error.status === 401) {
              this.#paused = true
              this.#deps.onUnauthenticated?.()
              this.#deps.emitChange({ kind: 'settings' })
            }
            this.#deps.emitChange({
              kind: 'write',
              payload: { kind: 'failed', noteId: item.noteId, writeId: item.writeId, code: error.code, retained: true },
            })
            stopped = true
            break
          } else {
            await this.#failure(item, error instanceof BackendError ? error : String(error))
            continue
          }
        }
        if (!(await valid())) {
          stopped = true
          break
        }
        try {
          await this.#settle(frozen, saved, rev, valid)
          count++
          if ((await outbox.list()).some((entry) => entry.id === item.id && entry.writeId !== item.writeId))
            restart = true
        } catch (error) {
          if (!(await valid())) {
            stopped = true
            break
          }
          await this.#failure(item, error instanceof BackendError ? error : String(error))
        }
      }
      if (restart) continue
    }
    if (await valid()) {
      await this.#publishPending(valid)
      const pending = await this.pendingCount()
      if (this.#failedCount)
        logger.error('outbox.replay.failed', { pending, attempts: this.#failedCount, code: this.#lastCode })
      else logger.info('outbox.replay.completed', { count, pending, durationMs: this.#deps.clock.now() - startedAt })
    }
  }
}
