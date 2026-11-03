import { ApiError } from '../../lib/errors'
import type { ImportConflict } from './types'
import type { ImportResult } from '@shared/types'
import { LIMITS } from '@shared/constants'
import { MARKDOWN_BACKUP_FORMAT } from '@shared/backup-format'
import type { UnzippedEntry } from '@shared/zip'
import { deriveTitle } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'

export const EXPORT_FILE = 'autonote-export.json'

export const EXPORT_FORMAT = 'autonote-export'

export const IMPORT_CONFLICTS = new Set<ImportConflict>([
  'skip',
  'newer',
  'duplicate',
])

export const MAX_IMPORT_WARNINGS = 100

export function parseDate(value: string | undefined): number {
  if (!value) return 0
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

export function validTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Math.trunc(value), Date.now() + 5 * 60 * 1000)
    : 0
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    Math.abs(value) <= 1_000_000_000_000
    ? value
    : undefined
}

export function normalizeFolderSegment(value: string): string {
  const normalized = value.replace(/[\u0000-\u001f/\\]/g, '-').trim()
  return truncateText(normalized, LIMITS.folderNameMaxLength).trim()
}

export function isExportBundlePath(path: string): boolean {
  const lower = path.toLowerCase()
  return lower === EXPORT_FILE || lower.endsWith(`/${EXPORT_FILE}`)
}

export function isBackupControlPath(path: string): boolean {
  const lower = path.toLowerCase()
  return (
    isExportBundlePath(path) ||
    lower === 'manifest.json' ||
    lower.endsWith('/manifest.json') ||
    lower === 'complete' ||
    lower.endsWith('/complete') ||
    isMarkdownBackupControlPath(path)
  )
}

const MARKDOWN_BACKUP_CONTROL_PATH = new RegExp(
  String.raw`(?:^|\/)snapshots\/\d{8}-\d{6}-\d{3}\/` +
    String.raw`(?:manifest\.json|complete|readme\.txt)$`,
  'i',
)

export function isMarkdownBackupControlPath(path: string): boolean {
  return MARKDOWN_BACKUP_CONTROL_PATH.test(path)
}

export function isAutoNoteBackupManifest(entry: UnzippedEntry): boolean {
  if (!/(?:^|\/)manifest\.json$/i.test(entry.path)) return false
  try {
    const raw = JSON.parse(new TextDecoder().decode(entry.data)) as unknown
    return isRecord(raw) && raw.format === MARKDOWN_BACKUP_FORMAT
  } catch {
    return false
  }
}

export function bundleDirectory(bundlePath: string): string {
  const slash = bundlePath.lastIndexOf('/')
  return slash >= 0 ? bundlePath.slice(0, slash + 1) : ''
}

export function validateAttachmentArchivePath(
  value: unknown,
  sourceId: string,
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 512 ||
    value.includes('\\')
  ) {
    throw new Error(`Invalid attachment path: ${sourceId}`)
  }
  const segments = value.split('/')
  if (
    segments.length !== 3 ||
    segments[0] !== 'attachments' ||
    segments[1] !== sourceId ||
    !segments[2] ||
    segments[2] === '.' ||
    segments[2] === '..' ||
    /[\u0000-\u001f]/.test(segments[2])
  ) {
    throw new Error(`Invalid attachment path: ${sourceId}`)
  }
  return value
}

export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path)
}

export function isImportableEntryPath(path: string): boolean {
  return (
    isMarkdownPath(path) || /\.(png|jpe?g|gif|webp|avif|svg|pdf)$/i.test(path)
  )
}

export function isImportConflict(value: unknown): value is ImportConflict {
  return (
    typeof value === 'string' && IMPORT_CONFLICTS.has(value as ImportConflict)
  )
}

export function parseImportConflict(value: unknown): ImportConflict {
  if (value === null || value === undefined) return 'newer'
  if (isImportConflict(value)) return value
  throw ApiError.badRequest('conflict must be skip, newer, or duplicate')
}

export function importedBundleTitle(title: unknown, content: string): string {
  return typeof title === 'string'
    ? truncateText(title.trim(), LIMITS.titleMaxLength)
    : deriveTitle(content)
}

export function importedMarkdownTitle(
  meta: Record<string, string>,
  content: string,
  filenameFallback: string,
): string {
  return Object.prototype.hasOwnProperty.call(meta, 'title')
    ? truncateText(meta.title!.trim(), LIMITS.titleMaxLength)
    : deriveTitle(content, filenameFallback)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function sourceKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim()
  return key && key.length <= 128 ? key : undefined
}

export function addWarning(result: ImportResult, message: string): void {
  if (result.warnings.length < MAX_IMPORT_WARNINGS - 1) {
    result.warnings.push(truncateText(message, 600))
  } else if (result.warnings.length === MAX_IMPORT_WARNINGS - 1) {
    result.warnings.push('Additional import warnings were omitted')
  }
}

export function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.ceil(bytes / (1024 * 1024))} MB`
    : `${Math.ceil(bytes / 1024)} KB`
}

export function shiftSqlPlaceholders(sql: string, offset: number): string {
  return sql.replace(
    /\?(\d+)/g,
    (_match, value: string) => `?${Number(value) + offset}`,
  )
}
