/** Produces restorable JSON, readable Markdown, and attachment files for
 * every backup target. */
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
import { LIMITS } from '@shared/constants'
import { APP_VERSION } from '../../release'
import { extractAttachmentIds } from '@shared/markdown-utils'
import type { Env } from '../env'
import { sha256Hex } from '../lib/encoding'
import {
  buildFolderPaths,
  openVerifiedAttachment,
  formatBytes,
  staticFile,
  staticFileAsync,
  streamBytes,
  validateAttachmentRow,
  type AttachmentSnapshotRow,
} from './snapshot-files'
import { safeSegment } from './snapshot-files'
import {
  assertArchiveCanBeRestored,
  assertArchiveSizesCanBeRestored,
  assertBundleCanBeRestored,
  buildJsonExport,
} from './snapshot-json'
import {
  NOTE_COLUMNS_FULL,
  toFolder,
  toNote,
  type FolderRow,
  type NoteRow,
} from '../db/rows'

export {
  assertArchiveCanBeRestored,
  assertBundleCanBeRestored,
  buildJsonExport,
}

export type BackupFileKind =
  'note' | 'attachment' | 'readme' | 'manifest' | 'complete'

export interface BackupFile {
  path: string
  byteLength: number
  sha256: string
  contentType: string
  kind: BackupFileKind
  open: () => Promise<ReadableStream<Uint8Array>>
}

export interface MaterializedBackupFile {
  path: string
  body: Uint8Array
  contentType: string
}

export interface Snapshot {
  payloadFiles: BackupFile[]
  manifestFile: BackupFile
  completeFile: BackupFile
  noteCount: number
  attachmentCount: number
  bytes: number
  stamp: string
  createdAt: Date
}


const encoder = new TextEncoder()
const NOTE_PAGE_SIZE = 100
const ATTACHMENT_LOOKUP_BATCH = 200
const ATTACHMENT_REFERENCE_RE =
  /\/api\/files\/([0-9a-hjkmnp-tv-z]{26})(?=$|[\s>)\]"'?#])/g

export async function buildSnapshot(
  env: Env,
  userId: string,
): Promise<Snapshot> {
  const folderResult = await env.DB.prepare(
    `SELECT f.id, f.parent_id, f.name, f.icon, f.color, f.position, ` +
      `f.created_at, f.updated_at FROM folders f WHERE f.user_id = ?1 ` +
      `ORDER BY f.position ASC, f.id ASC`,
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
        `${safeSegment(note.title || 'Untitled note')}--${note.id.slice(-8)}`
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

export async function materializeSnapshot(
  snapshot: Snapshot,
): Promise<MaterializedBackupFile[]> {
  const files = [
    ...snapshot.payloadFiles,
    snapshot.manifestFile,
    snapshot.completeFile,
  ]
  assertArchiveSizesCanBeRestored(files)
  const materialized: MaterializedBackupFile[] = []
  for (const file of files) {
    const body = await readBackupFile(file)
    if ((await sha256Hex(body)) !== file.sha256) {
      throw new Error(
        `Backup file changed while the archive was being created: ${file.path}`,
      )
    }
    materialized.push({ path: file.path, body, contentType: file.contentType })
  }
  return materialized
}

async function readBackupFile(file: BackupFile): Promise<Uint8Array> {
  const reader = (await file.open()).getReader()
  const body = new Uint8Array(file.byteLength)
  let offset = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (offset + value.byteLength > body.byteLength) {
        throw new Error(`Backup source size changed: ${file.path}`)
      }
      body.set(value, offset)
      offset += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (offset !== body.byteLength)
    throw new Error(`Backup source size changed: ${file.path}`)
  return body
}

async function loadReferencedAttachments(
  db: D1Database,
  userId: string,
  ids: ReadonlySet<string>,
  destination: Map<string, AttachmentSnapshotRow>,
): Promise<void> {
  const pending = [...ids]
  for (
    let offset = 0;
    offset < pending.length;
    offset += ATTACHMENT_LOOKUP_BATCH
  ) {
    const batch = pending.slice(offset, offset + ATTACHMENT_LOOKUP_BATCH)
    const placeholders = batch.map(() => '?').join(', ')
    const result = await db
      .prepare(
        `SELECT id, user_id, filename, mime, size, sha256, storage, ` +
          `created_at FROM attachments WHERE user_id = ?1 AND id IN (` +
            `${placeholders})`,
      )
      .bind(userId, ...batch)
      .all<AttachmentSnapshotRow>()
    for (const row of result.results) destination.set(row.id, row)
  }
}


function renderNoteBody(
  content: string,
  notePath: string,
  attachmentPaths: ReadonlyMap<string, string>,
  referencedIds: ReadonlySet<string>,
): string {
  return content.replace(ATTACHMENT_REFERENCE_RE, (match, id: string) => {
    if (!referencedIds.has(id)) return match
    const attachmentPath = attachmentPaths.get(id)
    return attachmentPath ? relativeBackupUrl(notePath, attachmentPath) : match
  })
}

async function openPlannedNote(
  env: Env,
  userId: string,
  noteId: string,
  expectedRev: number,
  notePath: string,
  expectedSha256: string,
  attachmentPaths: ReadonlyMap<string, string>,
  referencedIds: ReadonlySet<string>,
): Promise<ReadableStream<Uint8Array>> {
  const row = await env.DB.prepare(
    `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
      WHERE n.user_id = ?1 AND n.id = ?2 AND n.rev = ?3`,
  )
    .bind(userId, noteId, expectedRev)
    .first<NoteRow>()
  if (!row)
    throw new Error(`A note changed while the backup was running: ${noteId}`)
  const bytes = encoder.encode(
    renderNoteBody(row.content, notePath, attachmentPaths, referencedIds),
  )
  if ((await sha256Hex(bytes)) !== expectedSha256) {
    throw new Error(`A note changed while the backup was running: ${row.title}`)
  }
  return streamBytes(bytes)
}


function relativeBackupUrl(fromFile: string, toFile: string): string {
  const from = fromFile.split('/').slice(0, -1)
  const to = toFile.split('/')
  let common = 0
  while (
    common < from.length &&
    common < to.length &&
    from[common] === to[common]
  )
    common++
  const parts = [
    ...Array.from({ length: from.length - common }, () => '..'),
    ...to.slice(common),
  ]
  return parts
    .map((part) => (part === '..' ? part : encodeURIComponent(part)))
    .join('/')
}

export function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0')
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}` +
    `${pad(date.getUTCDate())}-${pad(date.getUTCHours())}` +
    `${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}-${ms}`
  )
}

function readme(
  stamp: string,
  notes: readonly MarkdownBackupNoteEntry[],
  attachments: number,
): string {
  const active = notes.filter((note) => note.state === 'notes').length
  const archived = notes.filter((note) => note.state === 'archived').length
  const trash = notes.filter((note) => note.state === 'trash').length
  return (
    `AutoNote Markdown backup\n\nSnapshot (UTC): ${stamp}\n` +
    `Total notes: ${notes.length}\nActive: ${active}\n` +
    `Archived: ${archived}\nTrash: ${trash}\nAttachments: ${attachments}\n\n` +
    `notes/ contains ordinary notes in their folder hierarchy.\n` +
    `archived/ contains archived notes in their folder hierarchy.\n` +
    `trash/ contains trashed notes in their folder hierarchy.\n` +
    `attachments/ contains referenced files in their original bytes; ` +
    `the checksum in each filename prevents collisions.\n` +
    `manifest.json records note state, timestamps, paths, and checksums.\n\n` +
    `Restore this ZIP directly in AutoNote. For a backup larger than the ` +
    `browser upload limit, extract it and select the extracted folder ` +
    `instead.\n` +
    `A backup is valid only when its COMPLETE file is present and matches ` +
    `manifest.json.\n`
  )
}
