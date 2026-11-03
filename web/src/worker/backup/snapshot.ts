import { LIMITS } from '@shared/constants'
import { APP_VERSION } from '../../release'
import { sha256Hex } from '../lib/encoding'
import {
  backupAttachmentPath,
  backupCompleteBody,
  backupCompletePath,
  backupManifestPath,
  parseMarkdownBackupManifest,
  type MarkdownBackupAttachmentEntry,
  type MarkdownBackupManifest,
  type MarkdownBackupNoteEntry,
  type MarkdownBackupNoteState,
  MARKDOWN_BACKUP_FORMAT,
  MARKDOWN_BACKUP_VERSION,
} from '@shared/backup-format'
import { extractAttachmentIds } from '@shared/markdown-utils'
import {
  NOTE_COLUMNS_FULL,
  toFolder,
  toNote,
  type FolderRow,
  type NoteRow,
} from '../db/rows'
import type { Env } from '../env'
import type {
  AttachmentSnapshotRow,
  BackupFile,
  Snapshot,
} from './snapshot-types'
import {
  buildFolderPaths,
  formatStamp,
  formatBytes,
  openPlannedNote,
  openVerifiedAttachment,
  readme,
  renderNoteBody,
  safeSegment,
  staticFile,
  staticFileAsync,
  validateAttachmentRow,
} from './snapshot-utils'
const encoder = new TextEncoder()
const NOTE_PAGE_SIZE = 100
const ATTACHMENT_LOOKUP_BATCH = 200

export async function buildSnapshot(
  env: Env,
  userId: string,
): Promise<Snapshot> {
  const folderResult = await env.DB.prepare(
    'SELECT f.id, f.parent_id, f.name, f.icon, f.color, f.position, ' +
      `f.created_at, f.updated_at
       FROM folders f WHERE f.user_id = ?1 ORDER BY f.position ASC, f.id ASC`,
  )
    .bind(userId)
    .all<FolderRow>()
  const folders = folderResult.results.map(toFolder)
  const folderPaths = buildFolderPaths(folders)
  const attachmentsById = new Map<string, AttachmentSnapshotRow>()

  const attachmentPathByHash = new Map<string, string>()
  const attachmentPathById = new Map<string, string>()
  const selectedAttachmentsByHash = new Map<string, AttachmentSnapshotRow>()

  const now = new Date()
  const stamp = formatStamp(now)
  const noteFiles: BackupFile[] = []
  const noteEntries: MarkdownBackupNoteEntry[] = []
  const usedPaths = new Set<string>()
  let afterId = ''

  while (true) {
    const page = await env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
        WHERE n.user_id = ?1 AND n.id > ?2 ORDER BY n.id ASC LIMIT ?3`,
    )
      .bind(userId, afterId, NOTE_PAGE_SIZE)
      .all<NoteRow>()
    if (!page.results.length) break

    const missingAttachmentIds = new Set<string>()
    for (const row of page.results) {
      for (const id of extractAttachmentIds(row.content)) {
        if (!attachmentsById.has(id)) missingAttachmentIds.add(id)
      }
    }
    await loadReferencedAttachments(
      env.DB,
      userId,
      missingAttachmentIds,
      attachmentsById,
    )

    for (const row of page.results) {
      const note = toNote(row)
      const noteAttachmentIds = new Set(extractAttachmentIds(note.content))
      for (const id of noteAttachmentIds) {
        const attachment = attachmentsById.get(id)
        if (!attachment) {
          throw new Error(
            `A referenced attachment is missing from the database: ${id}`,
          )
        }
        validateAttachmentRow(attachment)
        if (!selectedAttachmentsByHash.has(attachment.sha256)) {
          selectedAttachmentsByHash.set(attachment.sha256, attachment)
          attachmentPathByHash.set(
            attachment.sha256,
            backupAttachmentPath(
              attachment.sha256,
              safeSegment(attachment.filename),
            ),
          )
        }
        attachmentPathById.set(id, attachmentPathByHash.get(attachment.sha256)!)
      }

      const state: MarkdownBackupNoteState = note.deletedAt
        ? 'trash'
        : note.isArchived
          ? 'archived'
          : 'notes'
      const folderInfo = note.folderId
        ? folderPaths.get(note.folderId)
        : undefined
      const folder = folderInfo?.path ?? ''
      const base =
        `${safeSegment(note.title || 'Untitled note')}--` + note.id.slice(-8)
      let path = `${state}/${folder ? `${folder}/` : ''}${base}.md`
      let suffix = 2
      while (usedPaths.has(path.toLowerCase())) {
        path = `${state}/${folder ? `${folder}/` : ''}${base}-${suffix++}.md`
      }
      usedPaths.add(path.toLowerCase())

      const rendered = renderNoteBody(
        note.content,
        path,
        attachmentPathById,
        noteAttachmentIds,
      )
      const bytes = encoder.encode(rendered)
      const sha256 = await sha256Hex(bytes)
      const attachmentHashes = [
        ...new Set(
          [...noteAttachmentIds].map((id) => attachmentsById.get(id)!.sha256),
        ),
      ].sort()
      const entry: MarkdownBackupNoteEntry = {
        id: note.id,
        path,
        title: note.title,
        folder: folderInfo?.names ?? [],
        attachmentHashes,
        state,
        archived: note.isArchived,
        bytes: bytes.byteLength,
        sha256,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
        deletedAt: note.deletedAt,
      }
      noteEntries.push(entry)
      noteFiles.push({
        path,
        byteLength: bytes.byteLength,
        sha256,
        contentType: 'text/markdown; charset=utf-8',
        kind: 'note',
        open: () =>
          openPlannedNote(
            env,
            userId,
            row.id,
            row.rev,
            path,
            sha256,
            attachmentPathById,
            noteAttachmentIds,
          ),
      })
    }

    afterId = page.results.at(-1)!.id
    if (page.results.length < NOTE_PAGE_SIZE) break
  }

  const selectedAttachmentRows = [...selectedAttachmentsByHash.values()].sort(
    (a, b) => a.sha256.localeCompare(b.sha256),
  )

  const attachmentEntries: MarkdownBackupAttachmentEntry[] =
    selectedAttachmentRows.map((row) => ({
      path: attachmentPathByHash.get(row.sha256)!,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      sha256: row.sha256,
      createdAt: row.created_at,
    }))
  const attachmentFiles: BackupFile[] = selectedAttachmentRows.map((row) => ({
    path: attachmentPathByHash.get(row.sha256)!,
    byteLength: row.size,
    sha256: row.sha256,
    contentType: row.mime,
    kind: 'attachment',
    open: () => openVerifiedAttachment(env, row),
  }))

  const readmeFile = await staticFile(
    'README.txt',
    readme(stamp, noteEntries, attachmentEntries.length),
    'text/plain; charset=utf-8',
    'readme',
  )
  const manifest: MarkdownBackupManifest = {
    format: MARKDOWN_BACKUP_FORMAT,
    version: MARKDOWN_BACKUP_VERSION,
    appVersion: APP_VERSION,
    createdAt: now.toISOString(),
    snapshot: stamp,
    notes: noteEntries,
    attachments: attachmentEntries,
  }
  if (!parseMarkdownBackupManifest(manifest)) {
    throw new Error(
      'The backup contains metadata that cannot be restored safely',
    )
  }
  const manifestFile = await staticFileAsync(
    backupManifestPath(stamp),
    encoder.encode(JSON.stringify(manifest, null, 2)),
    'application/json; charset=utf-8',
    'manifest',
  )
  if (manifestFile.byteLength > LIMITS.importUploadMaxBytes) {
    throw new Error(
      `The backup manifest exceeds ${formatBytes(LIMITS.importUploadMaxBytes)}`,
    )
  }
  const completeFile = await staticFile(
    backupCompletePath(stamp),
    backupCompleteBody(manifestFile.sha256),
    'text/plain; charset=utf-8',
    'complete',
  )
  const payloadFiles = [...noteFiles, ...attachmentFiles, readmeFile]
  const allFiles = [...payloadFiles, manifestFile, completeFile]

  return {
    payloadFiles,
    manifestFile,
    completeFile,
    noteCount: noteEntries.length,
    attachmentCount: attachmentEntries.length,
    bytes: allFiles.reduce((sum, file) => sum + file.byteLength, 0),
    stamp,
    createdAt: now,
  }
}
async function loadReferencedAttachments(
  db: D1Database,
  userId: string,
  ids: ReadonlySet<string>,
  target: Map<string, AttachmentSnapshotRow>,
): Promise<void> {
  const values = [...ids]
  for (
    let offset = 0;
    offset < values.length;
    offset += ATTACHMENT_LOOKUP_BATCH
  ) {
    const chunk = values.slice(offset, offset + ATTACHMENT_LOOKUP_BATCH)
    const { results } = await db
      .prepare(
        'SELECT id, user_id, filename, mime, size, sha256, storage, ' +
          `created_at
         FROM attachments
        WHERE user_id = ?1 AND id IN (SELECT value FROM json_each(?2))`,
      )
      .bind(userId, JSON.stringify(chunk))
      .all<AttachmentSnapshotRow>()
    for (const row of results) target.set(row.id, row)
  }
}

export {
  materializeSnapshot,
  assertArchiveCanBeRestored,
  assertBundleCanBeRestored,
} from './snapshot-materialize'
export { buildJsonExport } from './snapshot-json'
export { formatStamp, safeSegment } from './snapshot-utils'
export type {
  BackupFile,
  MaterializedBackupFile,
  Snapshot,
} from './snapshot-types'
