import type { LocalDb } from '../local'
import type { OutboxItem, OutboxStore } from './types'

/** The journal is owned by LocalDb; this adapter prevents a second outbox implementation. */
export class LocalOutboxStore implements OutboxStore {
  readonly #localDb: LocalDb

  constructor(localDb: LocalDb) {
    this.#localDb = localDb
  }

  list(): Promise<OutboxItem[]> {
    return this.#localDb.getOutbox()
  }

  enqueue(item: OutboxItem): Promise<void> {
    return this.#localDb.enqueueOutbox(item)
  }

  complete(id: string, writeId: string): Promise<void> {
    return this.#localDb.completeOutboxItem(id, writeId)
  }

  updateRevision(
    id: string,
    writeId: string,
    rev: number,
    preserveVersion?: boolean,
  ): Promise<void> {
    return this.#localDb.updateOutboxRevision(id, writeId, rev, preserveVersion)
  }

  setRecoveryId(
    id: string,
    writeId: string,
    recoveryId: string,
  ): Promise<void> {
    return this.#localDb.setOutboxRecoveryId(id, writeId, recoveryId)
  }

  advanceDependents(
    noteId: string,
    sourceWriteId: string,
    expectedRev: number,
    nextRev: number,
  ): Promise<void> {
    return this.#localDb.advanceOutboxDependents(
      noteId,
      sourceWriteId,
      expectedRev,
      nextRev,
    )
  }

  markFailure(id: string, writeId: string, message: string): Promise<void> {
    return this.#localDb.markOutboxFailure(id, writeId, message)
  }
}
