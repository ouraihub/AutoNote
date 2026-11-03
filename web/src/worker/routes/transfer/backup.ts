import type { AppBindings } from '../../env'
import type { ExistingAttachmentRow } from './types'
import type { ImportContext } from './types'
import type { InsertInput } from './types'
import { LIMITS } from '@shared/constants'
import type { MarkdownBackupAttachmentEntry } from '@shared/backup-format'
import type { MarkdownBackupManifest } from '@shared/backup-format'
import type { MarkdownBackupNoteEntry } from '@shared/backup-format'
import type { PreparedAttachmentCandidate } from './types'
import type { SelectedImportFile } from './types'
import { addWarning } from './values'
import { assertContentSize } from '../../lib/request'
import { backupSnapshotDir } from '@shared/backup-format'
import { ensureFolderPath } from './folders'
import { existingAttachmentMatches } from './attachments'
import { formatBytes } from './values'
import { insertNote } from './notes'
import { isSafeBackupPath } from '@shared/backup-format'
import { loadExistingAttachments } from './attachments'
import { loadExistingNoteIndex } from './mappings'
import { newId } from '../../lib/id'
import { persistAttachmentWithinQuota } from '../../attachments/storage'
import { rollbackPersistedAttachments } from '../../attachments/storage'
import { selectAttachmentStorage } from '../../attachments/backend'
import { updateImportedNote } from './notes'
import { upsertImportMappings } from './mappings'
import { validTimestamp } from './values'
import { verifyBackupEntry } from './archive'

export async function importBackupFileBatch(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  selected: readonly SelectedImportFile[],
  manifest: MarkdownBackupManifest,
  ctx: ImportContext,
): Promise<void> {
  const noteByPath = new Map(
    manifest.notes.map((entry) => [entry.path.toLowerCase(), entry]),
  )
  const attachmentByPath = new Map(
    manifest.attachments.map((entry) => [entry.path.toLowerCase(), entry]),
  )
  const seen = new Set<string>()
  const planned = selected.map(({ file, path }) => {
    if (!isSafeBackupPath(path)) throw new Error(`Invalid backup path: ${path}`)
    const key = path.toLowerCase()
    if (seen.has(key))
      throw new Error(`The selected backup contains a duplicate path: ${path}`)
    seen.add(key)
    const note = noteByPath.get(key)
    const attachment = attachmentByPath.get(key)
    if (!note && !attachment)
      throw new Error(`The file is not listed in the backup manifest: ${path}`)
    return { file, path, note, attachment }
  })

  for (const item of planned) {
    const entry = item.note ?? item.attachment!
    const bytes = new Uint8Array(await item.file.arrayBuffer())
    await verifyBackupEntry(
      bytes,
      item.note ? item.note.bytes : item.attachment!.size,
      entry.sha256,
      entry.path,
    )
    if (item.note) {
      try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
          bytes,
        )
      } catch {
        throw new Error(
          `The Markdown file is not valid UTF-8: ${item.note.path}`,
        )
      }
    }
  }

  for (const item of planned.filter((entry) => entry.attachment)) {
    const entry = item.attachment!
    const bytes = new Uint8Array(await item.file.arrayBuffer())
    await importBackupAttachment(c.env, userId, entry, bytes, ctx)
  }
  for (const item of planned.filter((entry) => entry.note)) {
    const entry = item.note!
    const bytes = new Uint8Array(await item.file.arrayBuffer())
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
        bytes,
      )
    } catch {
      throw new Error(`The Markdown file is not valid UTF-8: ${entry.path}`)
    }
    await importBackupMarkdown(c, userId, entry, text, manifest, ctx)
  }
}

export async function importBackupAttachment(
  env: AppBindings['Bindings'],
  userId: string,
  entry: MarkdownBackupAttachmentEntry,
  bytes: Uint8Array,
  ctx: ImportContext,
): Promise<void> {
  if (entry.size > LIMITS.attachmentMaxBytes) {
    throw new Error(
      `${entry.filename}: the attachment exceeds ` +
        formatBytes(LIMITS.attachmentMaxBytes),
    )
  }
  if (!selectAttachmentStorage(env)) {
    throw new Error(
      'This instance has no R2 or Workers KV attachment binding ' +
        'and cannot restore attachments',
    )
  }

  const candidate: PreparedAttachmentCandidate = {
    sourceId: entry.sha256,
    sourceNoteId: null,
    filename: entry.filename,
    reportedMime: entry.mime,
    bytes,
    sha256: entry.sha256,
    createdAt: validTimestamp(entry.createdAt) || Date.now(),
  }
  const existing = (
    await loadExistingAttachments(env.DB, userId, [entry.sha256])
  ).get(entry.sha256)
  if (
    existing?.user_id === userId &&
    (await existingAttachmentMatches(env, existing, candidate))
  ) {
    ctx.result.skippedAttachments++
    return
  }

  const sameContent = await env.DB.prepare(
    `SELECT id, user_id, filename, mime, size, sha256, storage
       FROM attachments
      WHERE user_id = ?1 AND sha256 = ?2
      ORDER BY created_at ASC, id ASC LIMIT 1`,
  )
    .bind(userId, entry.sha256)
    .first<ExistingAttachmentRow>()
  if (
    sameContent &&
    (await existingAttachmentMatches(env, sameContent, candidate))
  ) {
    await upsertImportMappings(env.DB, userId, 'attachment', [
      { sourceId: entry.sha256, targetId: sameContent.id },
    ])
    ctx.result.skippedAttachments++
    return
  }

  const persisted = await persistAttachmentWithinQuota(env, {
    id: newId(),
    userId,
    noteId: null,
    filename: entry.filename,
    reportedMime: entry.mime,
    bytes,
    createdAt: candidate.createdAt,
  })
  try {
    await upsertImportMappings(env.DB, userId, 'attachment', [
      { sourceId: entry.sha256, targetId: persisted.id },
    ])
  } catch (error) {
    await rollbackPersistedAttachments(env, [persisted]).catch(() => {})
    throw error
  }
  ctx.result.createdAttachments++
}

export const BACKUP_ATTACHMENT_URL_RE =
  /(?:\.\.\/)+attachments\/([0-9a-f]{64})--[^\s<>"')\]?#]+/g

export async function importBackupMarkdown(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  entry: MarkdownBackupNoteEntry,
  backupContent: string,
  manifest: MarkdownBackupManifest,
  ctx: ImportContext,
): Promise<void> {
  const hashes = entry.attachmentHashes
  const expectedHashes = new Set(hashes)
  const attachmentIds = await loadBackupAttachmentTargets(
    c.env.DB,
    userId,
    hashes,
  )
  for (const hash of hashes) {
    if (!attachmentIds.has(hash))
      throw new Error(
        `Restore the referenced attachment before this note: ${entry.path}`,
      )
  }
  const content = backupContent.replace(
    BACKUP_ATTACHMENT_URL_RE,
    (match, hash: string) =>
      expectedHashes.has(hash)
        ? `/api/files/${attachmentIds.get(hash)}`
        : match,
  )
  assertContentSize(content)

  const statePrefix =
    manifest.version === 2
      ? `${backupSnapshotDir(manifest.snapshot)}/${entry.state}/`
      : `${entry.state}/`
  if (!entry.path.startsWith(statePrefix))
    throw new Error(`Invalid backup note path: ${entry.path}`)
  const folderId = entry.folder.length
    ? await ensureFolderPath(c.env.DB, userId, entry.folder.join('/'), ctx)
    : null
  const sourceId = entry.id
  const importedUpdatedAt = validTimestamp(entry.updatedAt)
  const importedCreatedAt = validTimestamp(entry.createdAt)
  const deletedAt =
    entry.state === 'trash'
      ? validTimestamp(entry.deletedAt) || importedUpdatedAt || Date.now()
      : undefined
  const effectiveUpdatedAt = Math.max(
    importedUpdatedAt || importedCreatedAt,
    deletedAt ?? 0,
  )
  const input: InsertInput = {
    id: sourceId,
    content,
    title: entry.title,
    folderId,
    isArchived: entry.archived,
    createdAt: importedCreatedAt,
    updatedAt: effectiveUpdatedAt,
    deletedAt,
  }
  const existing = await loadExistingNoteIndex(c.env.DB, userId, sourceId, ctx)
  if (existing) {
    if (ctx.conflict === 'skip') {
      ctx.result.skippedNotes++
      return
    }
    if (ctx.conflict === 'duplicate') {
      await insertNote(
        c,
        userId,
        { ...input, id: undefined, title: `${entry.title} (imported)` },
        ctx,
      )
      ctx.result.createdNotes++
      return
    }
    const outcome = await updateImportedNote(
      c,
      userId,
      existing,
      input,
      effectiveUpdatedAt,
      ctx,
    )
    if (outcome === 'updated') ctx.result.updatedNotes++
    else {
      ctx.result.skippedNotes++
      if (outcome === 'conflict')
        addWarning(
          ctx.result,
          `${entry.title}: the current note changed during restore ` +
            'and was kept',
        )
    }
    return
  }

  const insertedId = await insertNote(c, userId, input, ctx)
  ctx.byId?.set(sourceId, {
    id: insertedId,
    title: entry.title,
    rev: 1,
    updated_at: effectiveUpdatedAt,
  })
  ctx.result.createdNotes++
}

export async function loadBackupAttachmentTargets(
  db: D1Database,
  userId: string,
  hashes: readonly string[],
): Promise<Map<string, string>> {
  const targets = new Map<string, string>()
  for (let offset = 0; offset < hashes.length; offset += 80) {
    const chunk = hashes.slice(offset, offset + 80)
    const placeholders = chunk.map((_, index) => `?${index + 2}`).join(', ')
    const { results } = await db
      .prepare(
        `SELECT m.source_id, m.target_id FROM import_mappings m
        JOIN attachments a ON a.id = m.target_id AND a.user_id = m.user_id
       WHERE m.user_id = ?1 AND m.entity = 'attachment'
         AND m.source_id IN (${placeholders})`,
      )
      .bind(userId, ...chunk)
      .all<{ source_id: string; target_id: string }>()
    for (const row of results) targets.set(row.source_id, row.target_id)
  }
  return targets
}
