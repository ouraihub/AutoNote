import type { CallOptions, UpdatePort } from '@app/backend'
import type { UpdateCheckResponse } from '@shared/types'
import type { HttpTransport } from '../transport'

export interface UpdatePortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
}
export class HttpUpdatePort implements UpdatePort {
  readonly #transport: UpdatePortDeps['transport']
  constructor(deps: UpdatePortDeps) {
    this.#transport = deps.transport
  }
  check(options?: CallOptions): Promise<UpdateCheckResponse> {
    return this.#transport.json({ path: '/api/update', signal: options?.signal, timeoutMs: 10_000 })
  }
}
