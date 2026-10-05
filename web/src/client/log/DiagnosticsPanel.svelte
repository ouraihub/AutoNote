<script lang="ts">
  import { getI18n, getLogger } from '@app/root'
  import { browserCapabilities } from '../platform'
  import { APP_VERSION } from '../../release'
  import { ConsoleRingLogger } from './console-ring-logger'
  const i18n = getI18n()
  const logger = getLogger()
  function download(): void {
    if (!(logger instanceof ConsoleRingLogger)) return
    const report = {
      version: APP_VERSION,
      capabilities: {
        serviceWorker: browserCapabilities.serviceWorker,
        indexedDb: 'indexedDB' in globalThis,
        broadcastChannel: 'BroadcastChannel' in globalThis,
        locks: browserCapabilities.locks,
        online: browserCapabilities.online,
      },
      entries: logger.entries(),
    }
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'autonote-diagnostics.json'
    document.body.append(link)
    try {
      link.click()
    } finally {
      link.remove()
      URL.revokeObjectURL(url)
    }
  }
</script>

<p class="text-sm text-[var(--text-tertiary)]">{i18n.t('host.diagnostics_notice')}</p>
<button type="button" class="mt-3 rounded border border-[var(--border-default)] p-2" onclick={download}
  >{i18n.t('host.diagnostics_export')}</button
>
