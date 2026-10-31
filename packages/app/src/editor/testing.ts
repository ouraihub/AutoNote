import { I18nState } from '../i18n/runtime.svelte'
import type { CompletionSources } from './completion'
import type { AttachmentServices } from './paste'
import type { EditorServices } from './services'

const i18n = new I18nState({
  prefs: {
    load: async () => null,
    save: async () => {},
    remove: async () => {},
  },
  systemLocale: 'en-US',
})

/** Test-only editor services: empty completion lists and uploads that fail unless overridden. */
export function createEditorServices(
  overrides: {
    completion?: Partial<CompletionSources>
    attachments?: Partial<AttachmentServices>
  } = {},
): EditorServices {
  return {
    completion: { notes: () => [], tags: () => [], ...overrides.completion },
    attachments: {
      upload: async () => {
        throw new Error('upload is not configured in this test')
      },
      uploadFailed: () => {},
      replaceDetached: () => {},
      ...overrides.attachments,
    },
    t: (key, params) => i18n.t(key, params),
  }
}
