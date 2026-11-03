import { BackendError } from '@app/backend/errors'
import type { Note } from '@shared/types'
import type { OutboxReplayerDeps } from './replayer'
import type { OutboxItem } from './types'

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

export interface RecoveryContext {
  deps: OutboxReplayerDeps
  signal: AbortSignal
  recovered: Map<string, Note>
  current(item: OutboxItem): Promise<OutboxItem | undefined>
  valid: () => Promise<boolean>
  failure(
    item: OutboxItem,
    error: BackendError | string,
    code?: BackendError['code'],
  ): Promise<void>
}

export async function recoverOutboxItem(
  item: OutboxItem,
  context: RecoveryContext,
): Promise<void> {
  const { deps, signal, recovered, current, valid, failure } = context
  const { outbox, content, clientId, bus } = deps
  const currentItem = await current(item)
  if (!(await valid())) return
  if (!currentItem || currentItem.writeId !== item.writeId) return
  const snapshot = {
    id: item.id,
    writeId: item.writeId,
    content: item.payload.content,
    title:
      item.payload.title ??
      (await content.getContent(item.noteId))?.pendingTitle ??
      '',
  }
  if (!(await current(currentItem))) return
  let recoveryId = item.payload.recoveryId ?? currentItem.payload.recoveryId
  if (!recoveryId) {
    recoveryId = newRecoveryId(deps.clock.now())
    try {
      if (!(await valid())) return
      await outbox.setRecoveryId(snapshot.id, snapshot.writeId, recoveryId)
    } catch {
      if (!(await valid())) return
      await failure(item, 'could not persist the recovery note id')
      return
    }
  }
  if (!(await current(currentItem)) || !(await valid())) return
  const key = `${snapshot.id}\0${snapshot.writeId}`
  let copy = recovered.get(key)
  if (!copy) {
    copy = await deps.transport.json<Note>({
      method: 'POST',
      path: '/api/notes',
      timeoutMs: 30_000,
      signal,
      body: {
        id: recoveryId,
        title: snapshot.title,
        content: snapshot.content,
      },
    })
    if (!(await valid())) return
    if (copy.id !== recoveryId) throw new Error('Recovery copy id mismatch')
    if (copy.content !== snapshot.content || copy.title !== snapshot.title) {
      if (!(await valid())) return
      try {
        copy = await deps.transport.json<Note>({
          method: 'PATCH',
          path: `/api/notes/${encodeURIComponent(copy.id)}`,
          timeoutMs: 30_000,
          signal,
          body: {
            rev: copy.rev,
            content: snapshot.content,
            title: snapshot.title,
            preserveVersion: true,
          },
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
    recovered.set(key, copy)
    if (recovered.size > 200) recovered.delete(recovered.keys().next().value!)
  }
  if (!(await valid())) return
  await outbox.complete(snapshot.id, snapshot.writeId)
  if (!(await valid())) return
  recovered.delete(key)
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
    const latest = await deps.pending.onOutboxResult({
      noteId: item.noteId,
      writeId: item.writeId,
      outcome: 'recovered',
      recoveryReason: 'deleted',
      copyId: copy.id,
      note: copy,
    })
    if (latest && (await valid()))
      deps.emitChange({
        kind: 'write',
        payload: {
          kind: 'recovered',
          noteId: item.noteId,
          writeId: item.writeId,
          copy,
          reason: 'deleted',
        },
      })
  }
  if (await valid()) deps.requestPull({ force: true })
  if (await valid())
    deps.logger.warn('outbox.replay.recovered', {
      noteId: item.noteId,
      writeId: item.writeId,
      rev: copy.rev,
      reason: 'deleted',
    })
}
