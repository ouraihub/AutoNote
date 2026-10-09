import { describe, expect, test, vi } from 'vitest'
import type { NoteWriteResult } from '@shared/backend-types'
import type { Note, PatchNoteBody, SyncResponse } from '@shared/types'
import { ChangeFeedEmitter, type Backend } from '@app/backend'
import type { Logger } from '@app/log/logger'
import { BackendError } from '@app/backend'
const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} }
import { NotesState } from './notes.svelte'

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

function makeNote(id: string, content: string, rev = 1): Note {
  return {
    id,
    title: id,
    excerpt: content,
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: content.length,
    charCount: content.length,
    rev,
    position: 1,
    createdAt: 1,
    updatedAt: rev,
    deletedAt: null,
    content,
  }
}

const emptySnapshot: SyncResponse = {
  cursor: 0,
  full: true,
  hasMore: false,
  nextKey: null,
  facetsFull: true,
  settingsChanged: false,
  profileChanged: false,
  siteChanged: false,
  notes: [],
  folders: [],
  tags: [],
  deletions: [],
  serverTime: 1,
}

function backendWithNotes(notes: { get(id: string): Promise<Note>; patch: Backend['notes']['patch'] }): Backend {
  return {
    kind: 'desktop',
    capabilities: {} as Backend['capabilities'],
    notes: {
      snapshot: async () => emptySnapshot,
      ...notes,
      flush: async () => ({ pending: 0, failed: 0 }),
    } as Backend['notes'],
    changes: new ChangeFeedEmitter(),
  } as unknown as Backend
}

describe('NotesState', () => {
  test('does not let an old open response replace a newer pane selection', async () => {
    const first = deferred<Note>()
    const second = deferred<Note>()
    const backend = backendWithNotes({
      get: (id) => (id === 'first' ? first.promise : second.promise),
      patch: async () => ({ queued: false, writeId: 'unused', note: makeNote('unused', '') }),
    })
    const state = new NotesState({ backend, logger })
    const openingFirst = state.open('first')
    const openingSecond = state.open('second')
    second.resolve(makeNote('second', 'new'))
    await openingSecond
    first.resolve(makeNote('first', 'old'))
    await openingFirst
    expect(state.panes.primary).toBe('second')
    expect(state.contents).toEqual({ second: 'new' })
  })

  test('keeps edited text when local persistence fails', async () => {
    const pending = deferred<NoteWriteResult>()
    const backend = backendWithNotes({
      get: async () => makeNote('note', 'base'),
      patch: async () => pending.promise,
    })
    const state = new NotesState({ backend, logger, debounceMs: 0 })
    await state.open('note')
    state.editContent('note', 'retained')
    pending.reject(new BackendError('internal', 0, 'persistence failed'))
    await state.flush('note')
    expect(state.contents.note).toBe('retained')
    expect(state.dirtyById.note).toBe(true)
    expect(state.saveState.note).toBe('failed')
  })

  test('a new state reads the persisted body after reopening', async () => {
    let stored = makeNote('note', 'base')
    const backend = backendWithNotes({
      get: async () => ({ ...stored }),
      patch: async (_id, body, options) => {
        stored = makeNote('note', body.content ?? stored.content, stored.rev + 1)
        return { queued: false, writeId: options.writeId, note: stored }
      },
    })
    const first = new NotesState({ backend, logger })
    await first.open('note')
    first.editContent('note', 'persisted edit')
    await first.flush('note')
    first.dispose()

    const restarted = new NotesState({ backend, logger })
    await restarted.open('note')
    expect(restarted.contents.note).toBe('persisted edit')
  })

  test('keeps a purged note absent when an older sync arrives', async () => {
    let purgeCursor = 0
    const backend = backendWithNotes({
      get: async () => makeNote('note', 'body'),
      patch: async (_id, body, options) => ({
        queued: false,
        writeId: options.writeId,
        note: makeNote('note', body.content ?? 'body', 2),
      }),
    })
    backend.notes.purge = async () => ({ ok: true, cursor: ++purgeCursor })
    const feed = backend.changes as ChangeFeedEmitter
    const state = new NotesState({ backend, logger })
    await state.open('note')
    await state.purge('note')
    feed.emit({ kind: 'sync', payload: { ...emptySnapshot, cursor: 0, notes: [makeNote('note', 'old')] } })
    expect(state.summaries.note).toBeUndefined()
  })

  test('does not run destructive action after body persistence fails', async () => {
    const pending = deferred<NoteWriteResult>()
    let removeCalls = 0
    const backend = backendWithNotes({
      get: async () => makeNote('note', 'body'),
      patch: async () => pending.promise,
    })
    backend.notes.remove = async () => {
      removeCalls++
      return makeNote('note', 'body')
    }
    const state = new NotesState({ backend, logger, debounceMs: 0 })
    await state.open('note')
    state.editContent('note', 'unsafe')
    pending.reject(new BackendError('internal', 0, 'disk failed'))
    await expect(state.remove('note')).rejects.toThrow('safely persisted')
    expect(removeCalls).toBe(0)
    expect(state.contents.note).toBe('unsafe')
  })

  test('ignores a settled event for an older write id', async () => {
    const backend = backendWithNotes({
      get: async () => makeNote('note', 'base'),
      patch: async () => new Promise<NoteWriteResult>(() => {}),
    })
    const feed = backend.changes as ChangeFeedEmitter
    const state = new NotesState({ backend, logger, debounceMs: 10_000 })
    await state.open('note')
    state.watch()
    state.editContent('note', 'newer text')
    feed.emit({
      kind: 'write',
      payload: { kind: 'settled', writeId: 'older-write', noteId: 'note', note: makeNote('note', 'old', 2) },
    })
    expect(state.contents.note).toBe('newer text')
    expect(state.dirtyById.note).toBe(true)
    state.dispose()
  })

  test('an edit typed while an earlier save is in flight saves on the new revision', async () => {
    let stored = makeNote('note', 'base')
    const firstSave = deferred<NoteWriteResult>()
    const bodies: PatchNoteBody[] = []
    const backend = backendWithNotes({
      get: async () => ({ ...stored }),
      patch: async (_id, body, options) => {
        bodies.push(body)
        if (body.rev !== stored.rev) throw new BackendError('conflict', 409, 'stale revision')
        const save = (): NoteWriteResult => {
          stored = { ...stored, content: body.content ?? stored.content, rev: stored.rev + 1 }
          return { queued: false, writeId: options.writeId, note: { ...stored } }
        }
        if (bodies.length === 1) return firstSave.promise.then(save)
        return save()
      },
    })
    const state = new NotesState({ backend, logger, debounceMs: 0 })
    await state.open('note')
    state.editContent('note', 'first')
    await vi.waitFor(() => expect(bodies).toHaveLength(1))
    state.editContent('note', 'first and second')
    firstSave.resolve({ queued: false, writeId: '', note: stored })
    await state.flush('note')
    expect(bodies.map((body) => body.rev)).toEqual([1, 2])
    expect(stored).toMatchObject({ content: 'first and second', rev: 3 })
    expect(state.saveState.note).not.toBe('failed')
    state.dispose()
  })

  test('reset discards the previous account and ignores a late open response', async () => {
    const oldOpen = deferred<Note>()
    const backend = backendWithNotes({
      get: (id) => (id === 'old' ? oldOpen.promise : Promise.resolve(makeNote('new', 'new account'))),
      patch: async () => ({ queued: false, writeId: 'unused', note: makeNote('unused', '') }),
    })
    const state = new NotesState({ backend, logger })
    const opening = state.open('old')
    await state.reset()
    await state.open('new')
    oldOpen.resolve(makeNote('old', 'previous account'))
    await opening
    expect(state.summaries.old).toBeUndefined()
    expect(state.contents.old).toBeUndefined()
    expect(state.contents.new).toBe('new account')
  })

  test('reset refuses to discard an unpersisted body', async () => {
    const pending = deferred<NoteWriteResult>()
    const backend = backendWithNotes({
      get: async () => makeNote('old', 'original'),
      patch: async () => pending.promise,
    })
    const state = new NotesState({ backend, logger })
    await state.open('old')
    state.editContent('old', 'unsaved')
    pending.reject(new BackendError('internal', 0, 'disk failed'))
    await expect(state.reset()).rejects.toThrow('safely persisted')
    expect(state.contents.old).toBe('unsaved')
  })
})
