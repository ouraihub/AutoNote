import type {
  FolderCreate,
  FolderPatch,
  TagCreate,
  TagPatch,
  TagPatchResult,
} from '@shared/backend-types'
import type { Folder, NoteSummary, Tag } from '@shared/types'
import {
  folderSubtreeIds,
  removeFolderAndPromoteChildren,
  replaceById,
  rollbackFields,
  rewriteTags,
  idFromCrypto,
  type OrganizeActionsOptions,
  type OrganizeMutation,
  type OrganizeMutationEntity,
  type OrganizeSnapshot,
  type OrganizeStateAdapter,
} from './mutation-utils'
export type { OrganizeActionsOptions, OrganizeSnapshot } from './mutation-utils'
import { enqueueMutation } from './mutation-queue'

interface ActiveMutation extends OrganizeMutation {
  apply(snapshot: OrganizeSnapshot): Partial<OrganizeSnapshot>
  rollback(snapshot: OrganizeSnapshot): Partial<OrganizeSnapshot>
}

/** Per-entity serialized writes. Optimism is immediate; ACKs only replace
 * fields untouched by later mutations. */
export class OrganizeActions {
  readonly #backend: OrganizeActionsOptions['backend']
  readonly #state: OrganizeStateAdapter
  readonly #notifier: OrganizeActionsOptions['notifier']
  readonly #makeId: () => string
  readonly #now: () => number
  readonly #tails = new Map<OrganizeMutationEntity, Promise<void>>()
  readonly #pending = new Map<OrganizeMutationEntity, ActiveMutation[]>()
  #folderRefresh = 0
  #tagRefresh = 0

  constructor(options: OrganizeActionsOptions) {
    this.#backend = options.backend
    this.#state = options.state
    this.#notifier = options.notifier
    this.#makeId = options.makeId ?? idFromCrypto
    this.#now = options.now ?? Date.now
  }

  get mutationsByEntity(): ReadonlyMap<
    OrganizeMutationEntity,
    readonly OrganizeMutation[]
  > {
    return this.#pending
  }

  async createFolder(body: FolderCreate = {}): Promise<Folder> {
    const id = body.id ?? this.#makeId()
    const before = this.#state.read()
    const parentId = body.parentId ?? null
    if (
      parentId !== null &&
      !before.folders.some((folder) => folder.id === parentId)
    )
      throw new Error('Folder parent does not exist')
    const now = this.#now()
    const optimistic: Folder = {
      id,
      name: body.name ?? '',
      parentId,
      icon: body.icon ?? null,
      color: body.color ?? null,
      position: (before.folders.length + 1) * 1000,
      createdAt: now,
      updatedAt: now,
      noteCount: 0,
    }
    const mutation = this.#begin(
      `folder:${id}`,
      {},
      { ...body, id },
      (state) => ({ folders: replaceById(state.folders, optimistic) }),
      (state) => ({
        folders: state.folders.filter((folder) => folder.id !== id),
      }),
    )
    return enqueueMutation(
      { tails: this.#tails, pending: this.#pending, state: this.#state },
      mutation,
      () => this.#backend.folders.create({ ...body, id }),
      async (saved) => {
        await this.#adoptFolder(saved)
      },
    )
  }

  async patchFolder(id: string, patch: FolderPatch): Promise<Folder> {
    const before = this.#state.read().folders.find((folder) => folder.id === id)
    if (!before) throw new Error('Folder does not exist')
    if (
      patch.parentId !== undefined &&
      patch.parentId !== null &&
      folderSubtreeIds(this.#state.read().folders, id).has(patch.parentId)
    ) {
      throw new Error('Cannot move a folder into its own subtree')
    }
    const optimistic = { ...before, ...patch, updatedAt: this.#now() }
    const fields = { ...patch, updatedAt: optimistic.updatedAt }
    const mutation = this.#begin(
      `folder:${id}`,
      before,
      fields,
      (state) => ({
        folders: state.folders.map((folder) =>
          folder.id === id ? { ...folder, ...fields } : folder,
        ),
      }),
      (state) => ({
        folders: state.folders.map((folder) =>
          folder.id === id
            ? rollbackFields(folder, before, fields, optimistic)
            : folder,
        ),
      }),
    )
    return enqueueMutation(
      { tails: this.#tails, pending: this.#pending, state: this.#state },
      mutation,
      () => this.#backend.folders.patch(id, patch),
      (saved) => this.#adoptFolder(saved),
    )
  }

  async removeFolder(
    id: string,
    strategy: 'move-up' | 'delete' = 'move-up',
  ): Promise<boolean> {
    const snapshot = this.#state.read()
    const folder = snapshot.folders.find((item) => item.id === id)
    if (!folder) return false
    const subtreeIds = folderSubtreeIds(snapshot.folders, id)
    const approved = await this.#notifier.confirm({
      titleKey: 'folders.delete_title',
      bodyKey:
        strategy === 'move-up'
          ? 'folders.delete_contents_move_up'
          : 'folders.delete_contents_trash',
      params: {
        name: folder.name,
        value0: Object.values(snapshot.notes).filter((note) =>
          strategy === 'move-up'
            ? note.folderId === id
            : subtreeIds.has(note.folderId ?? '') && note.deletedAt === null,
        ).length,
        value1: snapshot.folders.filter((item) => item.parentId === id).length,
      },
      danger: true,
    })
    if (!approved) return false
    const before = this.#state.read()
    const subtree = folderSubtreeIds(before.folders, id)
    await this.#flush(
      Object.values(before.notes)
        .filter((note) => subtree.has(note.folderId ?? ''))
        .map((note) => note.id),
    )
    const now = this.#now()
    const nextFolders =
      strategy === 'move-up'
        ? removeFolderAndPromoteChildren(before.folders, id, now)
        : before.folders.filter((item) => !subtree.has(item.id))
    const nextNotes: Record<string, NoteSummary> = { ...before.notes }
    for (const note of Object.values(before.notes)) {
      if (strategy === 'move-up' && note.folderId === id)
        nextNotes[note.id] = {
          ...note,
          folderId: folder.parentId,
          updatedAt: now,
        }
      if (strategy === 'delete' && subtree.has(note.folderId ?? ''))
        nextNotes[note.id] = {
          ...note,
          folderId: null,
          deletedAt: note.deletedAt ?? now,
          updatedAt: now,
        }
    }
    const mutation = this.#begin(
      `folder:${id}`,
      before,
      { strategy },
      () => ({ folders: nextFolders, notes: nextNotes }),
      (state) => {
        const folders = [...state.folders]
        for (const old of before.folders) {
          if (!folders.some((current) => current.id === old.id))
            folders.push(old)
        }
        const notes = { ...state.notes }
        for (const [noteId, old] of Object.entries(before.notes)) {
          const current = notes[noteId]
          const expected = nextNotes[noteId]
          if (current && expected) {
            const fields =
              strategy === 'delete'
                ? {
                    folderId: null,
                    deletedAt: expected.deletedAt,
                    updatedAt: expected.updatedAt,
                  }
                : { folderId: expected.folderId, updatedAt: expected.updatedAt }
            notes[noteId] = rollbackFields(current, old, fields, expected)
          }
        }
        return { folders, notes }
      },
    )
    await enqueueMutation(
      { tails: this.#tails, pending: this.#pending, state: this.#state },
      mutation,
      () => this.#backend.folders.remove(id, strategy),
      async () => {
        await this.#refreshFolders()
        await this.#refreshNotes()
      },
    )
    return true
  }

  async createTag(body: TagCreate): Promise<Tag> {
    const id = body.id ?? this.#makeId()
    const optimistic: Tag = {
      id,
      name: body.name,
      color: body.color ?? null,
      count: 0,
      createdAt: this.#now(),
    }
    const mutation = this.#begin(
      `tag:${id}`,
      {},
      { ...body, id },
      (state) => ({ tags: replaceById(state.tags, optimistic) }),
      (state) => ({ tags: state.tags.filter((tag) => tag.id !== id) }),
    )
    return enqueueMutation(
      { tails: this.#tails, pending: this.#pending, state: this.#state },
      mutation,
      () => this.#backend.tags.create({ ...body, id }),
      (saved) => this.#adoptTag(saved),
    )
  }

  async patchTag(id: string, patch: TagPatch): Promise<TagPatchResult> {
    const before = this.#state.read()
    const tag = before.tags.find((item) => item.id === id)
    if (!tag) throw new Error('Tag does not exist')
    if (patch.name !== undefined && patch.name !== tag.name)
      await this.#flush(
        Object.values(before.notes)
          .filter((note) => note.tags.includes(tag.name))
          .map((note) => note.id),
      )
    const optimistic = { ...tag, ...patch }
    const rewritten =
      patch.name === undefined || patch.name === tag.name
        ? null
        : rewriteTags(before, tag.name, patch.name)
    const mutation = this.#begin(
      `tag:${id}`,
      tag,
      patch,
      (state) => ({
        tags: replaceById(state.tags, optimistic),
        ...(rewritten ?? {}),
      }),
      (state) => {
        const current = state.tags.find((item) => item.id === id)
        return {
          tags: current
            ? replaceById(
                state.tags,
                rollbackFields(current, tag, patch, optimistic),
              )
            : state.tags,
          ...(rewritten
            ? this.#restoreRewrittenNotes(state, before, rewritten)
            : {}),
        }
      },
    )
    return enqueueMutation(
      { tails: this.#tails, pending: this.#pending, state: this.#state },
      mutation,
      () => this.#backend.tags.patch(id, patch),
      async (result) => {
        if (result.tag) await this.#adoptTag(result.tag)
        await this.#refreshTags()
        if (rewritten || result.renamed > 0) await this.#refreshNotes()
      },
    )
  }

  renameTag(id: string, name: string): Promise<TagPatchResult> {
    return this.patchTag(id, { name })
  }

  async removeTag(id: string): Promise<boolean> {
    const tag = this.#state.read().tags.find((item) => item.id === id)
    if (!tag) return false
    if (
      !(await this.#notifier.confirm({
        titleKey: 'tags.delete_title',
        bodyKey: 'tags.delete_description_value0',
        params: {
          name: tag.name,
          value0: Object.values(this.#state.read().notes).filter(
            (note) =>
              note.tags.includes(tag.name) &&
              note.deletedAt === null &&
              !note.isArchived,
          ).length,
        },
        danger: true,
      }))
    )
      return false
    const before = this.#state.read()
    await this.#flush(
      Object.values(before.notes)
        .filter((note) => note.tags.includes(tag.name))
        .map((note) => note.id),
    )
    const rewritten = rewriteTags(before, tag.name, null)
    const mutation = this.#begin(
      `tag:${id}`,
      before,
      { remove: true },
      (state) => ({
        tags: state.tags.filter((item) => item.id !== id),
        ...rewritten,
      }),
      (state) => ({
        tags: replaceById(state.tags, tag),
        ...this.#restoreRewrittenNotes(state, before, rewritten),
      }),
    )
    await enqueueMutation(
      { tails: this.#tails, pending: this.#pending, state: this.#state },
      mutation,
      () => this.#backend.tags.remove(id),
      async () => {
        await this.#refreshTags()
        await this.#refreshNotes()
      },
    )
    return true
  }

  #restoreRewrittenNotes(
    state: OrganizeSnapshot,
    before: OrganizeSnapshot,
    expected: Pick<OrganizeSnapshot, 'notes' | 'contents'>,
  ): Pick<OrganizeSnapshot, 'notes' | 'contents'> {
    const notes: Record<string, NoteSummary> = { ...state.notes }
    const contents: Record<string, string> = { ...state.contents }
    for (const [id, previous] of Object.entries(before.notes)) {
      const current = notes[id]
      const optimistic = expected.notes[id]
      if (!current || !optimistic || optimistic === previous) continue
      notes[id] = rollbackFields(
        current,
        previous,
        {
          tags: optimistic.tags,
          excerpt: optimistic.excerpt,
          wordCount: optimistic.wordCount,
          charCount: optimistic.charCount,
        },
        optimistic,
      )
      if (
        contents[id] === expected.contents[id] &&
        before.contents[id] !== undefined
      )
        contents[id] = before.contents[id]
    }
    return { notes, contents }
  }

  #begin(
    entity: OrganizeMutationEntity,
    before: object,
    patch: object,
    apply: ActiveMutation['apply'],
    rollback: ActiveMutation['rollback'],
  ): ActiveMutation {
    const mutation: ActiveMutation = {
      mutationId: this.#makeId(),
      entity,
      before,
      patch,
      apply,
      rollback,
    }
    this.#pending.set(entity, [...(this.#pending.get(entity) ?? []), mutation])
    this.#state.write(apply(this.#state.read()))
    return mutation
  }

  #projectPending(): void {
    for (const group of this.#pending.values())
      for (const mutation of group)
        this.#state.write(mutation.apply(this.#state.read()))
  }

  async #adoptFolder(saved: Folder): Promise<void> {
    const current = this.#state
      .read()
      .folders.find((folder) => folder.id === saved.id)
    const later = this.#pending.get(`folder:${saved.id}`) ?? []
    const fields = new Set(
      later.flatMap((mutation) => Object.keys(mutation.patch)),
    )
    const retained = current
      ? Object.fromEntries(
          [...fields].map((key) => [key, current[key as keyof Folder]]),
        )
      : {}
    this.#state.write({
      folders: replaceById(this.#state.read().folders, {
        ...saved,
        ...retained,
      }),
    })
    await this.#refreshFolders()
  }

  async #adoptTag(saved: Tag): Promise<void> {
    const current = this.#state.read().tags.find((tag) => tag.id === saved.id)
    const later = this.#pending.get(`tag:${saved.id}`) ?? []
    const fields = new Set(
      later.flatMap((mutation) => Object.keys(mutation.patch)),
    )
    const retained = current
      ? Object.fromEntries(
          [...fields].map((key) => [key, current[key as keyof Tag]]),
        )
      : {}
    this.#state.write({
      tags: replaceById(this.#state.read().tags, { ...saved, ...retained }),
    })
  }

  async #refreshFolders(): Promise<void> {
    const sequence = ++this.#folderRefresh
    const folders = await this.#backend.folders.list()
    if (sequence !== this.#folderRefresh) return
    this.#state.write({ folders })
    this.#projectPending()
  }

  async #refreshTags(): Promise<void> {
    const sequence = ++this.#tagRefresh
    const tags = await this.#backend.tags.list()
    if (sequence !== this.#tagRefresh) return
    this.#state.write({ tags })
    this.#projectPending()
  }

  async #refreshNotes(): Promise<void> {
    const snapshot = await this.#backend.notes.snapshot()
    const current = this.#state.read()
    const notes = { ...current.notes }
    for (const note of snapshot.notes) notes[note.id] = note
    this.#state.write({ notes })
    this.#projectPending()
  }

  async #flush(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const result = await this.#backend.notes.flush(id)
      if (result.pending !== 0 || result.failed !== 0)
        throw new Error('Note body is not safely persisted')
    }
  }
}
