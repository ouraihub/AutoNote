import type { ListNotesQuery, Note } from '@shared/types'
import { expect, expectEqual } from './assertions'
import type { BackendContractFixture, ContractBackend, ContractLibrary } from './types'

export async function withLibrary(
  fixture: BackendContractFixture,
  action: (library: ContractLibrary<ContractBackend>) => Promise<void>,
): Promise<void> {
  const library = await fixture.createLibrary()
  try {
    await action(library)
  } finally {
    await library.dispose()
  }
}

export async function withBackend<T>(
  library: ContractLibrary<ContractBackend>,
  action: (backend: ContractBackend) => Promise<T>,
): Promise<T> {
  const backend = await library.open()
  try {
    return await action(backend)
  } finally {
    await backend.dispose()
  }
}

export async function listNoteIds(backend: ContractBackend, query: ListNotesQuery): Promise<string[]> {
  const ids: string[] = []
  let cursor: string | null = null
  do {
    const page = await backend.notes.list(cursor === null ? query : { ...query, cursor })
    ids.push(...page.notes.map((note) => note.id))
    if (page.nextCursor !== null) expect(page.nextCursor !== cursor, 'note pagination must advance its cursor')
    cursor = page.nextCursor
  } while (cursor !== null)
  return ids
}

export async function flushNote(backend: ContractBackend, noteId: string): Promise<void> {
  const result = await backend.notes.flush(noteId)
  expectEqual(result.pending, 0, 'an online flush must leave no pending local writes')
  expectEqual(result.failed, 0, 'an online flush must not leave failed writes')
}

export async function writeText(backend: ContractBackend, note: Note, content: string): Promise<Note> {
  const writeId = crypto.randomUUID()
  const result = await backend.notes.patch(note.id, { rev: note.rev, content }, { writeId })
  expectEqual(result.writeId, writeId, 'a note write must echo the caller writeId')
  await flushNote(backend, note.id)
  return backend.notes.get(note.id)
}
