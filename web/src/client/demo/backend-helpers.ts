import type { Folder, Note, NoteVersion } from '@shared/types'
import type { DemoState } from './state'

export function findVersion(
  state: DemoState,
  noteId: string,
  versionId: string,
): NoteVersion | null {
  return (
    state.versions.get(noteId)?.find((version) => version.id === versionId) ??
    null
  )
}

export function saveVersion(state: DemoState, note: Note): void {
  const version: NoteVersion = {
    id: crypto.randomUUID().replaceAll('-', '').slice(0, 26),
    noteId: note.id,
    title: note.title,
    size: new TextEncoder().encode(note.content).byteLength,
    createdAt: Date.now(),
    content: note.content,
  }
  state.versions.set(
    note.id,
    [version, ...(state.versions.get(note.id) ?? [])].slice(0, 50),
  )
}

export function purgeNote(state: DemoState, id: string): void {
  state.notes.delete(id)
  state.versions.delete(id)
  state.shares.delete(id)
  state.cursor++
}

export function demoFolderSiblings(
  state: DemoState,
  parentId: string | null,
  excludeId?: string,
): Folder[] {
  return [...state.folders.values()]
    .filter((folder) => folder.parentId === parentId && folder.id !== excludeId)
    .sort(
      (left, right) =>
        left.position - right.position ||
        left.createdAt - right.createdAt ||
        left.id.localeCompare(right.id),
    )
}
