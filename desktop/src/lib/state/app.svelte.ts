import { tauriClient, type AppClient } from '../ipc/client'
import type { AppInfo } from '../ipc/types'

export class AppState {
  info = $state<AppInfo | null>(null)
  error = $state('')
  loading = $state(false)

  constructor(private readonly client: AppClient = tauriClient) {}

  async load(): Promise<void> {
    this.loading = true
    this.error = ''
    try {
      this.info = await this.client.appInfo()
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.loading = false
    }
  }
}
