import type { TransferOptions, TransferPort } from '@app/backend'
import type { ImportResult } from '@shared/types'
import type { HttpTransport } from '../transport'
import { saveDownload } from '../download'

export interface TransferPortDeps {
  readonly transport: Pick<HttpTransport, 'raw' | 'json'>
}

const BATCH_SIZE = 50
const BATCH_BYTES = 8 * 1024 * 1024

type SelectedFile = { file: File; path: string }

export class HttpTransferPort implements TransferPort {
  readonly sources = ['files', 'folder'] as const
  readonly #transport: TransferPortDeps['transport']

  constructor(deps: TransferPortDeps) {
    this.#transport = deps.transport
  }

  async exportTo(format: 'zip' | 'json', options?: TransferOptions): Promise<{ saved: true } | null> {
    if (options?.signal?.aborted) return null
    const response = await this.#transport.raw({ path: '/api/export', query: { format }, signal: options?.signal })
    if (options?.signal?.aborted) return null
    const jobId = crypto.randomUUID()
    options?.onProgress?.({ jobId, phase: 'reading', completed: 0, total: null, terminal: false })
    if (!await saveDownload(response, format === 'zip' ? 'autonote-backup.zip' : 'autonote-export.json', options?.signal)) return null
    if (options?.signal?.aborted) return null
    options?.onProgress?.({ jobId, phase: 'finalizing', completed: 1, total: 1, terminal: true })
    return { saved: true }
  }

  async importFrom(
    source: 'files' | 'folder',
    conflict: 'skip' | 'newer' | 'duplicate',
    options?: TransferOptions,
  ): Promise<ImportResult | null> {
    if (options?.signal?.aborted) return null
    const selected = await chooseFiles(source)
    if (!selected || options?.signal?.aborted) return null
    const manifest = selected.find(({ path }) => /(?:^|\/)manifest\.json$/i.test(path))
    const manifestText = manifest ? await manifest.file.text() : undefined
    let manifestEntries: string[] = []
    let validManifest = false
    if (manifestText) {
      try {
        const parsed = JSON.parse(manifestText) as {
          notes?: Array<{ path?: string }>
          attachments?: Array<{ path?: string }>
        }
        manifestEntries = [...(parsed.notes ?? []), ...(parsed.attachments ?? [])].flatMap((entry) =>
          typeof entry.path === 'string' ? [entry.path] : [],
        )
        validManifest = true
      } catch {
        /* worker validates malformed manifests */
      }
    }
    const files = selected.flatMap(({ file, path }) => {
      const relative = validManifest && manifestEntries.find((entry) => path === entry || path.endsWith(`/${entry}`))
      if (relative) return [{ file, path: relative }]
      if (validManifest || /(?:^|\/)(?:manifest\.json|complete|readme\.txt)$/i.test(path)) return []
      return [{ file, path }]
    })
    const result: ImportResult = {
      createdNotes: 0,
      updatedNotes: 0,
      skippedNotes: 0,
      createdFolders: 0,
      createdAttachments: 0,
      skippedAttachments: 0,
      warnings: [],
    }
    const jobId = crypto.randomUUID()
    for (let offset = 0; offset < files.length;) {
      if (options?.signal?.aborted) return offset ? result : null
      const batch: SelectedFile[] = []
      let bytes = 0
      while (offset + batch.length < files.length && batch.length < BATCH_SIZE) {
        const candidate = files[offset + batch.length]
        if (!candidate || (batch.length && bytes + candidate.file.size > BATCH_BYTES)) break
        batch.push(candidate)
        bytes += candidate.file.size
      }
      if (!batch.length) batch.push(files[offset]!)
      const form = new FormData()
      form.set('conflict', conflict)
      if (manifestText) form.set('backupManifest', manifestText)
      form.set('backupPaths', JSON.stringify(batch.map(({ path }) => path)))
      for (const { file } of batch) form.append('file', file, file.name)
      const response = await this.#transport.json<ImportResult>({
        method: 'POST',
        path: '/api/import',
        form,
        signal: options?.signal,
      })
      result.createdNotes += response.createdNotes
      result.updatedNotes += response.updatedNotes
      result.skippedNotes += response.skippedNotes
      result.createdFolders += response.createdFolders
      result.createdAttachments += response.createdAttachments
      result.skippedAttachments += response.skippedAttachments
      result.warnings.push(...response.warnings)
      offset += batch.length
      options?.onProgress?.({
        jobId,
        phase: 'uploading',
        completed: offset,
        total: files.length,
        terminal: offset === files.length,
      })
    }
    return result
  }
}

async function chooseFiles(source: 'files' | 'folder'): Promise<SelectedFile[] | null> {
  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  if (source === 'folder') input.setAttribute('webkitdirectory', '')
  const { promise, resolve } = Promise.withResolvers<SelectedFile[] | null>()
  input.onchange = () => {
    const files = input.files ? [...input.files] : []
    resolve(files.length ? files.map((file) => ({ file, path: file.webkitRelativePath || file.name })) : null)
  }
  input.oncancel = () => resolve(null)
  input.click()
  return promise
}
