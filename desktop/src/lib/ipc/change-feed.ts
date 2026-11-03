import { ChangeFeedEmitter } from '@app/backend'
import type { CallOptions } from '@app/backend'
import type { SyncResponse } from '@shared/types'
import type { IpcTransport } from './transport'
import { cancelled, invalidResponse } from './errors'

export class IpcChangeFeed extends ChangeFeedEmitter {
  #cursor = 0
  #ready = false
  #disposed = false
  #requested = false
  #running: Promise<void> | null = null
  #snapshot: Promise<SyncResponse> | null = null
  #starting: Promise<void> | null = null
  #release: (() => void) | undefined
  #onFocus = () => {
    void this.reconcile().catch(() =>
      this.emit({ kind: 'connectivity', online: false }),
    )
  }
  constructor(private readonly transport: IpcTransport) {
    super()
  }
  start(): Promise<void> {
    this.#starting ??= (async () => {
      const release = await this.transport.listenLibrary(this.#onFocus)
      if (this.#disposed) {
        release()
        throw cancelled()
      }
      this.#release = release
      window.addEventListener('focus', this.#onFocus)
      document.addEventListener('visibilitychange', this.#onFocus)
    })()
    return this.#starting
  }
  async snapshot(options?: CallOptions): Promise<SyncResponse> {
    if (this.#disposed || options?.signal?.aborted) throw cancelled()
    this.#snapshot ??= (async () => {
      await this.start()
      this.#ready = false
      await this.#running
      const snapshot = await this.transport.invoke(
        'notes_snapshot',
        undefined,
        options,
      )
      if (this.#disposed) throw cancelled()
      this.#cursor = snapshot.cursor
      this.#ready = true
      // Start after the consumer's promise continuation installs the snapshot.
      setTimeout(this.#onFocus, 0)
      return snapshot
    })().finally(() => {
      this.#snapshot = null
    })
    return this.#snapshot
  }
  reconcile(): Promise<void> {
    this.#requested = true
    if (!this.#ready || this.#disposed) return Promise.resolve()
    if (this.#running) return this.#running
    this.#running = (async () => {
      while (this.#requested && this.#ready && !this.#disposed) {
        this.#requested = false
        let more = true
        while (more && !this.#disposed) {
          const before = this.#cursor
          const payload = await this.transport.changesSince(before)
          if (this.#disposed) return
          if (payload.hasMore && payload.cursor <= before)
            throw invalidResponse()
          if (payload.cursor > before || payload.full) {
            this.#cursor = payload.cursor
            this.emit({ kind: 'library', payload })
            if (payload.settingsChanged) this.emit({ kind: 'settings' })
          }
          more = payload.hasMore
        }
      }
      this.emit({ kind: 'connectivity', online: true })
    })().finally(() => {
      this.#running = null
    })
    return this.#running
  }
  override dispose(): void {
    this.#disposed = true
    this.#release?.()
    window.removeEventListener('focus', this.#onFocus)
    document.removeEventListener('visibilitychange', this.#onFocus)
    super.dispose()
  }
}
