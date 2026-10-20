import { BackendError, type AiHostPort } from '@app/backend'
import type { HttpTransport } from '../transport'
import { createHttpKitPorts } from './kit'

export function createHttpAiHostPort(transport: Pick<HttpTransport, 'json' | 'raw'>): AiHostPort {
  return {
    kit: createHttpKitPorts(transport),
    roles: (options) => transport.json({ path: '/api/ai/roles', signal: options?.signal }),
    setRole: (role, binding, options) =>
      transport.json({ method: 'PUT', path: '/api/ai/roles', body: { role, binding }, signal: options?.signal }),
    readImage: async (url, options) => {
      if (!isKitPath(url)) throw new BackendError('bad_request', 400, 'Unsupported image URL')
      return (await transport.raw({ path: url, signal: options?.signal })).blob()
    },
  }
}

function isKitPath(url: string): url is `/api/${string}` {
  return url.startsWith('/api/ai/kit/')
}
