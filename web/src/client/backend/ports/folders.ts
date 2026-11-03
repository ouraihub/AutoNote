import type { CallOptions, FoldersPort } from '@app/backend'
import type { Folder } from '@shared/types'
import type { FolderCreate, FolderPatch } from '@shared/backend-types'
import type { HttpTransport } from '../transport'

export interface FoldersPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
  readonly beforeRemove?: (
    strategy: 'move-up' | 'delete',
    options?: CallOptions,
  ) => Promise<void>
}

export class HttpFoldersPort implements FoldersPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  readonly #beforeRemove: FoldersPortDeps['beforeRemove']
  constructor(deps: FoldersPortDeps) {
    this.#transport = deps.transport
    this.#beforeRemove = deps.beforeRemove
  }

  async list(options?: CallOptions): Promise<Folder[]> {
    const result = await this.#transport.json<{ folders: Folder[] }>({
      path: '/api/folders',
      signal: options?.signal,
    })
    return result.folders
  }
  create(body: FolderCreate, options?: CallOptions): Promise<Folder> {
    return this.#transport.json<Folder>({
      method: 'POST',
      path: '/api/folders',
      body,
      signal: options?.signal,
    })
  }
  patch(id: string, body: FolderPatch, options?: CallOptions): Promise<Folder> {
    return this.#transport.json<Folder>({
      method: 'PATCH',
      path: `/api/folders/${encodeURIComponent(id)}`,
      body,
      signal: options?.signal,
    })
  }
  async remove(
    id: string,
    strategy: 'move-up' | 'delete',
    options?: CallOptions,
  ): Promise<{ ok: true }> {
    await this.#beforeRemove?.(strategy, options)
    return this.#transport.json<{ ok: true }>({
      method: 'DELETE',
      path: `/api/folders/${encodeURIComponent(id)}`,
      query: { strategy },
      signal: options?.signal,
    })
  }
}
