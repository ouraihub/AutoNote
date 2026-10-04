import type { CallOptions, SettingsPort } from '@app/backend'
import type { SettingsPatch } from '@shared/backend-types'
import type { UserSettings } from '@shared/types'
import type { HttpTransport } from '../transport'
import type { TabBus } from '../tab-bus'

export interface SettingsPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
  readonly bus: TabBus
  readonly clientId: string
}

/** Settings HTTP port; patch confirmation is only returned after the worker accepts it. */
export class HttpSettingsPort implements SettingsPort {
  readonly #transport: Pick<HttpTransport, 'json'>
  readonly #bus: TabBus
  readonly #clientId: string

  constructor(deps: SettingsPortDeps) {
    this.#transport = deps.transport
    this.#bus = deps.bus
    this.#clientId = deps.clientId
  }

  get(options?: CallOptions): Promise<UserSettings> {
    return this.#transport.json({ path: '/api/settings', signal: options?.signal })
  }

  async save(patch: SettingsPatch, options?: CallOptions): Promise<UserSettings> {
    const result = await this.#transport.json<UserSettings>({
      method: 'PUT',
      path: '/api/settings',
      body: patch,
      signal: options?.signal,
    })
    if (!options?.signal?.aborted) this.#bus.post({ type: 'settings-changed', clientId: this.#clientId })
    return result
  }

  stats(options?: CallOptions): Promise<Record<string, number>> {
    return this.#transport.json({ path: '/api/settings/stats', signal: options?.signal })
  }
}

export function createHttpSettingsPort(deps: SettingsPortDeps): SettingsPort {
  return new HttpSettingsPort(deps)
}
