import type { PrefsStore, PrefValue } from '@app/platform/prefs'
import { BackendError } from '@app/backend/errors'

const PREFS_PREFIX = 'autonote.ui:'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export class WebPrefsStore implements PrefsStore {
  readonly #storage: StorageLike

  constructor(storage: StorageLike = localStorage) {
    this.#storage = storage
  }

  async load(key: string): Promise<unknown> {
    try {
      const value = this.#storage.getItem(this.#key(key))
      return value === null ? undefined : JSON.parse(value)
    } catch {
      throw storageError('read')
    }
  }

  async save(key: string, value: PrefValue): Promise<void> {
    try {
      this.#storage.setItem(this.#key(key), JSON.stringify(value))
    } catch {
      throw storageError('write')
    }
  }

  async remove(key: string): Promise<void> {
    try {
      this.#storage.removeItem(this.#key(key))
    } catch {
      throw storageError('remove')
    }
  }

  #key(key: string): string {
    return `${PREFS_PREFIX}${key}`
  }
}

function storageError(operation: 'read' | 'write' | 'remove'): BackendError {
  return new BackendError('internal', 0, `Preference ${operation} failed`)
}
