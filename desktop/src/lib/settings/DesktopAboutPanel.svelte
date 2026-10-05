<script lang="ts">
  import { onMount } from 'svelte'
  import { Button } from '@app/components/ui/button'
  import { getI18n } from '@app/root'
  import { call } from '../ipc/transport'
  import type { AppInfo } from '../host/desktop-types'
  const i18n = getI18n()
  let info = $state<AppInfo>()
  let error = $state(false)
  onMount(() => {
    let active = true
    void call('app_info', undefined)
      .then((value) => {
        if (active) info = value
      })
      .catch(() => {
        if (active) error = true
      })
    return () => {
      active = false
    }
  })
</script>

<div class="flex flex-col gap-3">
  {#if info}<dl class="grid grid-cols-[auto_1fr] gap-2 text-sm">
      <dt>{i18n.t('settings.current_version')}</dt>
      <dd>{info.version}</dd>
      <dt>{i18n.t('desktop.schemaVersion')}</dt>
      <dd>{info.schemaVersion}</dd>
      <dt>{i18n.t('settings.data')}</dt>
      <dd class="break-all">{info.dataDir}</dd>
    </dl>{/if}
  <Button
    variant="outline"
    onclick={() =>
      void call('app_open_log_dir', undefined).catch(() => {
        error = true
      })}>{i18n.t('desktop.openLogFolder')}</Button
  >
  {#if error}<p role="alert">{i18n.t('common.action_failed')}</p>{/if}
</div>
