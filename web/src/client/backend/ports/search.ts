import type { CallOptions, SearchPort } from '@app/backend'
import type { GraphQuery, GraphResponse, SearchResponse } from '@shared/types'
import type { HttpTransport } from '../transport'

export interface SearchPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
}

export class HttpSearchPort implements SearchPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  constructor(deps: SearchPortDeps) {
    this.#transport = deps.transport
  }

  query(query: string, limit?: number, options?: CallOptions): Promise<SearchResponse> {
    return this.#transport.json<SearchResponse>({
      path: '/api/search',
      query: { q: query, limit },
      signal: options?.signal,
    })
  }
  graph(input: GraphQuery, options?: CallOptions): Promise<GraphResponse> {
    return this.#transport.json<GraphResponse>({
      path: '/api/graph',
      query: { ...input, includeOrphans: input.includeOrphans, includeUnresolved: input.includeUnresolved },
      signal: options?.signal,
    })
  }
  reindex(options?: CallOptions): Promise<{ ok: true; indexed: number }> {
    return this.#transport.json<{ ok: true; indexed: number }>({
      method: 'POST',
      path: '/api/search/reindex',
      signal: options?.signal,
    })
  }
}
