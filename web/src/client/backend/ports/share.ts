import type { CallOptions, SharePort } from '@app/backend'
import type { ShareInfo, ShareListItem } from '@shared/types'
import type { HttpTransport } from '../transport'

export interface SharePortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
}
export class HttpSharePort implements SharePort {
  readonly #transport: SharePortDeps['transport']
  constructor(deps: SharePortDeps) {
    this.#transport = deps.transport
  }
  async list(options?: CallOptions): Promise<ShareListItem[]> {
    const result = await this.#transport.json<{ shares: ShareListItem[] }>({
      path: '/api/share',
      signal: options?.signal,
    })
    return result.shares
  }
  async get(noteId: string, options?: CallOptions): Promise<ShareInfo | null> {
    const result = await this.#transport.json<{ share: ShareInfo | null }>({
      path: `/api/share/${encodeURIComponent(noteId)}`,
      signal: options?.signal,
    })
    return result.share
  }
  async create(
    noteId: string,
    body: { password?: string; expiresIn?: number },
    options?: CallOptions,
  ): Promise<ShareInfo> {
    const result = await this.#transport.json<{ share: ShareInfo }>({
      method: 'POST',
      path: `/api/share/${encodeURIComponent(noteId)}`,
      body,
      signal: options?.signal,
    })
    return result.share
  }
  remove(noteId: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({
      method: 'DELETE',
      path: `/api/share/${encodeURIComponent(noteId)}`,
      signal: options?.signal,
    })
  }
}
