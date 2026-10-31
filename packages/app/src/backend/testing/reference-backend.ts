import type { NoteWriteResult, SettingsPatch } from '@shared/backend-types'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  mergeSettingsPatch,
} from '@shared/constants'
import { countText, deriveExcerpt, extractTags } from '@shared/markdown-utils'
import type {
  Attachment,
  CreateNoteBody,
  Folder,
  ListNotesQuery,
  ListNotesResponse,
  Note,
  NoteVersion,
  PatchNoteBody,
  SyncResponse,
  Tag,
  UserSettings,
} from '@shared/types'
import type {
  BackendContractFixture,
  ContractBackend,
  ContractLibrary,
  WriteConflictMode,
} from '../contract'
import { BackendError } from '../errors'

export type ReferenceFault =
  | 'mutate-source-on-read'
  | 'accept-stale-revision'
  | 'drop-version-history'
  | 'restore-keeps-deletion'
  | 'purge-leaves-note'
  | 'drop-tombstone'
  | 'ignore-folder-filter'
  | 'corrupt-attachment-bytes'
  | 'forget-settings-on-reopen'

export interface ReferenceFixtureOptions {
  readonly mode: WriteConflictMode
  readonly faults?: readonly ReferenceFault[]
}

export function referenceFixture(
  options: ReferenceFixtureOptions,
): BackendContractFixture {
  const faults = new Set(options.faults ?? [])
  return {
    writeConflictMode: options.mode,
    createLibrary: async () => new ReferenceLibrary(options.mode, faults),
  }
}

interface StoredFile {
  readonly attachment: Attachment
  readonly bytes: Uint8Array
}

interface QueuedWrite {
  readonly noteId: string
  readonly content: string
}

class ReferenceStore {
  readonly notes = new Map<string, Note>()
  readonly versions = new Map<string, NoteVersion[]>()
  readonly tombstones = new Map<string, number>()
  readonly folders = new Map<string, Folder>()
  readonly manualTags = new Map<string, Tag>()
  readonly files = new Map<string, StoredFile>()
  settings: UserSettings = mergeSettings(DEFAULT_SETTINGS)
  cursor = 0
  #sequence = 0

  nextId(): string {
    this.#sequence += 1
    return String(this.#sequence).padStart(26, '0')
  }

  now(): number {
    this.#sequence += 1
    return 1_700_000_000_000 + this.#sequence
  }
}

class ReferenceLibrary implements ContractLibrary<ReferenceBackend> {
  readonly #store = new ReferenceStore()
  readonly #mode: WriteConflictMode
  readonly #faults: ReadonlySet<ReferenceFault>

  constructor(mode: WriteConflictMode, faults: ReadonlySet<ReferenceFault>) {
    this.#mode = mode
    this.#faults = faults
  }

  async open(): Promise<ReferenceBackend> {
    return new ReferenceBackend(this.#store, this.#mode, this.#faults)
  }

  async readAttachment(
    _backend: ReferenceBackend,
    attachment: Attachment,
  ): Promise<Uint8Array> {
    const stored = this.#store.files.get(attachment.id)
    if (!stored)
      throw new BackendError('not_found', 404, 'Attachment not found')
    return Uint8Array.from(stored.bytes)
  }

  async dispose(): Promise<void> {
    this.#store.notes.clear()
    this.#store.files.clear()
  }
}

class ReferenceBackend implements ContractBackend {
  readonly #store: ReferenceStore
  readonly #mode: WriteConflictMode
  readonly #faults: ReadonlySet<ReferenceFault>
  readonly #queue: QueuedWrite[] = []
  #sessionSettings: UserSettings | null = null

  constructor(
    store: ReferenceStore,
    mode: WriteConflictMode,
    faults: ReadonlySet<ReferenceFault>,
  ) {
    this.#store = store
    this.#mode = mode
    this.#faults = faults
  }

  readonly notes: ContractBackend['notes'] = {
    snapshot: async () => this.#snapshot(),
    list: async (query) => this.#list(query),
    get: async (id) => {
      const note = this.#find(id)
      return this.#faults.has('mutate-source-on-read')
        ? { ...note, content: note.content.trimEnd() }
        : { ...note }
    },
    create: async (body) => this.#create(body),
    patch: async (id, body, options) => this.#patch(id, body, options.writeId),
    remove: async (id) => {
      const note = this.#find(id)
      if (note.deletedAt !== null)
        throw new BackendError(
          'not_found',
          404,
          'The note is already in the trash',
        )
      const now = this.#store.now()
      return this.#save({
        ...note,
        deletedAt: now,
        updatedAt: now,
        rev: note.rev + 1,
      })
    },
    restore: async (id) => {
      const note = this.#find(id)
      if (note.deletedAt === null)
        throw new BackendError(
          'bad_request',
          400,
          'The note is not in the trash',
        )
      const deletedAt = this.#faults.has('restore-keeps-deletion')
        ? note.deletedAt
        : null
      return this.#save({
        ...note,
        deletedAt,
        updatedAt: this.#store.now(),
        rev: note.rev + 1,
      })
    },
    purge: async (id) => {
      const note = this.#find(id)
      if (note.deletedAt === null)
        throw new BackendError('not_found', 404, 'The note is not in the trash')
      return { ok: true, cursor: this.#purge(id) }
    },
    emptyTrash: async () => {
      const trashed = [...this.#store.notes.values()].filter(
        (note) => note.deletedAt !== null,
      )
      for (const note of trashed) this.#purge(note.id)
      return { purged: trashed.length }
    },
    versions: async (id) => {
      this.#find(id)
      return (this.#store.versions.get(id) ?? [])
        .map(({ content: _content, ...meta }) => {
          void _content
          return meta
        })
        .reverse()
    },
    version: async (id, versionId) => {
      const version = this.#store.versions
        .get(id)
        ?.find((item) => item.id === versionId)
      if (!version)
        throw new BackendError('not_found', 404, 'Version not found')
      return { ...version }
    },
    flush: async (noteId) => {
      const pending = this.#queue.splice(0)
      for (const write of pending) {
        if (noteId !== undefined && write.noteId !== noteId) {
          this.#queue.push(write)
          continue
        }
        const current = this.#find(write.noteId)
        this.#applyText(current, current.rev, write.content)
      }
      return { pending: this.#queue.length, failed: 0 }
    },
  }

  readonly folders: ContractBackend['folders'] = {
    list: async () =>
      [...this.#store.folders.values()].map((folder) => ({ ...folder })),
    create: async (body) => {
      const now = this.#store.now()
      const folder: Folder = {
        id: body.id ?? this.#store.nextId(),
        parentId: body.parentId ?? null,
        name: body.name ?? 'Untitled folder',
        icon: body.icon ?? null,
        color: body.color ?? null,
        position: now,
        createdAt: now,
        updatedAt: now,
      }
      this.#store.folders.set(folder.id, folder)
      return { ...folder }
    },
  }

  readonly tags: ContractBackend['tags'] = {
    list: async () => this.#tags(),
    create: async (body) => {
      const tag: Tag = {
        id: body.id ?? this.#store.nextId(),
        name: body.name,
        color: body.color ?? null,
        count: 0,
        createdAt: this.#store.now(),
      }
      this.#store.manualTags.set(tag.name.toLowerCase(), tag)
      return { ...tag }
    },
  }

  readonly files: ContractBackend['files'] = {
    list: async () => ({
      files: [...this.#store.files.values()].map(({ attachment }) => ({
        ...attachment,
        references: 0,
      })),
      nextCursor: null,
    }),
    upload: async (file, noteId) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const stored = this.#faults.has('corrupt-attachment-bytes')
        ? bytes.map((byte, index) => (index === 0 ? byte ^ 1 : byte))
        : bytes
      const id = this.#store.nextId()
      const attachment: Attachment = {
        id,
        noteId: noteId ?? null,
        filename: file.name,
        mime: file.type || 'application/octet-stream',
        size: bytes.byteLength,
        width: null,
        height: null,
        url: `/api/files/${id}`,
        createdAt: this.#store.now(),
      }
      this.#store.files.set(id, { attachment, bytes: stored })
      return { ...attachment }
    },
  }

  readonly settings: ContractBackend['settings'] = {
    get: async () =>
      mergeSettings(this.#sessionSettings ?? this.#store.settings),
    save: async (patch: SettingsPatch) => {
      const next = mergeSettingsPatch(
        this.#sessionSettings ?? this.#store.settings,
        patch,
      )
      if (this.#faults.has('forget-settings-on-reopen'))
        this.#sessionSettings = next
      else this.#store.settings = next
      return mergeSettings(next)
    },
  }

  async dispose(): Promise<void> {
    this.#queue.length = 0
  }

  #find(id: string): Note {
    const note = this.#store.notes.get(id)
    if (note) return note
    const deletionCursor = this.#store.tombstones.get(id)
    throw new BackendError(
      'not_found',
      404,
      'Note not found',
      deletionCursor === undefined ? undefined : { deletionCursor },
    )
  }

  #save(note: Note): Note {
    this.#store.notes.set(note.id, note)
    this.#store.cursor += 1
    return { ...note }
  }

  #create(body: CreateNoteBody): Note {
    const existing =
      body.id === undefined ? undefined : this.#store.notes.get(body.id)
    if (existing) return { ...existing }
    if (body.folderId && !this.#store.folders.has(body.folderId)) {
      throw new BackendError('not_found', 404, 'Folder not found')
    }
    const now = this.#store.now()
    const content = body.content ?? ''
    return this.#save({
      ...derivedText(content),
      id: body.id ?? this.#store.nextId(),
      title: body.title?.trim() || 'Untitled note',
      folderId: body.folderId ?? null,
      isPinned: false,
      isStarred: body.isStarred ?? false,
      isArchived: false,
      rev: 1,
      position: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })
  }

  #patch(id: string, body: PatchNoteBody, writeId: string): NoteWriteResult {
    const current = this.#find(id)
    if (this.#mode === 'rebase' && body.content !== undefined) {
      this.#queue.push({ noteId: id, content: body.content })
      return { queued: true, writeId, noteId: id, rev: body.rev }
    }
    if (
      body.rev !== current.rev &&
      !this.#faults.has('accept-stale-revision')
    ) {
      throw new BackendError(
        'conflict',
        409,
        'This note was modified elsewhere',
        { server: { ...current } },
      )
    }
    const note =
      body.content === undefined
        ? { ...current }
        : this.#applyText(current, current.rev, body.content)
    return { queued: false, writeId, note }
  }

  #applyText(current: Note, rev: number, content: string): Note {
    if (content === current.content) return { ...current }
    if (!this.#faults.has('drop-version-history')) {
      const history = this.#store.versions.get(current.id) ?? []
      history.push({
        id: this.#store.nextId(),
        noteId: current.id,
        title: current.title,
        content: current.content,
        size: new TextEncoder().encode(current.content).byteLength,
        createdAt: this.#store.now(),
      })
      this.#store.versions.set(current.id, history)
    }
    return this.#save({
      ...current,
      ...derivedText(content),
      rev: rev + 1,
      updatedAt: this.#store.now(),
    })
  }

  #purge(id: string): number {
    this.#store.cursor += 1
    if (this.#faults.has('purge-leaves-note')) return this.#store.cursor
    this.#store.notes.delete(id)
    this.#store.versions.delete(id)
    if (!this.#faults.has('drop-tombstone'))
      this.#store.tombstones.set(id, this.#store.cursor)
    return this.#store.cursor
  }

  #list(query: ListNotesQuery): ListNotesResponse {
    const view = query.view ?? 'all'
    const matches = [...this.#store.notes.values()]
      .filter((note) => {
        if (view === 'trash') return note.deletedAt !== null
        if (
          note.deletedAt !== null ||
          note.isArchived !== (view === 'archived')
        )
          return false
        if (view === 'folder')
          return (
            this.#faults.has('ignore-folder-filter') ||
            note.folderId === query.folderId
          )
        if (view === 'tag')
          return note.tags.some(
            (tag) => tag.toLowerCase() === query.tag?.toLowerCase(),
          )
        if (view === 'unfiled') return note.folderId === null
        if (view === 'starred') return note.isStarred
        return true
      })
      .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
    const offset = query.cursor === undefined ? 0 : Number(query.cursor)
    const limit = query.limit ?? 2
    const page = matches.slice(offset, offset + limit)
    return {
      notes: page.map(({ content: _content, ...summary }) => {
        void _content
        return summary
      }),
      nextCursor:
        offset + limit < matches.length ? String(offset + limit) : null,
      total: matches.length,
    }
  }

  #tags(): Tag[] {
    const tags = new Map(
      [...this.#store.manualTags].map(([key, tag]) => [
        key,
        { ...tag, count: 0 },
      ]),
    )
    for (const note of this.#store.notes.values()) {
      if (note.deletedAt !== null) continue
      for (const name of note.tags) {
        const key = name.toLowerCase()
        const tag = tags.get(key) ?? {
          id: this.#store.nextId(),
          name,
          color: null,
          count: 0,
          createdAt: note.createdAt,
        }
        tags.set(key, { ...tag, count: tag.count + 1 })
      }
    }
    return [...tags.values()]
  }

  #snapshot(): SyncResponse {
    return {
      cursor: this.#store.cursor,
      full: true,
      hasMore: false,
      nextKey: null,
      facetsFull: true,
      settingsChanged: false,
      notes: [...this.#store.notes.values()].map(
        ({ content: _content, ...summary }) => {
          void _content
          return summary
        },
      ),
      folders: [...this.#store.folders.values()],
      tags: this.#tags(),
      deletions: [],
      serverTime: this.#store.now(),
    }
  }
}

function derivedText(
  content: string,
): Pick<Note, 'content' | 'excerpt' | 'tags' | 'wordCount' | 'charCount'> {
  const { words, chars } = countText(content)
  return {
    content,
    excerpt: deriveExcerpt(content),
    tags: extractTags(content),
    wordCount: words,
    charCount: chars,
  }
}
