import { BackendError } from '@app/backend'
import type { PrefValue, PrefsStore } from '@app/platform/prefs'
export class DesktopPrefs implements PrefsStore {
  async load(key: string): Promise<unknown> {
    try {
      const value = localStorage.getItem(`autonote.ui:${key}`)
      return value === null ? undefined : JSON.parse(value)
    } catch {
      throw new BackendError('internal', 0, 'Preference read failed')
    }
  }
  async save(key: string, value: PrefValue): Promise<void> {
    try {
      localStorage.setItem(`autonote.ui:${key}`, JSON.stringify(value))
    } catch {
      throw new BackendError('internal', 0, 'Preference write failed')
    }
  }
  async remove(key: string): Promise<void> {
    try {
      localStorage.removeItem(`autonote.ui:${key}`)
    } catch {
      throw new BackendError('internal', 0, 'Preference remove failed')
    }
  }
}
