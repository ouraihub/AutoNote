import type { CallOptions, RelayKey, RelayPort, RelayRepo, RelaySettingsInfo } from '@app/backend'
import type { HttpTransport } from '../transport'

export class HttpRelayPort implements RelayPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  constructor(deps: { readonly transport: Pick<HttpTransport, 'json'> }) {
    this.#transport = deps.transport
  }
  get(options?: CallOptions): Promise<RelaySettingsInfo> {
    return this.#transport.json({ path: '/api/relay', signal: options?.signal })
  }
  setEnabled(enabled: boolean, options?: CallOptions): Promise<{ enabled: boolean }> {
    return this.#transport.json({ method: 'PUT', path: '/api/relay', body: { enabled }, signal: options?.signal })
  }
  createKey(name: string, options?: CallOptions): Promise<{ key: RelayKey; token: string }> {
    return this.#transport.json({ method: 'POST', path: '/api/relay/keys', body: { name }, signal: options?.signal })
  }
  revokeKey(id: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({
      method: 'DELETE',
      path: `/api/relay/keys/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  addRepo(repo: string, workflow: string, ref: string, options?: CallOptions): Promise<{ repos: RelayRepo[] }> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/relay/repos',
      body: { repo, workflow, ref },
      signal: options?.signal,
    })
  }
  removeRepo(repo: string, options?: CallOptions): Promise<{ repos: RelayRepo[] }> {
    const [owner = '', name = ''] = repo.split('/')
    return this.#transport.json({
      method: 'DELETE',
      path: `/api/relay/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      signal: options?.signal,
    })
  }
}
