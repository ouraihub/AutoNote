import { LIMITS } from '@shared/constants'
import type { ExportBundle } from '@shared/types'
import { estimateZipSizeFromSizes } from '@shared/zip'
import {
  NOTE_COLUMNS_FULL,
  toFolder,
  toNote,
  toTag,
  type FolderRow,
  type NoteRow,
  type TagRow,
} from '../db/rows'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'
import type { MaterializedBackupFile } from './snapshot'

const encoder = new TextEncoder()
const NOTE_PAGE_SIZE = 100

export async function buildJsonExport(
  env: Env,
  userId: string,
): Promise<Uint8Array> {
  const [folderRows, tagRows, userRows] = await env.DB.batch([
    env.DB.prepare(
      `SELECT f.id, f.parent_id, f.name, f.icon, f.color, f.position, ` +
        `f.created_at, f.updated_at FROM folders f WHERE f.user_id = ?1 ` +
        `AND f.deleted_at IS NULL ORDER BY f.position ASC`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT t.id, t.name, t.color, t.created_at FROM tags ` +
        `t WHERE t.user_id = ?1`,
    ).bind(userId),
    env.DB.prepare(`SELECT login, name FROM users WHERE id = ?1`).bind(userId),
  ])
  const user =
    (userRows.results[0] as { login: string; name: string } | undefined) ?? null
  const metadata: Omit<ExportBundle, 'notes' | 'attachments'> = {
    format: 'autonote-export',
    version: 1,
    exportedAt: Date.now(),
    user: { login: user?.login ?? 'unknown', name: user?.name ?? '' },
    folders: (folderRows as D1Result<FolderRow>).results.map(toFolder),
    tags: (tagRows as D1Result<TagRow>).results.map(toTag),
  }
  const chunks: Uint8Array[] = []
  let byteLength = 0
  const append = (value: string) => {
    const chunk = encoder.encode(value)
    byteLength += chunk.byteLength
    assertBundleByteLengthCanBeRestored(byteLength)
    chunks.push(chunk)
  }

  append(`${JSON.stringify(metadata).slice(0, -1)},"notes":[`)
  let afterId = ''
  let firstNote = true
  while (true) {
    const page = await env.DB.prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
        WHERE n.user_id = ?1 AND n.id > ?2 ORDER BY n.id ASC LIMIT ?3`,
    )
      .bind(userId, afterId, NOTE_PAGE_SIZE)
      .all<NoteRow>()
    if (!page.results.length) break

    for (const row of page.results) {
      append(`${firstNote ? '' : ','}${JSON.stringify(toNote(row))}`)
      firstNote = false
    }

    afterId = page.results.at(-1)!.id
    if (page.results.length < NOTE_PAGE_SIZE) break
  }
  append('],"attachments":[]}')

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  assertBundleCanBeRestored(bytes)
  return bytes
}

export function assertArchiveCanBeRestored(
  files: readonly MaterializedBackupFile[],
): void {
  assertArchiveSizesCanBeRestored(
    files.map((file) => ({
      path: file.path,
      byteLength: file.body.byteLength,
    })),
  )
}

export function assertArchiveSizesCanBeRestored(
  files: readonly { path: string; byteLength: number }[],
): void {
  if (files.length > LIMITS.importArchiveEntriesMax) {
    throw ApiError.tooLarge(
      `The complete backup contains ${files.length} files, exceeding the ` +
        `restore limit of ${LIMITS.importArchiveEntriesMax}`,
    )
  }
  const expandedBytes = files.reduce((sum, file) => sum + file.byteLength, 0)
  if (
    !Number.isSafeInteger(expandedBytes) ||
    expandedBytes > LIMITS.importArchiveExpandedMaxBytes
  ) {
    throw ApiError.tooLarge(
      `Use folder restore when a backup exceeds ` +
        `${formatBytes(LIMITS.importArchiveExpandedMaxBytes)}`,
    )
  }
  if (estimateZipSizeFromSizes(files) > LIMITS.importUploadMaxBytes) {
    throw ApiError.tooLarge(
      `Use folder restore when a backup exceeds ` +
        `${formatBytes(LIMITS.importUploadMaxBytes)}`,
    )
  }
}

export function assertBundleCanBeRestored(bundle: Uint8Array): void {
  assertBundleByteLengthCanBeRestored(bundle.byteLength)
}

function assertBundleByteLengthCanBeRestored(byteLength: number): void {
  if (byteLength > LIMITS.importBundleMaxBytes) {
    throw ApiError.tooLarge(
      `The JSON export exceeds ${formatBytes(LIMITS.importBundleMaxBytes)} ` +
        `restore limit`,
    )
  }
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}
