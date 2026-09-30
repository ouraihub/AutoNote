import type { SyncResponse } from '@shared/types'
import type { WriteQueueEvent } from '@shared/backend-types'

export type ChangeEvent =
  | { kind: 'sync'; payload: SyncResponse }
  | { kind: 'library'; payload: SyncResponse }
  | { kind: 'write'; payload: WriteQueueEvent }
  | { kind: 'settings' }
  | { kind: 'connectivity'; online: boolean }

export type ChangeListener = (event: ChangeEvent) => void
export type Unsubscribe = () => void

export interface ChangeFeed {
  subscribe(listener: ChangeListener): Unsubscribe
}

export class ChangeFeedEmitter implements ChangeFeed {
  #listeners = new Set<ChangeListener>()
  #disposed = false

  subscribe(listener: ChangeListener): Unsubscribe {
    if (this.#disposed) return () => {}

    this.#listeners.add(listener)
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      this.#listeners.delete(listener)
    }
  }

  emit(event: ChangeEvent): void {
    if (this.#disposed) return
    for (const listener of [...this.#listeners]) listener(event)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#listeners.clear()
  }
}
