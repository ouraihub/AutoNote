import type { CallOptions, RemoteMcpPort } from '@app/backend'
import type {
  McpAiSearchStatus,
  McpApiKey,
  McpPreferences,
  McpSettingsInfo,
} from '@shared/types'
import type { HttpTransport } from '../transport'

export interface RemoteMcpPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
}
export class HttpRemoteMcpPort implements RemoteMcpPort {
  readonly #transport: RemoteMcpPortDeps['transport']
  constructor(deps: RemoteMcpPortDeps) {
    this.#transport = deps.transport
  }
  async listKeys(options?: CallOptions): Promise<McpApiKey[]> {
    return (await this.get(options)).apiKeys
  }
  async createKey(
    name: string,
    options?: CallOptions,
  ): Promise<{ key: McpApiKey; token: string }> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/mcp/keys',
      body: { name },
      signal: options?.signal,
    })
  }
  revokeKey(id: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({
      method: 'DELETE',
      path: `/api/mcp/keys/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  async getPreferences(options?: CallOptions): Promise<McpPreferences> {
    return (await this.get(options)).preferences
  }
  async savePreferences(
    patch: Partial<Pick<McpPreferences, 'writeEnabled' | 'trashEnabled'>>,
    options?: CallOptions,
  ): Promise<McpPreferences> {
    const result = await this.#transport.json<{ preferences: McpPreferences }>({
      method: 'PUT',
      path: '/api/mcp',
      body: patch,
      signal: options?.signal,
    })
    return result.preferences
  }
  get(options?: CallOptions): Promise<McpSettingsInfo> {
    return this.#transport.json({ path: '/api/mcp', signal: options?.signal })
  }
  setEnabled(
    enabled: boolean,
    options?: CallOptions,
  ): Promise<{
    enabled: boolean
    preferences: McpPreferences
    reconnectRequired: boolean
  }> {
    return this.#transport.json({
      method: 'PUT',
      path: '/api/mcp',
      body: { enabled },
      signal: options?.signal,
    })
  }
  revokeGrant(id: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({
      method: 'DELETE',
      path: `/api/mcp/grants/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  revokeAllGrants(
    options?: CallOptions,
  ): Promise<{ ok: true; revoked: number }> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/mcp/grants/revoke-all',
      signal: options?.signal,
    })
  }
  saveAiSearch(
    enabled: boolean,
    options?: CallOptions,
  ): Promise<McpAiSearchStatus> {
    return this.#transport.json({
      method: 'PUT',
      path: '/api/mcp/ai-search',
      body: { enabled },
      signal: options?.signal,
    })
  }
  reindexAiSearch(
    options?: CallOptions,
  ): Promise<McpAiSearchStatus & { ok: true; enqueued: number }> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/mcp/ai-search/reindex',
      signal: options?.signal,
    })
  }
  clearAiSearch(options?: CallOptions): Promise<{ ok: true; removed: number }> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/mcp/ai-search/clear',
      signal: options?.signal,
    })
  }
}
