import type { TransferPort } from '@app/backend'
import type { IpcTransport } from '../transport'

export function transferPort(transport: IpcTransport): TransferPort {
  return {
    sources: ['files', 'folder'],
    exportTo: (format, options) =>
      transport.invokeJob('transfer_export', { format }, options),
    importFrom: (source, conflict, options) =>
      transport.invokeJob('transfer_import', { source, conflict }, options),
  }
}
