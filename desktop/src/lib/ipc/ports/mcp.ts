import type { LocalMcpPort } from '@app/backend'
import type { McpLocalStatus } from '@shared/backend-types'
import type { IpcTransport } from '../transport'

export class IpcMcpPort implements LocalMcpPort {
  #listeners = new Set<(status: McpLocalStatus) => void>()
  #disposed = false
  #release: (() => void) | undefined
  constructor(private readonly transport: IpcTransport) {}
  async startListening(): Promise<void> {
    const release = await this.transport.listenMcpStatus((status) => {
      for (const listener of this.#listeners) listener(status)
    })
    if (this.#disposed) release()
    else this.#release = release
  }
  status: LocalMcpPort['status'] = (options) => this.transport.invoke('mcp_status', undefined, options)
  start: LocalMcpPort['start'] = (options) => this.transport.invoke('mcp_start', undefined, options)
  stop: LocalMcpPort['stop'] = (options) => this.transport.invoke('mcp_stop', undefined, options)
  setPort: LocalMcpPort['setPort'] = (port, options) => this.transport.invoke('mcp_set_port', { port }, options)
  listKeys: LocalMcpPort['listKeys'] = (options) => this.transport.invoke('mcp_list_keys', undefined, options)
  createKey: LocalMcpPort['createKey'] = (name, options) => this.transport.invoke('mcp_create_key', { name }, options)
  revokeKey: LocalMcpPort['revokeKey'] = (id, options) => this.transport.invoke('mcp_revoke_key', { id }, options)
  getPreferences: LocalMcpPort['getPreferences'] = (options) =>
    this.transport.invoke('mcp_get_preferences', undefined, options)
  savePreferences: LocalMcpPort['savePreferences'] = (patch, options) =>
    this.transport.invoke('mcp_save_preferences', { patch }, options)
  subscribe(listener: (status: McpLocalStatus) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  dispose(): void {
    this.#disposed = true
    this.#release?.()
    this.#listeners.clear()
  }
}
