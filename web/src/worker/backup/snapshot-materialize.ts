import { LIMITS } from '@shared/constants'
import { estimateZipSizeFromSizes } from '@shared/zip'
import { sha256Hex } from '../lib/encoding'
import { ApiError } from '../lib/errors'
import type { MaterializedBackupFile, Snapshot } from './snapshot-types'
import { formatBytes } from './snapshot-utils'

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
    const reader = (await file.open()).getReader()
    const body = new Uint8Array(file.byteLength)
    let offset = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (offset + value.byteLength > body.byteLength)
          throw new Error(`Backup source size changed: ${file.path}`)
        body.set(value, offset)
        offset += value.byteLength
      }
    } finally {
      reader.releaseLock()
    }
    if (offset !== body.byteLength)
      throw new Error(`Backup source size changed: ${file.path}`)
    if ((await sha256Hex(body)) !== file.sha256)
      throw new Error(
        `Backup file changed while the archive was being created: ${file.path}`,
      )
    materialized.push({ path: file.path, body, contentType: file.contentType })
  }
  return materialized
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

function assertArchiveSizesCanBeRestored(
  files: readonly { path: string; byteLength: number }[],
): void {
  if (files.length > LIMITS.importArchiveEntriesMax)
    throw ApiError.tooLarge(
      `The complete backup contains ${files.length} files, exceeding the ` +
        `restore limit of ${LIMITS.importArchiveEntriesMax}`,
    )
  const expandedBytes = files.reduce((sum, file) => sum + file.byteLength, 0)
  if (
    !Number.isSafeInteger(expandedBytes) ||
    expandedBytes > LIMITS.importArchiveExpandedMaxBytes
  )
    throw ApiError.tooLarge(
      `Use folder restore when a backup exceeds ` +
        `${formatBytes(LIMITS.importArchiveExpandedMaxBytes)}`,
    )
  if (estimateZipSizeFromSizes(files) > LIMITS.importUploadMaxBytes)
    throw ApiError.tooLarge(
      `Use folder restore when a backup exceeds ` +
        `${formatBytes(LIMITS.importUploadMaxBytes)}`,
    )
}

export function assertBundleCanBeRestored(byteLength: number): void {
  if (byteLength > LIMITS.importBundleMaxBytes)
    throw ApiError.tooLarge(
      `The JSON export exceeds ${formatBytes(LIMITS.importBundleMaxBytes)} ` +
        'restore limit',
    )
}
