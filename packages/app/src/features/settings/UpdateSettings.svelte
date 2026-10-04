<script lang="ts">
  import type { UpdateCheckResponse } from '@shared/types'
  import { getBackend, getI18n, getSession } from '@app/root/context'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const update = backend.kind === 'web' && backend.capabilities.updateCheck && session.user?.role === 'owner' ? backend.update : undefined
  let check = $state<UpdateCheckResponse | null>(null)
  let busy = $state(false)
  let error = $state('')

  async function refresh(): Promise<void> {
    if (!update || busy) return
    busy = true
    error = ''
    try { check = await update.check({ signal: session.epochSignal }) }
    catch (cause) { if (!session.epochSignal.aborted) error = i18n.t(cloudError(cause)) }
    finally { busy = false }
  }
</script>

{#if update && session.status === 'authed' && session.user?.role === 'owner'}
  <section class="space-y-2 border-t pt-4">
    <h3 class="font-semibold">{i18n.t('settings.deployment_updates')}</h3>
    <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => void refresh()}>{i18n.t('settings.recheck_updates')}</button>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if check}
      <p>{i18n.t('settings.current_version')}: {check.currentVersion}</p>
      {#if check.status === 'unavailable'}<p>{i18n.t('settings.update_check_unavailable')}</p>
      {:else if check.latestVersion && check.latestVersion !== check.currentVersion}
        <p>{i18n.t('settings.latest_version')}: {check.latestVersion}</p>
        {#if check.updateUrl}<a class="underline" href={check.updateUrl} target="_blank" rel="external noopener noreferrer">{i18n.t('settings.go_to_update')}</a>{/if}
        <p>{i18n.t('settings.update_manual_fork_hint')}</p>
      {:else if check.latestVersion}<p>{i18n.t('settings.up_to_date')}</p>{/if}
    {/if}
  </section>
{/if}
