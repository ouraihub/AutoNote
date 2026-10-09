import { describe, expect, test, vi } from 'vitest'
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

function savedResult(writeId: string, content: string, rev: number): NoteWriteResult {
  return { queued: false, writeId, note: { ...note(content), rev } }
}

function createPort(
  patch: NotesPort['patch'],
  flush: NotesPort['flush'] = async () => ({ pending: 0, failed: 0 }),
): NotesPort {
  return { patch, flush } as unknown as NotesPort
}

describe('NoteWriteState', () => {
  test('keeps one save in flight; an older reply does not clear the later edit, which follows on the new revision', async () => {
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
      onResult: (result, write) => {
        submitted.push(write)
        if (!result.queued) state.rebase('note-1', state.get('note-1')!.writeId, result.note.rev)
      },
    })

    state.edit('note-1', { rev: 1, content: 'first' })
    await Promise.resolve()
    state.edit('note-1', { rev: 1, content: 'second' })
    expect(calls).toHaveLength(1)
    expect(state.get('note-1')?.body.content).toBe('second')
    calls[0]!.reply.resolve(savedResult(calls[0]!.writeId, 'first', 2))
    await vi.waitFor(() => expect(calls).toHaveLength(2))

    expect(calls[1]!.body).toMatchObject({ content: 'second', rev: 2 })
    expect(state.get('note-1')?.writeId).toBe(calls[1]!.writeId)
    expect(submitted.map((write) => write.body.content)).toEqual(['first'])
    calls[1]!.reply.resolve(savedResult(calls[1]!.writeId, 'second', 3))
    await vi.waitFor(() => expect(submitted).toHaveLength(2))
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

  test('a follow-up save does not repeat when the edit debounce timer fires later', async () => {
    vi.useFakeTimers()
    try {
      let rev = 1
      const sent: number[] = []
      const first = deferred<NoteWriteResult>()
      const port = createPort(async (_, body, options) => {
        sent.push(body.rev)
        if (body.rev !== rev) throw new BackendError('conflict', 409, 'stale revision')
        if (sent.length === 1) await first.promise
        rev++
        return savedResult(options.writeId, body.content ?? '', rev)
      })
      const state = new NoteWriteState({
        port,
        kind: 'desktop',
        debounceMs: 40,
        onResult: (result) => {
          const latest = state.get('note-1')
          if (!result.queued && latest) state.rebase('note-1', latest.writeId, result.note.rev)
        },
      })
      state.edit('note-1', { rev: 1, content: 'a' })
      await vi.advanceTimersByTimeAsync(40)
      state.edit('note-1', { rev: 1, content: 'ab' })
      first.resolve(savedResult('', 'a', 2))
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(100)

      expect(sent).toEqual([1, 2])
      expect(state.stateById.get('note-1')).toBe('synced')
    } finally {
      vi.useRealTimers()
    }
  })
})
