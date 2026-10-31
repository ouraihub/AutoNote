import type { Note } from '@shared/types'
import {
  expect,
  expectBackendError,
  expectDefined,
  expectEqual,
  expectExcludes,
  expectIncludes,
} from './assertions'
import {
  flushNote,
  listNoteIds,
  withBackend,
  withLibrary,
  writeText,
} from './harness'
import type { BackendContractFixture, ContractBackend } from './types'

const SOURCE =
  '# Contract source\n\n中文段落，emoji 📝，`code` 与 **Markdown**。\n\n- [ ] task\n'

export async function verifiesCreateReadSource(
  fixture: BackendContractFixture,
): Promise<void> {
  await withLibrary(fixture, async (library) => {
    const created = await withBackend(library, async (backend) => {
      const note = await backend.notes.create({
        title: 'Contract source',
        content: SOURCE,
      })
      expectEqual(
        note.content,
        SOURCE,
        'create must return the submitted source',
      )
      const read = await backend.notes.get(note.id)
      expectEqual(
        read.content,
        SOURCE,
        'reading a created note must preserve its source',
      )
      expectEqual(
        read.title,
        note.title,
        'reading a created note must preserve its title',
      )
      expectEqual(
        read.rev,
        note.rev,
        'reading a created note must not change its revision',
      )
      return note
    })
    await withBackend(library, async (backend) => {
      const reopened = await backend.notes.get(created.id)
      expectEqual(
        reopened.content,
        SOURCE,
        'a reopened backend must read the same source',
      )
    })
  })
}

export async function verifiesWriteRevisionAndConflict(
  fixture: BackendContractFixture,
): Promise<void> {
  await withLibrary(fixture, async (library) => {
    await withBackend(library, async (staleBackend) => {
      const original = await staleBackend.notes.create({
        title: 'Contract revision',
        content: 'base text',
      })
      const stale = await staleBackend.notes.get(original.id)
      const accepted = await withBackend(library, async (otherBackend) => {
        const changed = await writeText(otherBackend, original, 'accepted text')
        const unchanged = await writeText(
          otherBackend,
          changed,
          'accepted text',
        )
        expectEqual(
          unchanged.rev,
          changed.rev,
          'writing identical content must not advance the revision',
        )
        return changed
      })
      expect(
        accepted.rev > original.rev,
        'a successful write must advance its revision',
      )
      expectEqual(
        accepted.content,
        'accepted text',
        'a successful write must persist its content',
      )

      if (fixture.writeConflictMode === 'reject')
        await verifiesStaleWriteRejected(staleBackend, stale, accepted)
      else await verifiesStaleWriteRebased(staleBackend, stale, accepted)
    })
  })
}

async function verifiesStaleWriteRejected(
  backend: ContractBackend,
  stale: Note,
  current: Note,
): Promise<void> {
  const error = await expectBackendError(
    backend.notes.patch(
      stale.id,
      { rev: stale.rev, content: 'stale text' },
      { writeId: crypto.randomUUID() },
    ),
    'conflict',
    'a write with a stale revision must be rejected',
  )
  const server = expectDefined(
    error.details?.server,
    'a conflict must carry the current server note',
  )
  expectEqual(
    server.rev,
    current.rev,
    'the conflict server note must carry the current revision',
  )
  expectEqual(
    server.content,
    current.content,
    'the conflict server note must carry the current content',
  )

  const persisted = await backend.notes.get(stale.id)
  expectEqual(
    persisted.content,
    current.content,
    'a rejected stale write must not overwrite persisted content',
  )
  expectEqual(
    persisted.rev,
    current.rev,
    'a rejected stale write must not advance the revision',
  )
}

async function verifiesStaleWriteRebased(
  backend: ContractBackend,
  stale: Note,
  current: Note,
): Promise<void> {
  const writeId = crypto.randomUUID()
  const queued = await backend.notes.patch(
    stale.id,
    { rev: stale.rev, content: 'offline text' },
    { writeId },
  )
  expect(
    queued.queued,
    'a rebased text write must be accepted into the local outbox',
  )
  expectEqual(
    queued.writeId,
    writeId,
    'a queued write must echo the caller writeId',
  )
  await flushNote(backend, stale.id)

  const rebased = await backend.notes.get(stale.id)
  expectEqual(
    rebased.content,
    'offline text',
    'the replayed local text must win after rebase',
  )
  expect(
    rebased.rev > current.rev,
    'a rebased write must advance beyond the remote revision',
  )

  const versions = await backend.notes.versions(stale.id)
  const contents = await Promise.all(
    versions.map(
      async (meta) => (await backend.notes.version(stale.id, meta.id)).content,
    ),
  )
  expectIncludes(
    contents,
    current.content,
    'the remote text replaced by a rebase must remain in history',
  )
}

export async function verifiesTrashRestoreAndPurge(
  fixture: BackendContractFixture,
): Promise<void> {
  await withLibrary(fixture, async (library) => {
    await withBackend(library, async (backend) => {
      const created = await backend.notes.create({
        title: 'Contract lifecycle',
        content: 'lifecycle text',
      })

      const trashed = await backend.notes.remove(created.id)
      expect(
        trashed.deletedAt !== null,
        'remove must mark the note as soft-deleted',
      )
      expect(trashed.rev > created.rev, 'remove must advance the revision')
      const kept = await backend.notes.get(created.id)
      expect(
        kept.deletedAt !== null,
        'a soft-deleted note must remain readable with its deletion marker',
      )
      expectEqual(
        kept.content,
        created.content,
        'a soft-deleted note must keep its content',
      )
      expectIncludes(
        await listNoteIds(backend, { view: 'trash' }),
        created.id,
        'trash must list a removed note',
      )
      expectExcludes(
        await listNoteIds(backend, { view: 'all' }),
        created.id,
        'all must hide a removed note',
      )

      const restored = await backend.notes.restore(created.id)
      expectEqual(
        restored.deletedAt,
        null,
        'restore must clear the deletion marker',
      )
      expect(restored.rev > trashed.rev, 'restore must advance the revision')
      expectEqual(
        restored.content,
        created.content,
        'restore must keep the note content',
      )
      expectIncludes(
        await listNoteIds(backend, { view: 'all' }),
        created.id,
        'all must list a restored note',
      )
      expectExcludes(
        await listNoteIds(backend, { view: 'trash' }),
        created.id,
        'trash must drop a restored note',
      )

      const removed = await backend.notes.remove(created.id)
      const purge = await backend.notes.purge(created.id)
      expect(
        Number.isSafeInteger(purge.cursor) && purge.cursor > 0,
        'purge must return a positive deletion cursor',
      )
      await expectPurged(
        backend,
        created.id,
        removed.rev,
        purge.cursor,
        fixture.writeConflictMode,
      )
    })
  })
}

export async function verifiesEmptyTrashTombstones(
  fixture: BackendContractFixture,
): Promise<void> {
  await withLibrary(fixture, async (library) => {
    await withBackend(library, async (backend) => {
      const kept = await backend.notes.create({
        title: 'Contract kept',
        content: 'kept text',
      })
      const first = await backend.notes.create({
        title: 'Contract trash one',
        content: 'one',
      })
      const second = await backend.notes.create({
        title: 'Contract trash two',
        content: 'two',
      })
      const removedFirst = await backend.notes.remove(first.id)
      const removedSecond = await backend.notes.remove(second.id)

      const emptied = await backend.notes.emptyTrash()
      expect(emptied.purged >= 2, 'empty trash must purge every trashed note')
      await expectPurged(
        backend,
        first.id,
        removedFirst.rev,
        null,
        fixture.writeConflictMode,
      )
      await expectPurged(
        backend,
        second.id,
        removedSecond.rev,
        null,
        fixture.writeConflictMode,
      )
      const survivor = await backend.notes.get(kept.id)
      expectEqual(
        survivor.deletedAt,
        null,
        'empty trash must not touch live notes',
      )
    })
  })
}

async function expectPurged(
  backend: ContractBackend,
  id: string,
  rev: number,
  purgeCursor: number | null,
  mode: BackendContractFixture['writeConflictMode'],
): Promise<void> {
  await expectBackendError(
    backend.notes.get(id),
    'not_found',
    'a purged note must not be readable',
  )
  if (mode === 'reject') {
    const error = await expectBackendError(
      backend.notes.patch(
        id,
        { rev, content: 'must not resurrect' },
        { writeId: crypto.randomUUID() },
      ),
      'not_found',
      'a purged note must reject stale writes with a tombstone',
    )
    const deletionCursor = expectDefined(
      error.details?.deletionCursor,
      'a purged note must return a deletion cursor',
    )
    expect(
      Number.isSafeInteger(deletionCursor) && deletionCursor > 0,
      'a deletion cursor must be a positive integer',
    )
    if (purgeCursor !== null) {
      expectEqual(
        deletionCursor,
        purgeCursor,
        'a tombstone deletion cursor must match the purge cursor',
      )
    }
  }
  const snapshot = await backend.notes.snapshot()
  if (purgeCursor !== null && mode === 'reject') {
    expect(
      snapshot.cursor >= purgeCursor,
      'the full snapshot cursor must include the purge tombstone',
    )
  }
  expectExcludes(
    snapshot.notes.map((note) => note.id),
    id,
    'a purged note must not appear in the library snapshot',
  )
  expectExcludes(
    await listNoteIds(backend, { view: 'trash' }),
    id,
    'a purged note must leave the trash',
  )
}
