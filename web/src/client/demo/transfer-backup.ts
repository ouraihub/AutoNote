import { LIMITS } from '@shared/constants'
import { parseMarkdownBackupManifest } from '@shared/backup-format'
import type { ImportResult } from '@shared/types'
import { newDemoId, type DemoState } from './state'
import {
  createImportedNote,
  ensureFolderPath,
  sha256Hex,
  type ImportConflict,
} from './transfer-utils'

export async function importBackupBatch(
  state: DemoState,
  manifestText: string,
  files: readonly File[],
  paths: readonly string[],
  conflict: ImportConflict,
  result: ImportResult,
): Promise<void> {
  const manifest = parseMarkdownBackupManifest(JSON.parse(manifestText))
  if (!manifest) throw new Error('Invalid backup manifest')
  const selected = new Map(paths.map((path, index) => [path, files[index]]))
  const attachmentUrls = new Map<string, string>()
  for (const entry of manifest.attachments) {
    let attachment = [...state.attachments.values()].find(
      (item) =>
        item.meta.url &&
        item.meta.filename === entry.filename &&
        item.meta.size === entry.size,
    )
    if (
      attachment &&
      (await sha256Hex(new Uint8Array(await attachment.file.arrayBuffer()))) !==
        entry.sha256
    )
      attachment = undefined
    const file = selected.get(entry.path)
    if (!attachment && file) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      if (
        bytes.byteLength !== entry.size ||
        (await sha256Hex(bytes)) !== entry.sha256
      )
        throw new Error('Backup attachment checksum failed')
      const used = [...state.attachments.values()].reduce(
        (total, item) => total + item.meta.size,
        0,
      )
      if (used + file.size > LIMITS.attachmentQuotaBytes)
        throw new Error('Attachment quota exceeded')
      const id = newDemoId()
      const restored = new File([file], entry.filename, {
        type: entry.mime,
        lastModified: entry.createdAt,
      })
      attachment = {
        file: restored,
        meta: {
          id,
          noteId: null,
          filename: entry.filename,
          mime: entry.mime,
          size: restored.size,
          width: null,
          height: null,
          createdAt: entry.createdAt,
          url: URL.createObjectURL(restored),
        },
      }
      state.attachments.set(id, attachment)
      result.createdAttachments++
    }
    if (attachment) attachmentUrls.set(entry.sha256, attachment.meta.url)
  }
  for (const entry of manifest.notes) {
    const file = selected.get(entry.path)
    if (!file) continue
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (
      bytes.byteLength !== entry.bytes ||
      (await sha256Hex(bytes)) !== entry.sha256
    )
      throw new Error('Backup note checksum failed')
    const missing = entry.attachmentHashes.filter(
      (hash) => !attachmentUrls.has(hash),
    )
    if (missing.length)
      throw new Error('Restore the backup attachments before their notes')
    const content = new TextDecoder()
      .decode(bytes)
      .replace(
        /(?:\.\.\/)+attachments\/([0-9a-f]{64})--[^\s<>"')\]?#]+/g,
        (url, hash: string) => attachmentUrls.get(hash) ?? url,
      )
    const existing = state.notes.get(entry.id)
    if (
      existing &&
      (conflict === 'skip' ||
        (conflict === 'newer' && entry.updatedAt <= existing.updatedAt))
    ) {
      result.skippedNotes++
      continue
    }
    const folderId = ensureFolderPath(state, entry.folder, result)
    const id =
      existing && conflict === 'newer'
        ? existing.id
        : createImportedNote(state, content, entry.title, folderId)
    const note = state.notes.get(id)
    if (!note) throw new Error('Backup note restore failed')
    state.notes.set(
      id,
      {
        ...note,
        folderId,
        rev: existing && conflict === 'newer' ? existing.rev + 1 : 1,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        isArchived: entry.archived,
        deletedAt: entry.deletedAt,
      },
    )
    if (existing && conflict === 'newer') result.updatedNotes++
    else result.createdNotes++
    if (!existing && conflict !== 'duplicate' && id !== entry.id) {
      const restored = state.notes.get(id)
      if (restored) {
        state.notes.delete(id)
        state.notes.set(entry.id, { ...restored, id: entry.id })
      }
    }
  }
}
