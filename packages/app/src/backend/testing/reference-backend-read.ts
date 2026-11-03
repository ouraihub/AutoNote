import type { Note, NoteVersion } from '@shared/types'

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
  )
}

export function sortVersions(versions: NoteVersion[]): NoteVersion[] {
  return [...versions].sort((a, b) => b.createdAt - a.createdAt)
}
