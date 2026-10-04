import type { MessageKey } from '@shared/locales/en-US'
import type { MessageParams } from '../i18n/runtime.svelte'
import type { CompletionSources } from './completion'
import type { AttachmentServices } from './paste'

/** Everything a `CodeEditor` needs from its container; the editor never touches the Backend directly. */
export interface EditorServices {
  readonly completion: CompletionSources
  readonly attachments: AttachmentServices
  t(key: MessageKey, params?: MessageParams): string
}
