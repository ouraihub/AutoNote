import type { CallOptions, TagsPort } from '@app/backend'
import type { Tag } from '@shared/types'
import type { TagCreate, TagPatch, TagPatchResult } from '@shared/backend-types'
import type { HttpTransport } from '../transport'

export interface TagsPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
  readonly beforeTextChange?: (options?: CallOptions) => Promise<void>
}

export class HttpTagsPort implements TagsPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  readonly #beforeTextChange: TagsPortDeps['beforeTextChange']
  constructor(deps: TagsPortDeps) {
    this.#transport = deps.transport
    this.#beforeTextChange = deps.beforeTextChange
  }

  async list(options?: CallOptions): Promise<Tag[]> {
    const result = await this.#transport.json<{ tags: Tag[] }>({
      path: '/api/tags',
      signal: options?.signal,
    })
    return result.tags
  }
  create(body: TagCreate, options?: CallOptions): Promise<Tag> {
    return this.#transport.json<Tag>({
      method: 'POST',
      path: '/api/tags',
      body,
      signal: options?.signal,
    })
  }
  async patch(
    id: string,
    body: TagPatch,
    options?: CallOptions,
  ): Promise<TagPatchResult> {
    if (body.name !== undefined) await this.#beforeTextChange?.(options)
    const result = await this.#transport.json<
      Tag | { ok: true; renamed: number }
    >({
      method: 'PATCH',
      path: `/api/tags/${encodeURIComponent(id)}`,
      body,
      signal: options?.signal,
    })
    return 'renamed' in result
      ? { tag: null, renamed: result.renamed }
      : { tag: result, renamed: 0 }
  }
  async remove(
    id: string,
    options?: CallOptions,
  ): Promise<{ ok: true; affected: number }> {
    await this.#beforeTextChange?.(options)
    return this.#transport.json<{ ok: true; affected: number }>({
      method: 'DELETE',
      path: `/api/tags/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
}
