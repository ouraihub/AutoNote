import type { UserSettings } from '@shared/types'
import {
  expect,
  expectEqual,
  expectExcludes,
  expectIncludes,
  sha256Hex,
} from './assertions'
import { listNoteIds, withBackend, withLibrary } from './harness'
import type { BackendContractFixture } from './types'

export async function verifiesFolderAndTagFiltering(
  fixture: BackendContractFixture,
): Promise<void> {
  await withLibrary(fixture, async (library) => {
    await withBackend(library, async (backend) => {
      const folder = await backend.folders.create({ name: 'Contract folder' })
      const tag = await backend.tags.create({ name: 'contract-tag' })
      const inFolder = await backend.notes.create({
        title: 'In folder',
        content: 'folder body',
        folderId: folder.id,
      })
      const tagged = await backend.notes.create({
        title: 'Tagged',
        content: 'Tagged body #contract-tag',
      })
      const plain = await backend.notes.create({
        title: 'Plain',
        content: 'plain body',
      })

      expectEqual(
        inFolder.folderId,
        folder.id,
        'create must keep the requested folder',
      )
      expectIncludes(
        tagged.tags,
        tag.name,
        'a body hashtag must become a note tag',
      )
      expectIncludes(
        (await backend.folders.list()).map((item) => item.id),
        folder.id,
        'folders list must include a created folder',
      )
      expectIncludes(
        (await backend.tags.list()).map((item) => item.name),
        tag.name,
        'tags list must include a created tag',
      )

      const folderIds = await listNoteIds(backend, {
        view: 'folder',
        folderId: folder.id,
      })
      expectIncludes(
        folderIds,
        inFolder.id,
        'the folder view must include its note',
      )
      expectExcludes(
        folderIds,
        tagged.id,
        'the folder view must exclude notes outside the folder',
      )
      expectExcludes(
        folderIds,
        plain.id,
        'the folder view must exclude unfiled notes',
      )

      const tagIds = await listNoteIds(backend, { view: 'tag', tag: tag.name })
      expectIncludes(
        tagIds,
        tagged.id,
        'the tag view must include a note whose body carries the tag',
      )
      expectExcludes(
        tagIds,
        inFolder.id,
        'the tag view must exclude untagged notes',
      )
      expectExcludes(
        tagIds,
        plain.id,
        'the tag view must exclude untagged notes',
      )

      const unfiledIds = await listNoteIds(backend, { view: 'unfiled' })
      expectIncludes(
        unfiledIds,
        plain.id,
        'the unfiled view must include notes without a folder',
      )
      expectExcludes(
        unfiledIds,
        inFolder.id,
        'the unfiled view must exclude filed notes',
      )
    })
  })
}

export async function verifiesAttachmentHash(
  fixture: BackendContractFixture,
): Promise<void> {
  await withLibrary(fixture, async (library) => {
    const bytes = Uint8Array.from(
      { length: 4096 },
      (_, index) => (index * 31 + 7) % 256,
    )
    const expectedHash = await sha256Hex(bytes)
    const uploaded = await withBackend(library, async (backend) => {
      const file = new File([Uint8Array.from(bytes)], 'contract.bin', {
        type: 'application/octet-stream',
      })
      const attachment = await backend.files.upload(file)
      expectEqual(
        attachment.size,
        bytes.byteLength,
        'an uploaded attachment must report its byte size',
      )
      expectEqual(
        await sha256Hex(await library.readAttachment(backend, attachment)),
        expectedHash,
        'reading an uploaded attachment must return identical bytes',
      )
      return attachment
    })
    await withBackend(library, async (backend) => {
      let cursor: string | null = null
      let found = false
      do {
        const page = await backend.files.list(cursor ?? undefined)
        found ||= page.files.some((file) => file.id === uploaded.id)
        if (page.nextCursor !== null)
          expect(
            page.nextCursor !== cursor,
            'attachment pagination must advance its cursor',
          )
        cursor = page.nextCursor
      } while (cursor !== null)
      expect(found, 'a reopened backend must list the uploaded attachment')
      expectEqual(
        await sha256Hex(await library.readAttachment(backend, uploaded)),
        expectedHash,
        'a reopened backend must serve identical attachment bytes',
      )
    })
  })
}

export async function verifiesSettingsPersist(
  fixture: BackendContractFixture,
): Promise<void> {
  await withLibrary(fixture, async (library) => {
    const { before, expected } = await withBackend(library, async (backend) => {
      const current = await backend.settings.get()
      const density: UserSettings['appearance']['density'] =
        current.appearance.density === 'compact' ? 'comfortable' : 'compact'
      const tabSize = current.editor.tabSize === 4 ? 2 : 4
      const saved = await backend.settings.save({
        appearance: { density },
        editor: { tabSize },
      })
      expectEqual(
        saved.appearance.density,
        density,
        'settings save must return the patched appearance value',
      )
      expectEqual(
        saved.editor.tabSize,
        tabSize,
        'settings save must return the patched editor value',
      )
      return { before: current, expected: { density, tabSize } }
    })
    await withBackend(library, async (backend) => {
      const reloaded = await backend.settings.get()
      expectEqual(
        reloaded.appearance.density,
        expected.density,
        'patched settings must survive a reopen',
      )
      expectEqual(
        reloaded.editor.tabSize,
        expected.tabSize,
        'patched settings must survive a reopen',
      )
      expectEqual(
        reloaded.appearance.theme,
        before.appearance.theme,
        'a section patch must keep sibling fields',
      )
      expectEqual(
        reloaded.preview.layout,
        before.preview.layout,
        'a section patch must keep untouched sections',
      )
      expectEqual(
        reloaded.editor.fontSize,
        before.editor.fontSize,
        'a section patch must keep sibling editor fields',
      )
    })
  })
}
