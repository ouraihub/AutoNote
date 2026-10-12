import type { AiHostPort } from '@app/backend'
import type { HttpTransport } from '../transport'
import { createHttpKitPorts } from './kit'

export function createHttpAiHostPort(transport: Pick<HttpTransport, 'json' | 'raw'>): AiHostPort {
  return {
    kit: createHttpKitPorts(transport),
    roles: (options) => transport.json({ path: '/api/ai/roles', signal: options?.signal }),
    setRole: (role, binding, options) =>
      transport.json({ method: 'PUT', path: '/api/ai/roles', body: { role, binding }, signal: options?.signal }),
    revealNeedsPassword: true,
    revealKey: async (endpointId, currentPassword, options) =>
      (
        await transport.json<{ key: string }>({
          method: 'POST',
          path: `/api/ai/endpoints/${encodeURIComponent(endpointId)}/key`,
          body: { currentPassword },
          signal: options?.signal,
        })
      ).key,
  }
}
