import type { BackupPort, CallOptions } from '@app/backend'
import type {
  BackupRun,
  BackupTarget,
  BackupTargetInput,
  BackupTargetPatchInput,
  TestConnectionResult,
} from '@shared/types'
import type { HttpTransport } from '../transport'

export interface BackupPortDeps {
  readonly transport: Pick<HttpTransport, 'json'>
}
export class HttpBackupPort implements BackupPort {
  readonly #transport: BackupPortDeps['transport']
  constructor(deps: BackupPortDeps) {
    this.#transport = deps.transport
  }
  async targets(options?: CallOptions): Promise<BackupTarget[]> {
    const result = await this.#transport.json<{ targets: BackupTarget[] }>({
      path: '/api/backup/targets',
      signal: options?.signal,
    })
    return result.targets
  }
  create(body: BackupTargetInput, options?: CallOptions): Promise<BackupTarget> {
    return this.#transport.json({ method: 'POST', path: '/api/backup/targets', body, signal: options?.signal })
  }
  patch(id: string, body: BackupTargetPatchInput, options?: CallOptions): Promise<BackupTarget> {
    return this.#transport.json({
      method: 'PATCH',
      path: `/api/backup/targets/${encodeURIComponent(id)}`,
      body,
      signal: options?.signal,
    })
  }
  remove(id: string, options?: CallOptions): Promise<{ ok: true }> {
    return this.#transport.json({
      method: 'DELETE',
      path: `/api/backup/targets/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  test(id: string, body: Partial<BackupTargetInput>, options?: CallOptions): Promise<TestConnectionResult> {
    return this.#transport.json({
      method: 'POST',
      path: `/api/backup/targets/${encodeURIComponent(id)}/test`,
      body,
      signal: options?.signal,
    })
  }
  testDraft(body: BackupTargetInput, options?: CallOptions): Promise<TestConnectionResult> {
    return this.#transport.json({ method: 'POST', path: '/api/backup/test', body, signal: options?.signal })
  }
  run(targetIds?: readonly string[], options?: CallOptions): Promise<BackupRun> {
    return this.#transport.json({
      method: 'POST',
      path: '/api/backup/run',
      body: targetIds ? { targetIds } : {},
      signal: options?.signal,
    })
  }
  async runs(options?: CallOptions): Promise<BackupRun[]> {
    const result = await this.#transport.json<{ runs: BackupRun[] }>({
      path: '/api/backup/runs',
      signal: options?.signal,
    })
    return result.runs
  }
}
