// The Rust side (`core/tests/ipc_contract.rs`) writes this fixture from a real
// Library. Here the same JSON goes through the shared consumers the desktop
// transport will use, so a field rename on either side fails one of the two.
import { describe, expect, it } from 'vitest'
import fixture from '../../../fixtures/ipc-contract.json'
import { backendErrorFromPayload } from '@app/backend/errors'
import { EMPTY_SYNC_SHELL, mergeSync } from '@app/state/merge'
import { isNote, isNoteWriteResult, isWriteQueueEvent } from '@shared/backend-types'
import type { SyncResponse } from '@shared/types'

const fallback = { code: 'internal', status: 0, message: 'x' } as const
const asError = (payload: unknown) => backendErrorFromPayload({ error: payload }, fallback)

describe('ipc-contract.json', () => {
  it('note shapes satisfy the shared schemas', () => {
    expect(isNote(fixture.note)).toBe(true)
    expect(isNote(fixture.trashed)).toBe(true)
    expect(isNoteWriteResult(fixture.noteWriteResult)).toBe(true)
    expect(fixture.writeEvents.every(isWriteQueueEvent)).toBe(true)
  })

  it('errors keep their code and safe details', () => {
    const conflict = asError(fixture.errors.conflict)
    expect(conflict.code).toBe('conflict')
    expect(conflict.details?.server?.rev).toBe(fixture.note.rev)
    const gone = asError(fixture.errors.notFoundWithDeletionCursor)
    expect([gone.code, gone.details?.deletionCursor]).toEqual(['not_found', fixture.purge.cursor])
    expect(asError(fixture.errors.malformedBody).code).toBe('bad_request')
    expect(asError(fixture.upload.reusedUploadId).code).toBe('bad_request')
  })

  it('snapshot then incremental merges into the committed state', () => {
    const { snapshot, incremental, staleSince } = fixture.syncResponse as Record<string, SyncResponse>
    const base = mergeSync(EMPTY_SYNC_SHELL, snapshot!, new Map(), new Map()).shell
    const next = mergeSync(base, incremental!, new Map(), new Map()).shell
    expect(Object.keys(next.notes)).toEqual([fixture.note.id])
    expect(next.notes[fixture.note.id]?.rev).toBe(fixture.note.rev)
    expect(next.cursor).toBe(fixture.purge.cursor)
    expect(next.folders.map((f) => f.id)).toEqual([fixture.folder.id])
    expect(staleSince!.full).toBe(true)
    expect(mergeSync(next, staleSince!, new Map(), new Map()).shell.notes).toEqual(next.notes)
  })

  it('attachment page uses the AttachmentPage envelope', () => {
    expect(fixture.upload.page.nextCursor).toBeNull()
    expect(fixture.upload.page.files[0]?.id).toBe(fixture.upload.finish.id)
    expect(fixture.upload.chunk.received).toBe(fixture.upload.finish.size)
  })
})
