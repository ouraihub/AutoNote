import {
  BackendError,
  type TransferOptions,
  type TransferPort,
} from '@app/backend'
import type { Logger } from '@app/log/logger'
import type { Clock } from '@app/platform/clock'
import {
  backupManifestPath,
  backupCompletePath,
  completeManifestHash,
  parseMarkdownBackupManifest,
  type MarkdownBackupManifest,
} from '@shared/backup-format'
import { LIMITS } from '@shared/constants'
import type { ImportResult } from '@shared/types'
import type { HttpTransport } from '../transport'
import { saveDownload } from '../download'

export interface TransferPortDeps {
  readonly transport: Pick<HttpTransport, 'raw' | 'json'>
  readonly logger?: Logger
  readonly clock?: Clock
}

type SelectedFile = { file: File; path: string }

export class HttpTransferPort implements TransferPort {
  readonly sources = ['files', 'folder'] as const
  readonly #deps: TransferPortDeps
  constructor(deps: TransferPortDeps) {
    this.#deps = deps
  }

  async exportTo(
    format: 'zip' | 'json',
    options?: TransferOptions,
  ): Promise<{ saved: true } | null> {
    const jobId = crypto.randomUUID()
    const started = this.#deps.clock?.now() ?? Date.now()
    try {
      if (options?.signal?.aborted) return null
      const response = await this.#deps.transport.raw({
        path: '/api/export',
        query: { format },
        signal: options?.signal,
      })
      options?.onProgress?.({
        jobId,
        phase: 'reading',
        completed: 0,
        total: null,
        terminal: false,
      })
      if (
        !(await saveDownload(
          response,
          format === 'zip' ? 'autonote-backup.zip' : 'autonote-export.json',
          options?.signal,
        ))
      )
        return null
      options?.onProgress?.({
        jobId,
        phase: 'finalizing',
        completed: 1,
        total: 1,
        terminal: true,
      })
      this.#deps.logger?.info('transfer.operation.completed', {
        jobId,
        phase: 'export',
        count: 1,
        durationMs: (this.#deps.clock?.now() ?? Date.now()) - started,
      })
      return { saved: true }
    } catch (error) {
      const failure =
        error instanceof BackendError
          ? error
          : new BackendError('internal', 0, 'Export failed')
      this.#deps.logger?.error('transfer.operation.failed', {
        jobId,
        phase: 'export',
        count: 0,
        code: failure.code,
        durationMs: (this.#deps.clock?.now() ?? Date.now()) - started,
      })
      throw failure
    }
  }

  async importFrom(
    source: 'files' | 'folder',
    conflict: 'skip' | 'newer' | 'duplicate',
    options?: TransferOptions,
  ): Promise<ImportResult | null> {
    const jobId = crypto.randomUUID()
    const started = this.#deps.clock?.now() ?? Date.now()
    let completed = 0
    const result: ImportResult = {
      createdNotes: 0,
      updatedNotes: 0,
      skippedNotes: 0,
      createdFolders: 0,
      createdAttachments: 0,
      skippedAttachments: 0,
      warnings: [],
    }
    try {
      if (options?.signal?.aborted) return null
      const selected = await chooseFiles(source, options?.signal)
      if (!selected || options?.signal?.aborted) return null
      const backup = source === 'folder' ? await selectBackup(selected) : null
      const files = backup?.files ?? selected
      if (backup?.warning) result.warnings.push(backup.warning)
      for (let offset = 0; offset < files.length;) {
        if (options?.signal?.aborted) {
          options.onProgress?.({
            jobId,
            phase: 'uploading',
            completed,
            total: files.length,
            terminal: true,
          })
          return completed ? result : null
        }
        const batch: SelectedFile[] = []
        let bytes = 0
        const attachmentBatch =
          backup?.manifest.attachments.some(
            (entry) => entry.path === files[offset]?.path,
          ) ?? false
        while (offset + batch.length < files.length && batch.length < 50) {
          const file = files[offset + batch.length]
          if (
            backup &&
            batch.length > 0 &&
            attachmentBatch !==
              backup.manifest.attachments.some(
                (entry) => entry.path === file?.path,
              )
          )
            break
          if (
            !file ||
            (batch.length > 0 && bytes + file.file.size > 8 * 1024 * 1024)
          )
            break
          batch.push(file)
          bytes += file.file.size
        }
        if (!batch.length)
          throw new BackendError('bad_request', 400, 'No import files')
        const form = new FormData()
        form.set('conflict', conflict)
        form.set('backupPaths', JSON.stringify(batch.map(({ path }) => path)))
        if (backup) {
          const paths = new Set(batch.map(({ path }) => path))
          const notes = backup.manifest.notes.filter((entry) =>
            paths.has(entry.path),
          )
          const hashes = new Set(
            notes.flatMap((entry) => entry.attachmentHashes),
          )
          form.set(
            'backupManifest',
            JSON.stringify({
              ...backup.manifest,
              notes,
              attachments: backup.manifest.attachments.filter(
                (entry) => paths.has(entry.path) || hashes.has(entry.sha256),
              ),
            }),
          )
        }
        for (const { file } of batch) form.append('file', file, file.name)
        let response: ImportResult
        try {
          response = await this.#deps.transport.json<ImportResult>({
            method: 'POST',
            path: '/api/import',
            form,
            signal: options?.signal,
          })
        } catch (error) {
          if (
            error instanceof BackendError &&
            error.code === 'cancelled' &&
            options?.signal?.aborted
          ) {
            options.onProgress?.({
              jobId,
              phase: 'uploading',
              completed,
              total: files.length,
              terminal: true,
            })
            return completed ? result : null
          }
          throw error
        }
        result.createdNotes += response.createdNotes
        result.updatedNotes += response.updatedNotes
        result.skippedNotes += response.skippedNotes
        result.createdFolders += response.createdFolders
        result.createdAttachments += response.createdAttachments
        result.skippedAttachments += response.skippedAttachments
        result.warnings.push(...response.warnings)
        offset += batch.length
        completed = offset
        options?.onProgress?.({
          jobId,
          phase: 'uploading',
          completed,
          total: files.length,
          terminal: completed === files.length,
        })
      }
      this.#deps.logger?.info('transfer.operation.completed', {
        jobId,
        phase: 'import',
        count: completed,
        durationMs: (this.#deps.clock?.now() ?? Date.now()) - started,
      })
      return result
    } catch (error) {
      const failure =
        error instanceof BackendError
          ? error
          : new BackendError('bad_request', 400, 'Invalid backup selection')
      this.#deps.logger?.error('transfer.operation.failed', {
        jobId,
        phase: 'import',
        count: completed,
        code: failure.code,
        durationMs: (this.#deps.clock?.now() ?? Date.now()) - started,
      })
      throw failure
    }
  }
}

async function chooseFiles(
  source: 'files' | 'folder',
  signal?: AbortSignal,
): Promise<SelectedFile[] | null> {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  if (source === 'folder') input.setAttribute('webkitdirectory', '')
  const { promise, resolve } = Promise.withResolvers<SelectedFile[] | null>()
  const finish = (files: SelectedFile[] | null) => {
    signal?.removeEventListener('abort', abort)
    input.onchange = input.oncancel = null
    input.remove()
    resolve(files)
  }
  const abort = () => finish(null)
  input.onchange = () => {
    const files = input.files ? [...input.files] : []
    finish(
      files.length
        ? files.map((file) => ({
            file,
            path: file.webkitRelativePath || file.name,
          }))
        : null,
    )
  }
  input.oncancel = abort
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  else input.click()
  return promise
}

async function fileHash(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

export async function selectBackup(
  selected: readonly SelectedFile[],
): Promise<{
  manifest: MarkdownBackupManifest
  files: SelectedFile[]
  warning: string | null
} | null> {
  const byPath = new Map<string, File>()
  for (const { path, file } of selected) {
    if (byPath.has(path.toLowerCase()))
      throw new BackendError('bad_request', 400, 'Duplicate backup path')
    byPath.set(path.toLowerCase(), file)
  }
  const candidates: {
    manifest: MarkdownBackupManifest
    file: File
    root: string
    complete: File | undefined
  }[] = []
  let seen = false
  for (const { path, file } of selected) {
    if (!/(?:^|\/)manifest\.json$/i.test(path)) continue
    const complete = byPath.get(
      `${path.slice(0, path.lastIndexOf('/') + 1)}complete`.toLowerCase(),
    )
    if (file.size > LIMITS.importUploadMaxBytes)
      throw new BackendError(
        'payload_too_large',
        413,
        'Backup manifest is too large',
      )
    let raw: unknown
    try {
      raw = JSON.parse(await file.text())
    } catch {
      if (complete)
        throw new BackendError('bad_request', 400, 'Invalid backup manifest')
      continue
    }
    const manifest = parseMarkdownBackupManifest(raw)
    if (!manifest) {
      if (
        complete ||
        (raw &&
          typeof raw === 'object' &&
          'format' in raw &&
          raw.format === 'autonote-markdown-backup')
      )
        throw new BackendError('bad_request', 400, 'Invalid backup manifest')
      continue
    }
    seen = true
    const suffix = backupManifestPath(manifest.snapshot, manifest.version)
    if (!path.toLowerCase().endsWith(suffix.toLowerCase()))
      throw new BackendError('bad_request', 400, 'Invalid backup manifest path')
    const root = path.slice(0, path.length - suffix.length)
    candidates.push({
      manifest,
      file,
      root,
      complete: byPath.get(
        `${root}${backupCompletePath(manifest.snapshot, manifest.version)}`.toLowerCase(),
      ),
    })
  }
  candidates.sort((left, right) =>
    right.manifest.snapshot.localeCompare(left.manifest.snapshot),
  )
  let skipped = false
  for (const candidate of candidates) {
    if (!candidate.complete) {
      skipped = true
      continue
    }
    if (
      candidate.complete.size > 1024 ||
      completeManifestHash(await candidate.complete.text()) !==
        (await fileHash(candidate.file))
    )
      throw new BackendError(
        'bad_request',
        400,
        'Backup completion checksum mismatch',
      )
    const files: SelectedFile[] = []
    // Attachments must exist remotely before note batches resolve their hashes.
    for (const entry of [
      ...candidate.manifest.attachments,
      ...candidate.manifest.notes,
    ]) {
      const file = byPath.get(`${candidate.root}${entry.path}`.toLowerCase())
      if (
        !file ||
        file.size !== ('bytes' in entry ? entry.bytes : entry.size) ||
        (await fileHash(file)) !== entry.sha256
      )
        throw new BackendError(
          'bad_request',
          400,
          'Backup file missing or checksum mismatch',
        )
      files.push({ file, path: entry.path })
    }
    return {
      manifest: candidate.manifest,
      files,
      warning: skipped ? 'Newer incomplete backup skipped' : null,
    }
  }
  if (seen)
    throw new BackendError('bad_request', 400, 'No complete backup snapshot')
  return null
}
