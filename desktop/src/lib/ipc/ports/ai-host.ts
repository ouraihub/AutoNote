import { createTauriPorts } from '@ouraihub/aether-ui/tauri'
import { BackendError, type AiHostPort } from '@app/backend'
import type { IpcTransport } from '../transport'

const DATA_URL = /^data:(image\/[\w.+-]+);base64,(.*)$/s

export function aiHostPort(transport: Pick<IpcTransport, 'invoke'>): AiHostPort {
  return {
    kit: createTauriPorts({ providers: true, chat: true, chatHistory: true, search: true }),
    roles: (options) => transport.invoke('ai_roles_get', undefined, options),
    setRole: (role, binding, options) => transport.invoke('ai_roles_set', { role, binding }, options),
    exportMarkdown: async (markdown) => {
      await transport.invoke('ai_reply_export', { markdown })
    },
    // Desktop history inlines images as `data:` URLs; the CSP blocks fetch(data:), so decode locally.
    readImage: async (url) => {
      const [, mime, data] = DATA_URL.exec(url) ?? []
      if (!mime || data === undefined) throw new BackendError('bad_request', 400, 'Unsupported image URL')
      return new Blob([Uint8Array.from(atob(data), (char) => char.charCodeAt(0))], { type: mime })
    },
  }
}
