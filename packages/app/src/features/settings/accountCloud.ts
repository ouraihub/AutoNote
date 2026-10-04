import { isBackendError } from '@app/backend'
import { messageKeyForError } from '@app/i18n/errors'
import type { MessageKey } from '@shared/locales/en-US'

// Never surface raw server exception messages: they may contain credentials or URLs.
export function cloudError(error: unknown): MessageKey {
  return isBackendError(error) ? messageKeyForError(error.code) : 'common.action_failed'
}
