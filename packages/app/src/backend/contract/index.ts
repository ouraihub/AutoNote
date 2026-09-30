import { isBackendError } from '../errors'
import type { Backend } from '../port'
import type { Attachment, Note } from '@shared/types'

export type WriteConflictMode = 'reject' | 'rebase'

export interface BackendContractFixture {
  /** Creates a new isolated backend and its associated account/library. */
  createBackend(): Promise<Backend>
  /** Reopens the same isolated account/library through a fresh host Backend. */
  reopenBackend(backend: Backend): Promise<Backend>
  /** Creates a File that the backend can upload without reading a host path. */
  createFile(name: string, mime: string, bytes: Uint8Array): File
  /**
   * Reads uploaded bytes through the real host endpoint/protocol handler.
   * The app Backend intentionally has no byte-download method, so this is a
   * test-only adapter owned by each host runner.
   */
  readAttachment(backend: Backend, attachment: Attachment): Promise<Uint8Array>
  /**
   * Runs the host's real Web outbox replay and verifies its preserved remote
   * version. Desktop never calls this because it rejects stale writes.
   */
  verifyRebasedTextWrite?(backend: Backend, note: Note, writeId: string): Promise<void>
  /** The Web outbox rebases stale text writes; the local library rejects them. */
  readonly writeConflictMode: WriteConflictMode
}

export interface BackendContractCase {
  readonly name: string
  run(fixture: BackendContractFixture): Promise<void>
}

export const backendContractCases: readonly BackendContractCase[] = [
  { name: 'create-read-source', run: verifiesCreateReadSource },
  { name: 'write-revision-conflict', run: verifiesWriteRevisionAndConflict },
  { name: 'trash-restore-purge', run: verifiesTrashRestoreAndPurge },
  { name: 'folder-tag-filtering', run: verifiesFolderAndTagFiltering },
  { name: 'attachment-bytes', run: verifiesAttachmentBytes },
  { name: 'settings-persist', run: verifiesSettingsPersist },
]

export async function runBackendContractCases(fixture: BackendContractFixture): Promise<void> {
  for (const contractCase of backendContractCases) await contractCase.run(fixture)
}

async function verifiesCreateReadSource(fixture: BackendContractFixture): Promise<void> {
  await withBackend(fixture, async (backend) => {
    const source = '# Contract source\n\nExact **Markdown** body.'
    const created = await backend.notes.create({ title: 'Contract source', content: source })
    const read = await backend.notes.get(created.id)

    expectEqual(read.content, source, 'reading a created note must preserve its source')
    expectEqual(read.title, created.title, 'reading a created note must preserve its title')
  })
}

async function verifiesWriteRevisionAndConflict(fixture: BackendContractFixture): Promise<void> {
  await withBackend(fixture, async (backend) => {
    const original = await backend.notes.create({ title: 'Contract revision', content: 'before' })
    const writeId = 'contract-write-revision'
    await backend.notes.patch(original.id, { rev: original.rev, content: 'after', preserveVersion: true }, { writeId })
    await backend.notes.flush(original.id)

    const updated = await backend.notes.get(original.id)
    expect(updated.rev > original.rev, 'a successful write must advance its revision')
    expectEqual(updated.content, 'after', 'a successful write must persist its content')

    if (fixture.writeConflictMode === 'reject') {
      await expectConflict(
        backend.notes.patch(original.id, { rev: original.rev, content: 'stale' }, { writeId: 'contract-stale-write' }),
      )
      const unchanged = await backend.notes.get(original.id)
      expectEqual(unchanged.content, 'after', 'a rejected stale write must not overwrite persisted content')
      return
    }

    // Web may accept text while offline and rebase it during replay. The host
    // runner verifies the resulting remote content and preserved old version.
    const staleWriteId = 'contract-stale-write'
    const staleWrite = await backend.notes.patch(
      original.id,
      { rev: original.rev, content: 'stale', preserveVersion: true },
      { writeId: staleWriteId },
    )
    expect(staleWrite.queued, 'the rebase mode only applies to a locally queued text write')
    const verifyRebasedTextWrite = fixture.verifyRebasedTextWrite
    expect(verifyRebasedTextWrite !== undefined, 'rebase mode must verify real outbox replay and history')
    await verifyRebasedTextWrite(backend, updated, staleWriteId)
  })
}

async function verifiesTrashRestoreAndPurge(fixture: BackendContractFixture): Promise<void> {
  await withBackend(fixture, async (backend) => {
    const created = await backend.notes.create({ title: 'Contract lifecycle', content: 'content' })
    const trashed = await backend.notes.remove(created.id)
    expect(trashed.deletedAt !== null, 'remove must produce a soft-deleted note')

    const restored = await backend.notes.restore(created.id)
    expectEqual(restored.deletedAt, null, 'restore must clear the soft-delete marker')

    await backend.notes.remove(created.id)
    const purge = await backend.notes.purge(created.id)
    expect(purge.cursor >= 0, 'purge must return a non-negative deletion cursor')
    await expectNotFound(backend.notes.get(created.id))
  })
}

async function verifiesFolderAndTagFiltering(fixture: BackendContractFixture): Promise<void> {
  await withBackend(fixture, async (backend) => {
    const folder = await backend.folders.create({ name: 'Contract folder' })
    const tag = await backend.tags.create({ name: 'contract-tag' })
    const folderNote = await backend.notes.create({
      title: 'Folder contract',
      content: 'folder content',
      folderId: folder.id,
    })
    const taggedNote = await backend.notes.create({
      title: 'Tag contract',
      content: '#contract-tag\n\nTag content',
    })

    const folderPage = await backend.notes.list({ view: 'folder', folderId: folder.id })
    expectIncludes(
      folderPage.notes.map((note) => note.id),
      folderNote.id,
      'folder filter must include its note',
    )

    const tagPage = await backend.notes.list({ view: 'tag', tag: tag.name })
    expectIncludes(
      tagPage.notes.map((note) => note.id),
      taggedNote.id,
      'tag filter must include extracted tag content',
    )
  })
}

async function verifiesAttachmentBytes(fixture: BackendContractFixture): Promise<void> {
  await withBackend(fixture, async (backend) => {
    const bytes = new TextEncoder().encode('autonote contract attachment')
    const uploaded = await backend.files.upload(fixture.createFile('contract.txt', 'text/plain', bytes))
    const read = await fixture.readAttachment(backend, uploaded)

    expectBytesEqual(read, bytes, 'reading an uploaded attachment must preserve every byte')
  })
}

async function verifiesSettingsPersist(fixture: BackendContractFixture): Promise<void> {
  await withBackend(fixture, async (backend) => {
    const before = await backend.settings.get()
    const nextDensity = before.appearance.density === 'comfortable' ? 'compact' : 'comfortable'
    const saved = await backend.settings.save({ appearance: { density: nextDensity } })
    const reloadedBackend = await fixture.reopenBackend(backend)
    try {
      const reloaded = await reloadedBackend.settings.get()
      expectEqual(saved.appearance.density, nextDensity, 'settings save must return the patched value')
      expectEqual(reloaded.appearance.density, nextDensity, 'settings must survive a fresh Backend instance')
    } finally {
      await reloadedBackend.dispose()
    }
  })
}

async function withBackend(
  fixture: BackendContractFixture,
  action: (backend: Backend) => Promise<void>,
): Promise<void> {
  const backend = await fixture.createBackend()
  try {
    await action(backend)
  } finally {
    await backend.dispose()
  }
}

async function expectConflict(operation: Promise<unknown>): Promise<void> {
  try {
    await operation
  } catch (error) {
    if (isBackendError(error) && error.code === 'conflict') return
    throw new Error(`Expected BackendError(conflict), received ${describeError(error)}`, { cause: error })
  }
  throw new Error('Expected stale write to fail with conflict')
}

async function expectNotFound(operation: Promise<unknown>): Promise<void> {
  try {
    await operation
  } catch (error) {
    if (isBackendError(error) && error.code === 'not_found') return
    throw new Error(`Expected BackendError(not_found), received ${describeError(error)}`, { cause: error })
  }
  throw new Error('Expected purged note read to fail with not_found')
}

function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Backend contract failed: ${message}`)
}

function expectEqual<T>(actual: T, expected: T, message: string): void {
  if (Object.is(actual, expected)) return
  throw new Error(`Backend contract failed: ${message}; expected ${String(expected)}, received ${String(actual)}`)
}

function expectIncludes(values: readonly string[], expected: string, message: string): void {
  expect(values.includes(expected), message)
}

function expectBytesEqual(actual: Uint8Array, expected: Uint8Array, message: string): void {
  if (actual.length !== expected.length) throw new Error(`Backend contract failed: ${message}`)
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== expected[index]) throw new Error(`Backend contract failed: ${message}`)
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
