<script lang="ts">
  import { getI18n } from '@app/root/context'
  import type { PwaState } from './state.svelte'

  interface Props {
    state?: PwaState
  }
  let { state }: Props = $props()
  const i18n = getI18n()
  // svelte-ignore state_referenced_locally
  const pwa =
    state ??
    (() => {
      throw new Error('PwaPanel requires a PwaState')
    })()

  function warmup(): void {
    pwa.requestOfflineWarmup()
  }
  function install(): void {
    void pwa.install()
  }
  function update(): void {
    void pwa.applyUpdate()
  }
</script>

<section class="space-y-3 border-t pt-4" aria-label={i18n.t('pwa.app_installation')}>
  {#if pwa.operationFailed}<p role="alert">{i18n.t('pwa.operation_failed')}</p>{/if}
  <h3 class="font-semibold">{i18n.t('pwa.app_installation')}</h3>
  {#if pwa.installed}
    <p role="status">{i18n.t('pwa.installed')}</p>
  {:else if pwa.installAvailable}
    <button class="rounded border px-2 py-1" type="button" disabled={pwa.installing} onclick={install}>
      {pwa.installing ? i18n.t('common.loading') : i18n.t('pwa.install')}
    </button>
  {:else}
    <p>{i18n.t('pwa.install_help')}</p>
  {/if}
  <p class="text-sm opacity-80">{i18n.t('pwa.install_description')}</p>

  <div class="space-y-1">
    <h4 class="font-medium">{i18n.t('pwa.complete_offline_access')}</h4>
    <p class="text-sm">{i18n.t('pwa.offline_boundary')}</p>
    {#if pwa.offlineStatus === 'preparing'}
      <p role="status">
        {i18n.t('pwa.preparing_progress', { completed: pwa.offlineCompleted, total: pwa.offlineTotal })}
      </p>
    {:else if pwa.offlineStatus === 'ready'}
      <p role="status">{i18n.t('pwa.offline_ready')}</p>
    {:else if pwa.offlineStatus === 'error'}
      <p role="alert">{i18n.t('pwa.complete_offline_retry_description')}</p>
    {/if}
    <button class="rounded border px-2 py-1" type="button" onclick={warmup}>
      {i18n.t('pwa.complete_offline_access')}
    </button>
  </div>

  {#if pwa.updateAvailable}
    <div class="space-y-2" role="status">
      <p class="font-medium">{i18n.t('pwa.update_ready')}</p>
      <p class="text-sm">{i18n.t('pwa.update_ready_description')}</p>
      {#if pwa.updateBlocked}<p role="alert">{i18n.t('pwa.update_blocked')}</p>{/if}
      <button class="rounded border px-2 py-1" type="button" disabled={pwa.updating} onclick={update}>
        {i18n.t('pwa.refresh_now')}
      </button>
    </div>
  {/if}
</section>
