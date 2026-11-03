import { listen } from '@tauri-apps/api/event'
import type { FlushResult, McpLocalStatus } from '@shared/backend-types'
import type { SyncResponse } from '@shared/types'
import type { SyncStatus } from './ports/remote-sync'
import { cancelled } from './errors'
import { isSyncResponse, record, validateResponse } from './validation'

export class IpcEventListeners {
  #disposed = false
  #listeners = new Set<() => void>()

  async #listen<T>(
    event: string,
    listener: (payload: T) => void,
  ): Promise<() => void> {
    if (this.#disposed) throw cancelled()
    const release = await listen<T>(event, ({ payload }) => {
      if (!this.#disposed) listener(payload)
    })
    if (this.#disposed) {
      release()
      throw cancelled()
    }
    const unlisten = () => {
      release()
      this.#listeners.delete(unlisten)
    }
    this.#listeners.add(unlisten)
    return unlisten
  }

  listenLibrary(
    listener: (payload: SyncResponse) => void,
  ): Promise<() => void> {
    return this.#listen<unknown>('autonote://library-changed', (payload) => {
      if (isSyncResponse(payload)) listener(payload)
    })
  }

  async onPrepareClose(
    flush: () => Promise<FlushResult>,
    closing: (active: boolean) => void,
    acknowledge: (requestId: number, result: FlushResult) => Promise<unknown>,
  ): Promise<() => void> {
    const releaseCancelled = await this.#listen(
      'autonote://close-cancelled',
      () => closing(false),
    )
    try {
      const releasePrepare = await this.#listen<unknown>(
        'autonote://prepare-close',
        (payload) => {
          if (
            !record(payload) ||
            typeof payload.requestId !== 'number' ||
            !Number.isSafeInteger(payload.requestId)
          )
            return
          const requestId = payload.requestId
          closing(true)
          void (async () => {
            let result: FlushResult
            try {
              result = await flush()
            } catch {
              result = { pending: 0, failed: 1 }
            }
            await acknowledge(requestId, result)
          })().catch(() => {
            closing(false)
          })
        },
      )
      return () => {
        releasePrepare()
        releaseCancelled()
        closing(false)
      }
    } catch (error) {
      releaseCancelled()
      throw error
    }
  }

  listenIntents(listener: (intent: 'new-note') => void): Promise<() => void> {
    return this.#listen<unknown>('autonote://ui-intent', (intent) => {
      if (intent === 'new-note') listener(intent)
    })
  }

  listenSyncStatus(
    listener: (status: SyncStatus) => void,
  ): Promise<() => void> {
    return this.#listen<unknown>('autonote://sync-status', (payload) => {
      try {
        validateResponse('sync_status', payload)
      } catch {
        return
      }
      listener(payload as SyncStatus)
    })
  }

  listenMcpStatus(
    listener: (status: McpLocalStatus) => void,
  ): Promise<() => void> {
    return this.#listen<unknown>('autonote://mcp-status', (payload) => {
      if (
        record(payload) &&
        typeof payload.running === 'boolean' &&
        typeof payload.port === 'number' &&
        Number.isInteger(payload.port) &&
        payload.port >= 1024 &&
        payload.port <= 65535 &&
        (payload.endpoint === null || typeof payload.endpoint === 'string') &&
        (payload.error === null || typeof payload.error === 'string')
      )
        listener(payload as unknown as McpLocalStatus)
    })
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const release of this.#listeners) release()
  }
}
