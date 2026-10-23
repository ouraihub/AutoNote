import type { Notifier } from '@app/platform/notifier'
import { syncPort, type SyncStatus } from '../ipc/ports/remote-sync'

/** Asks first; null when the user cancels. Local notes stay and are queued for the next binding. */
export async function confirmUnbind(notifier: Notifier): Promise<SyncStatus | null> {
  const confirmed = await notifier.confirm({
    titleKey: 'desktopSync.unbindTitle',
    bodyKey: 'desktopSync.unbindBody',
    danger: true,
  })
  return confirmed ? syncPort.unbind() : null
}
