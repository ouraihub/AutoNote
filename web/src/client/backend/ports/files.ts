import { LIMITS } from '@shared/constants'
import type { Attachment, AttachmentWithUsage } from '@shared/types'
import type { AttachmentPage } from '@shared/backend-types'
import type { CallOptions, FilesPort } from '@app/backend'
import type { HttpTransport } from '../transport'
import { BackendError } from '@app/backend/errors'

export interface FilesPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
}

export class HttpFilesPort implements FilesPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  constructor(deps: FilesPortDeps) {
    this.#transport = deps.transport
  }

  async list(cursor?: string, options?: CallOptions): Promise<AttachmentPage> {
    const result = await this.#transport.json<{ files: AttachmentWithUsage[]; nextCursor?: string | null }>({
      path: '/api/files',
      query: { cursor },
      signal: options?.signal,
    })
    return { files: result.files, nextCursor: result.nextCursor ?? null }
  }
  async upload(file: File, noteId?: string, options?: CallOptions): Promise<Attachment> {
    if (file.size > LIMITS.attachmentMaxBytes)
      throw new BackendError('payload_too_large', 413, 'The file exceeds the 25 MB limit')
    const form = new FormData()
    form.set('file', file)
    if (noteId !== undefined) form.set('noteId', noteId)
    return this.#transport.json<Attachment>({
      method: 'POST',
      path: '/api/files',
      form,
      signal: options?.signal,
    })
  }
  remove(id: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json<{ ok: true }>({
      method: 'DELETE',
      path: `/api/files/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  prune(options?: CallOptions): Promise<{ removed: number; freedBytes: number }> {
    return this.#transport.json<{ removed: number; freedBytes: number }>({
      method: 'POST',
      path: '/api/files/prune',
      signal: options?.signal,
    })
  }
  resolveUrl(url: string): string {
    return url
  }
}
