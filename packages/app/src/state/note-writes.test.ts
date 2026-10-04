import { describe, expect, test } from 'vitest'
import type { NoteWriteResult } from '@shared/backend-types'
import type { Note } from '@shared/types'
import type { NotesPort } from '@app/backend'
import { BackendError } from '@app/backend'
import { NoteWriteState, type PendingContentWrite } from './note-writes'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

function note(content: string): Note {
  return {
    id: 'note-1',
    title: 'Note',
    excerpt: content,
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: content.length,
    charCount: content.length,
    rev: 2,
    position: 1,
    createdAt: 1,
    updatedAt: 2,
    deletedAt: null,
    content,
  }
}

function queuedResult(writeId: string, content: string): NoteWriteResult {
  return { queued: false, writeId, note: note(content) }
}

function createPort(
  patch: NotesPort['patch'],
  flush: NotesPort['flush'] = async () => ({ pending: 0, failed: 0 }),
): NotesPort {
  return { patch, flush } as unknown as NotesPort
}

describe('NoteWriteState', () => {
  test('does not let an older response clear a later dirty write', async () => {
    const calls: { body: { content?: string; rev: number }; writeId: string; reply: Deferred<NoteWriteResult> }[] = []
    const port = createPort((_, body, options) => {
      const reply = deferred<NoteWriteResult>()
      calls.push({ body, writeId: options.writeId, reply })
      return reply.promise
    })
    const submitted: PendingContentWrite[] = []
    const state = new NoteWriteState({
      port,
      kind: 'web',
      makeWriteId: (() => {
        let id = 0
        return () => `write-${++id}`
      })(),
      onResult: (_result, write) => submitted.push(write),
    })

    state.edit('note-1', { rev: 1, content: 'first' })
    await Promise.resolve()
    state.edit('note-1', { rev: 1, content: 'second' })
    expect(calls).toHaveLength(2)
    calls[0]!.reply.resolve(queuedResult(calls[0]!.writeId, 'first'))
    await Promise.resolve()
    await Promise.resolve()

    expect(calls[1]!.body.content).toBe('second')
    expect(state.get('note-1')?.writeId).toBe(calls[1]!.writeId)
    expect(submitted.map((write) => write.body.content)).toEqual(['first'])
    calls[1]!.reply.resolve(queuedResult(calls[1]!.writeId, 'second'))
    await Promise.resolve()
    await Promise.resolve()
  })

  test('retains failed text and flushes desktop debounce before port flush', async () => {
    const order: string[] = []
    const port = createPort(
      async () => {
        order.push('patch')
        throw new BackendError('internal', 0, 'write failed')
      },
      async () => {
        order.push('flush')
        return { pending: 0, failed: 1 }
      },
    )
    const states: string[] = []
    const state = new NoteWriteState({
      port,
      kind: 'desktop',
      debounceMs: 60,
      onStateChange: (_, value) => states.push(value),
    })
    state.edit('note-1', { rev: 1, content: 'retained' })
    const result = await state.flush('note-1')

    expect(order).toEqual(['patch', 'flush'])
    expect(result.failed).toBe(1)
    expect(state.get('note-1')?.body.content).toBe('retained')
    expect(states).toContain('failed')
  })
})
