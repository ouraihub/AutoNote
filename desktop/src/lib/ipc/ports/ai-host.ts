import { createTauriPorts } from '@ouraihub/aether-ui/tauri'
import type { AiHostPort } from '@app/backend'
import type { IpcTransport } from '../transport'

export function aiHostPort(transport: Pick<IpcTransport, 'invoke'>): AiHostPort {
  return {
    kit: createTauriPorts({ providers: true, chat: true, chatHistory: true, search: true }),
    roles: (options) => transport.invoke('ai_roles_get', undefined, options),
    setRole: (role, binding, options) => transport.invoke('ai_roles_set', { role, binding }, options),
    revealNeedsPassword: false,
    revealKey: async (endpointId, _currentPassword, options) =>
      (await transport.invoke('ai_endpoint_key_reveal', { id: endpointId }, options)).key,
  }
}
