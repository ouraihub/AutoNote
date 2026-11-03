import type { OutboxItem, OutboxPayload } from '../local/types'

export type { OutboxItem, OutboxPayload }

export interface OutboxStore {
  list(): Promise<OutboxItem[]>
  enqueue(item: OutboxItem): Promise<void>
  complete(id: string, writeId: string): Promise<void>
  updateRevision(
    id: string,
    writeId: string,
    rev: number,
    preserveVersion?: boolean,
  ): Promise<void>
  setRecoveryId(id: string, writeId: string, recoveryId: string): Promise<void>
  advanceDependents(
    noteId: string,
    sourceWriteId: string,
    expectedRev: number,
    nextRev: number,
  ): Promise<void>
  markFailure(id: string, writeId: string, message: string): Promise<void>
}
