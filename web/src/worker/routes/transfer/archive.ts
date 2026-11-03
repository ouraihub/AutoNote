import { ApiError } from '../../lib/errors'
import { LIMITS } from '@shared/constants'
import { MARKDOWN_BACKUP_FORMAT } from '@shared/backup-format'
import type { MarkdownBackupManifest } from '@shared/backup-format'
import type { UnzippedEntry } from '@shared/zip'
import { backupCompletePath } from '@shared/backup-format'
import { backupManifestPath } from '@shared/backup-format'
import { bundleDirectory } from './values'
import { completeManifestHash } from '@shared/backup-format'
import { isRecord } from './values'
import { isSafeBackupPath } from '@shared/backup-format'
import { parseMarkdownBackupManifest } from '@shared/backup-format'
import { sha256Hex } from '../../lib/encoding'
import { validateAttachmentArchivePath } from './values'

export function parsePostedBackupManifest(
  value: string | File | null,
): MarkdownBackupManifest | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > LIMITS.importBundleMaxBytes) {
    throw ApiError.badRequest('The backup manifest is too large')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw ApiError.badRequest('The backup manifest is not valid JSON')
  }
  const manifest = parseMarkdownBackupManifest(parsed)
  if (!manifest)
    throw ApiError.badRequest(
      'This is not a valid AutoNote Markdown backup manifest',
    )
  return manifest
}

export function parsePostedBackupPaths(
  value: string | File | null,
  count: number,
): string[] | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 1024 * 1024)
    throw ApiError.badRequest('The backup file list is too large')
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw ApiError.badRequest('The backup file list is not valid JSON')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== count ||
    parsed.some((path) => !isSafeBackupPath(path))
  ) {
    throw ApiError.badRequest('The backup file list is invalid')
  }
  return parsed as string[]
}

export async function verifyBackupEntry(
  bytes: Uint8Array,
  expectedBytes: number,
  expectedHash: string,
  path: string,
): Promise<void> {
  if (bytes.byteLength !== expectedBytes)
    throw new Error(`Backup file length verification failed: ${path}`)
  if ((await sha256Hex(bytes)) !== expectedHash)
    throw new Error(`Backup file SHA-256 verification failed: ${path}`)
}

export async function selectCompleteZipBackup(
  entries: readonly UnzippedEntry[],
): Promise<{
  manifest: MarkdownBackupManifest
  rootPrefix: string
  warning: string | null
} | null> {
  const byPath = new Map(
    entries.map((entry) => [entry.path.toLowerCase(), entry]),
  )
  const candidates: Array<{
    entry: UnzippedEntry
    manifest: MarkdownBackupManifest
    rootPrefix: string
    complete: UnzippedEntry | undefined
  }> = []
  let manifestSeen = false
  const skipped: string[] = []

  for (const entry of entries) {
    if (!/(?:^|\/)manifest\.json$/i.test(entry.path)) continue
    const legacyPath =
      /(?:^|\/)snapshots\/\d{8}-\d{6}-\d{3}\/manifest\.json$/i.test(entry.path)
    const directory = entry.path.slice(0, entry.path.lastIndexOf('/') + 1)
    const siblingComplete = byPath.get(`${directory}complete`.toLowerCase())
    let raw: unknown
    try {
      raw = JSON.parse(new TextDecoder().decode(entry.data))
    } catch {
      if (legacyPath || siblingComplete) manifestSeen = true
      if (siblingComplete)
        throw new Error(
          `The completed backup has an invalid manifest: ${entry.path}`,
        )
      continue
    }
    const declaresAutoNote =
      isRecord(raw) && raw.format === MARKDOWN_BACKUP_FORMAT
    if (legacyPath || declaresAutoNote) manifestSeen = true
    const manifest = parseMarkdownBackupManifest(raw)
    if (!manifest) {
      if (siblingComplete && declaresAutoNote) {
        throw new Error(
          'The completed backup has an invalid or unsupported manifest: ' +
            entry.path,
        )
      }
      continue
    }
    const suffix = backupManifestPath(manifest.snapshot, manifest.version)
    if (!entry.path.toLowerCase().endsWith(suffix.toLowerCase())) {
      if (siblingComplete)
        throw new Error(
          `The backup manifest is in an invalid path: ${entry.path}`,
        )
      continue
    }
    const rootPrefix = entry.path.slice(0, entry.path.length - suffix.length)
    candidates.push({
      entry,
      manifest,
      rootPrefix,
      complete: byPath.get(
        (
          rootPrefix + backupCompletePath(manifest.snapshot, manifest.version)
        ).toLowerCase(),
      ),
    })
  }

  candidates.sort((a, b) =>
    b.manifest.snapshot.localeCompare(a.manifest.snapshot),
  )
  for (const { entry, manifest, rootPrefix, complete } of candidates) {
    if (!complete) {
      skipped.push(manifest.snapshot)
      continue
    }
    const declaredHash = completeManifestHash(
      new TextDecoder().decode(complete.data),
    )
    const actualHash = await sha256Hex(entry.data)
    if (!declaredHash || declaredHash !== actualHash) {
      throw new Error(`The COMPLETE marker does not match ${entry.path}`)
    }
    return {
      manifest,
      rootPrefix,
      warning: skipped.length
        ? `A newer snapshot (${skipped[0]}) was incomplete, ` +
          'so the newest complete snapshot was restored instead'
        : null,
    }
  }

  if (manifestSeen)
    throw new Error(
      'The ZIP contains an incomplete AutoNote backup ' +
        'without a valid COMPLETE marker',
    )
  return null
}

export function collectAttachmentArchivePaths(
  raw: unknown,
  bundlePath: string,
): Set<string> {
  const expected = new Set<string>()
  if (!isRecord(raw) || !Array.isArray(raw.attachments)) return expected
  const base = bundleDirectory(bundlePath)
  for (const attachment of raw.attachments) {
    if (!isRecord(attachment) || typeof attachment.id !== 'string') {
      throw new Error('The attachment manifest contains an invalid entry')
    }
    const path = validateAttachmentArchivePath(attachment.path, attachment.id)
    expected.add(`${base}${path}`.toLowerCase())
  }
  return expected
}

export function mapBundleAttachmentEntries(
  entries: readonly UnzippedEntry[],
  bundlePath: string,
): Map<string, Uint8Array> {
  const base = bundleDirectory(bundlePath)
  const baseLower = base.toLowerCase()
  const mapped = new Map<string, Uint8Array>()
  for (const entry of entries) {
    if (!entry.path.toLowerCase().startsWith(baseLower)) continue
    mapped.set(entry.path.slice(base.length).toLowerCase(), entry.data)
  }
  return mapped
}
