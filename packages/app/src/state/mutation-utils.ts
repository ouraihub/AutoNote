import {
  countText,
  deriveExcerpt,
  extractTags,
  replaceTagInContent,
  sortTagNames,
} from '@shared/markdown-utils'
import type { Folder, NoteSummary, Tag } from '@shared/types'
import type { Backend } from '../backend'
import type { Notifier } from '../platform'

export interface OrganizeSnapshot {
  readonly folders: readonly Folder[]
  readonly tags: readonly Tag[]
  readonly notes: Readonly<Record<string, NoteSummary>>
  readonly contents: Readonly<Record<string, string>>
}

/** S7-1 bridges this to NotesState; this module never imports a host or
 * mutates its private fields. */
export interface OrganizeStateAdapter {
  read(): OrganizeSnapshot
  write(patch: Partial<OrganizeSnapshot>): void
}

export interface OrganizeActionsOptions {
  backend: Pick<Backend, 'folders' | 'tags' | 'notes'>
  state: OrganizeStateAdapter
  notifier: Pick<Notifier, 'confirm'>
  makeId?: () => string
  now?: () => number
}

export type OrganizeMutationEntity = `folder:${string}` | `tag:${string}`
export interface OrganizeMutation {
  readonly mutationId: string
  readonly entity: OrganizeMutationEntity
  readonly before: object
  readonly patch: object
}

export function folderSubtreeIds(
  folders: readonly Folder[],
  rootId: string,
): Set<string> {
  const children = new Map<string, string[]>()
  for (const folder of folders) {
    if (folder.parentId === null) continue
    const siblings = children.get(folder.parentId) ?? []
    siblings.push(folder.id)
    children.set(folder.parentId, siblings)
  }
  const result = new Set<string>()
  const pending = [rootId]
  while (pending.length > 0) {
    const id = pending.pop()
    if (id === undefined || result.has(id)) continue
    result.add(id)
    pending.push(...(children.get(id) ?? []))
  }
  return result
}

export function removeFolderAndPromoteChildren(
  folders: readonly Folder[],
  id: string,
  now: number,
): Folder[] {
  const removed = folders.find((folder) => folder.id === id)
  if (!removed) return [...folders]
  const compare = (left: Folder, right: Folder) =>
    left.position - right.position ||
    left.createdAt - right.createdAt ||
    left.id.localeCompare(right.id)
  const siblings = folders
    .filter((folder) => folder.parentId === removed.parentId)
    .sort(compare)
  const children = folders
    .filter((folder) => folder.parentId === id)
    .sort(compare)
  const index = siblings.findIndex((folder) => folder.id === id)
  siblings.splice(index, 1, ...children)
  const positions = new Map(
    siblings.map((folder, position) => [folder.id, (position + 1) * 1000]),
  )
  return folders.flatMap((folder) => {
    if (folder.id === id) return []
    const position = positions.get(folder.id)
    if (position === undefined) return [folder]
    return [
      {
        ...folder,
        position,
        ...(folder.parentId === id
          ? { parentId: removed.parentId, updatedAt: now }
          : {}),
      },
    ]
  })
}

export function replaceById<T extends { id: string }>(
  items: readonly T[],
  item: T,
): T[] {
  const index = items.findIndex((value) => value.id === item.id)
  if (index < 0) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

export function idFromCrypto(): string {
  const chars = '0123456789abcdefghjkmnpqrstvwxyz'
  const numbers = new Uint8Array(26)
  crypto.getRandomValues(numbers)
  return [...numbers].map((number) => chars[number & 31]).join('')
}

export function rollbackFields<T extends object>(
  current: T,
  before: T,
  patch: object,
  expected: T,
): T {
  const result = { ...current } as Record<string, unknown>
  const previous = before as Record<string, unknown>
  const optimistic = expected as Record<string, unknown>
  for (const field of Object.keys(patch)) {
    if (result[field] !== optimistic[field]) continue
    if (field in previous) result[field] = previous[field]
    else delete result[field]
  }
  return result as T
}

export function rewriteTags(
  snapshot: OrganizeSnapshot,
  from: string,
  to: string | null,
): Pick<OrganizeSnapshot, 'notes' | 'contents'> {
  const notes: Record<string, NoteSummary> = { ...snapshot.notes }
  const contents: Record<string, string> = { ...snapshot.contents }
  for (const [id, note] of Object.entries(snapshot.notes)) {
    if (!note.tags.includes(from)) continue
    const content = snapshot.contents[id]
    if (content === undefined) {
      notes[id] = {
        ...note,
        tags: sortTagNames(
          note.tags.flatMap((name) =>
            name === from ? (to === null ? [] : [to]) : [name],
          ),
        ),
      }
      continue
    }
    const rewritten = replaceTagInContent(content, from, to)
    const counts = countText(rewritten)
    contents[id] = rewritten
    notes[id] = {
      ...note,
      tags: sortTagNames(extractTags(rewritten)),
      excerpt: deriveExcerpt(rewritten),
      wordCount: counts.words,
      charCount: counts.chars,
    }
  }
  return { notes, contents }
}
