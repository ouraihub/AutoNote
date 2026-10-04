import { SvelteMap } from 'svelte/reactivity'
import type { NoteWriteResult } from '@shared/backend-types'
import { isBackendError, type Backend, type ChangeEvent } from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { Note, NoteSummary, PatchNoteBody, SyncResponse } from '@shared/types'
import { mergeSync, EMPTY_SYNC_SHELL, type LocalNoteStates, type SyncShell } from './merge'
import { NoteWriteState, type NoteSaveState, type PendingContentWrite } from './note-writes'
import type { WorkspacePane } from './layout-prefs'
import type { OrganizeSnapshot } from './mutations'

export interface NotesStateOptions {
  readonly backend: Backend
  readonly logger: Logger
  readonly debounceMs?: number
}

export interface NotePaneSnapshot {
  readonly primary: string | null
  readonly secondary: string | null
}

export type NoteLoadErrors = Readonly<Record<string, string>>
export type NoteSaveStates = Readonly<Record<string, NoteSaveState>>
export type DirtyNotes = Readonly<Record<string, true>>

export class NotesState {
  #summaries = $state.raw<Record<string, NoteSummary>>({})
  #contents = $state.raw<Record<string, string>>({})
  #loadErrors = $state.raw<Record<string, string>>({})
  #saveState = $state.raw<Record<string, NoteSaveState>>({})
  #dirtyById = $state.raw<Record<string, true>>({})
  #panes = $state.raw<NotePaneSnapshot>({ primary: null, secondary: null })
  #cursor = $state(0)
  #hydrated = $state(false)
  #libraryGeneration = 0

  readonly #backend: Backend
  readonly #logger: Logger
  readonly #write: NoteWriteState
  readonly #generation: Record<WorkspacePane, number> = { primary: 0, secondary: 0 }
  readonly #writeIds: Record<string, string> = {}
  #unsubscribe: (() => void) | null = null
  #tombstones: Record<string, number | null> = {}
  #shell: SyncShell = EMPTY_SYNC_SHELL
  #disposed = false

  constructor(options: NotesStateOptions) {
    this.#backend = options.backend
    this.#logger = options.logger
    this.#write = new NoteWriteState({
      port: options.backend.notes,
      kind: options.backend.kind,
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
      onResult: (result, submitted) => this.#settleWrite(result, submitted),
      onError: (error, submitted) => this.#failWrite(error, submitted),
      onStateChange: (noteId, state) => this.#setSaveState(noteId, state),
    })
  }

  get summaries(): Readonly<Record<string, NoteSummary>> {
    return this.#summaries
  }

  get contents(): Readonly<Record<string, string>> {
    return this.#contents
  }

  get loadErrors(): NoteLoadErrors {
    return this.#loadErrors
  }

  get saveState(): NoteSaveStates {
    return this.#saveState
  }

  get dirtyById(): DirtyNotes {
    return this.#dirtyById
  }

  get cursor(): number {
    return this.#cursor
  }

  get hydrated(): boolean {
    return this.#hydrated
  }

  get panes(): NotePaneSnapshot {
    return this.#panes
  }

  get contentCount(): number {
    return Object.keys(this.#contents).length
  }

  async bootstrap(): Promise<void> {
    this.#assertActive()
    const libraryGeneration = this.#libraryGeneration
    try {
      const payload = await this.#backend.notes.snapshot()
      if (this.#disposed || libraryGeneration !== this.#libraryGeneration) return
      this.applySync(payload)
      this.#hydrated = true
    } catch (error) {
      if (!isBackendError(error)) throw error
      if (error.code === 'cancelled') return
      this.#logger.warn('notes.bootstrap.failed', { code: error.code })
    }
  }

  async open(id: string, pane: WorkspacePane = 'primary'): Promise<void> {
    this.#assertActive()
    const generation = ++this.#generation[pane]
    const libraryGeneration = this.#libraryGeneration
    this.#panes = { ...this.#panes, [pane]: id }
    this.#clearLoadError(id)
    try {
      const note = await this.#backend.notes.get(id)
      if (
        generation !== this.#generation[pane] ||
        libraryGeneration !== this.#libraryGeneration ||
        this.#panes[pane] !== id ||
        this.#disposed
      )
        return
      const pending = this.#write.get(id)
      this.#adoptLoadedNote(note, pending)
    } catch (error) {
      if (
        generation !== this.#generation[pane] ||
        libraryGeneration !== this.#libraryGeneration ||
        this.#panes[pane] !== id ||
        this.#disposed
      )
        return
      if (!isBackendError(error)) throw error
      if (error.code === 'cancelled') return
      this.#loadErrors = { ...this.#loadErrors, [id]: error.code }
      this.#logger.warn('notes.open.failed', { code: error.code })
    }
  }

  async openNote(id: string, pane: WorkspacePane = 'primary'): Promise<void> {
    await this.open(id, pane)
  }

  editContent(id: string, content: string): void {
    const summary = this.#summaries[id]
    if (!summary || this.#contents[id] === content) return
    const current = this.#write.get(id)
    const title = current?.body.title
    const body: PatchNoteBody = { rev: summary.rev, content, ...(title === undefined ? {} : { title }) }
    const writeId = this.#write.edit(id, body)
    this.#writeIds[id] = writeId
    this.#contents = { ...this.#contents, [id]: content }
    this.#dirtyById = { ...this.#dirtyById, [id]: true }
  }

  editTitle(id: string, title: string): void {
    const summary = this.#summaries[id]
    const content = this.#contents[id]
    if (!summary || content === undefined || summary.title === title) return
    const body: PatchNoteBody = { rev: summary.rev, content, title }
    const writeId = this.#write.edit(id, body)
    this.#writeIds[id] = writeId
    this.#summaries = { ...this.#summaries, [id]: { ...summary, title } }
    this.#dirtyById = { ...this.#dirtyById, [id]: true }
  }

  async flush(noteId?: string): Promise<{ pending: number; failed: number }> {
    this.#assertActive()
    return this.#write.flush(noteId)
  }
  async reset(): Promise<void> {
    const result = await this.flush()
    if (result.failed !== 0 || result.pending !== 0) {
      throw new Error('Note body is not safely persisted')
    }
    this.#libraryGeneration++
    this.#generation.primary++
    this.#generation.secondary++
    this.#write.dispose()
    this.#shell = EMPTY_SYNC_SHELL
    this.#summaries = {}
    this.#contents = {}
    this.#loadErrors = {}
    this.#saveState = {}
    this.#dirtyById = {}
    this.#tombstones = {}
    for (const id of Object.keys(this.#writeIds)) delete this.#writeIds[id]
    this.#panes = { primary: null, secondary: null }
    this.#cursor = 0
    this.#hydrated = false
  }

  async create(body: { id?: string; title?: string; content?: string; folderId?: string | null }): Promise<Note> {
    const note = await this.#backend.notes.create(body)
    this.#adoptSavedNote(note)
    return note
  }

  async patch(id: string, patch: PatchNoteBody): Promise<void> {
    const summary = this.#summaries[id]
    if (!summary) return
    const result = await this.#backend.notes.patch(id, patch, { writeId: this.#newWriteId() })
    if (result.queued) return
    this.#adoptSavedNote(result.note)
  }

  async remove(id: string): Promise<void> {
    await this.#flushSafely(id)
    const note = await this.#backend.notes.remove(id)
    this.#adoptSavedNote(note)
  }

  async restore(id: string): Promise<void> {
    await this.#flushSafely(id)
    const note = await this.#backend.notes.restore(id)
    this.#adoptSavedNote(note)
  }

  async purge(id: string): Promise<void> {
    await this.#flushSafely(id)
    const result = await this.#backend.notes.purge(id)
    this.#cursor = Math.max(this.#cursor, result.cursor)
    this.#tombstones = { ...this.#tombstones, [id]: result.cursor }
    this.#forget(id)
  }

  async duplicate(id: string): Promise<Note> {
    const note = await this.#backend.notes.duplicate(id)
    this.#adoptSavedNote(note)
    return note
  }

  async #flushSafely(noteId: string): Promise<void> {
    const result = await this.flush(noteId)
    if (result.pending !== 0 || result.failed !== 0) {
      throw new Error('Note body is not safely persisted')
    }
  }

  readOrganizeSnapshot(): OrganizeSnapshot {
    return {
      folders: this.#shell.folders,
      tags: this.#shell.tags,
      notes: this.#summaries,
      contents: this.#contents,
    }
  }

  writeOrganizePatch(patch: Partial<OrganizeSnapshot>): void {
    this.#assertActive()
    if (patch.notes !== undefined) this.#summaries = { ...patch.notes }
    if (patch.contents !== undefined) this.#contents = { ...patch.contents }
    this.#shell = {
      ...this.#shell,
      notes: this.#summaries,
      folders: patch.folders ?? this.#shell.folders,
      tags: patch.tags ?? this.#shell.tags,
    }
  }

  applySync(payload: SyncResponse): void {
    this.#assertActive()
    const dirty: LocalNoteStates = new SvelteMap(
      Object.entries(this.#dirtyById).map(([id]) => {
        const pending = this.#write.get(id)
        return [
          id,
          pending?.body.content === undefined
            ? { kind: 'pending' as const }
            : { kind: 'content' as const, baseRev: pending.body.rev },
        ]
      }),
    )
    const merged = mergeSync(this.#shell, payload, dirty, new SvelteMap(Object.entries(this.#tombstones)))
    this.#shell = merged.shell
    this.#cursor = merged.shell.cursor
    this.#summaries = merged.shell.notes
    this.#tombstones = Object.fromEntries(merged.tombstones)
    for (const id of merged.removedIds) {
      if (!this.#dirtyById[id]) this.#forget(id)
    }
  }

  watch(): () => void {
    this.#unsubscribe?.()
    this.#unsubscribe = this.#backend.changes.subscribe((event) => this.#handleChange(event))
    return () => {
      this.#unsubscribe?.()
      this.#unsubscribe = null
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#unsubscribe?.()
    this.#unsubscribe = null
    this.#write.dispose()
  }

  #handleChange(event: ChangeEvent): void {
    if (event.kind === 'write') {
      if (event.payload.kind !== 'pending') {
        const currentWriteId = this.#writeIds[event.payload.noteId]
        if (currentWriteId !== event.payload.writeId) return
      }
      this.#write.handle(event.payload)
      if (event.payload.kind === 'recovered') this.#adoptRecovered(event.payload.copy)
      return
    }
    if (event.kind === 'sync' || event.kind === 'library') this.applySync(event.payload)
  }
  #settleWrite(result: NoteWriteResult, submitted: PendingContentWrite): void {
    if (this.#writeIds[submitted.noteId] !== submitted.writeId) return
    if (result.queued) {
      this.#setSaveState(submitted.noteId, 'saved-local')
      return
    }
    this.#adoptSavedNote(result.note)
    delete this.#dirtyById[submitted.noteId]
    this.#dirtyById = { ...this.#dirtyById }
    delete this.#writeIds[submitted.noteId]
  }

  #failWrite(error: unknown, submitted: PendingContentWrite): void {
    if (this.#writeIds[submitted.noteId] !== submitted.writeId) return
    this.#setSaveState(submitted.noteId, 'failed')
    if (isBackendError(error)) this.#logger.warn('notes.save.failed', { code: error.code })
    else this.#logger.error('notes.save.failed', { name: error instanceof Error ? error.name : 'unknown' })
  }

  #adoptLoadedNote(note: Note, pending: PendingContentWrite | null): void {
    const content = pending?.body.content ?? note.content
    const title = pending?.body.title ?? note.title
    this.#summaries = { ...this.#summaries, [note.id]: { ...note, title } }
    this.#contents = { ...this.#contents, [note.id]: content }
    delete this.#loadErrors[note.id]
    this.#loadErrors = { ...this.#loadErrors }
  }

  #adoptSavedNote(note: Note): void {
    this.#summaries = { ...this.#summaries, [note.id]: { ...note } }
    this.#contents = { ...this.#contents, [note.id]: note.content }
    delete this.#dirtyById[note.id]
    delete this.#writeIds[note.id]
    this.#dirtyById = { ...this.#dirtyById }
    this.#saveState = { ...this.#saveState, [note.id]: 'synced' }
    this.#shell = { ...this.#shell, notes: this.#summaries }
  }

  #adoptRecovered(note: Note): void {
    this.#adoptSavedNote(note)
    this.#saveState = { ...this.#saveState, [note.id]: 'recovered' }
  }

  #setSaveState(noteId: string, state: NoteSaveState): void {
    this.#saveState = { ...this.#saveState, [noteId]: state }
    if (state === 'dirty' || state === 'persisting' || state === 'failed' || state === 'saved-local') {
      this.#dirtyById = { ...this.#dirtyById, [noteId]: true }
      return
    }
    if (state === 'synced' || state === 'recovered') {
      const dirty = { ...this.#dirtyById }
      delete dirty[noteId]
      this.#dirtyById = dirty
    }
  }

  #clearLoadError(id: string): void {
    if (!this.#loadErrors[id]) return
    delete this.#loadErrors[id]
    this.#loadErrors = { ...this.#loadErrors }
  }

  #forget(id: string): void {
    const summaries = { ...this.#summaries }
    const contents = { ...this.#contents }
    delete summaries[id]
    delete contents[id]
    this.#summaries = summaries
    this.#contents = contents
    delete this.#dirtyById[id]
    delete this.#writeIds[id]
    this.#dirtyById = { ...this.#dirtyById }
  }

  #newWriteId(): string {
    return crypto.randomUUID()
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('NotesState is disposed')
  }
}
