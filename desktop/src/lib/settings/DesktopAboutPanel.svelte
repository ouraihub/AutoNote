<script lang="ts">
  import { onMount } from 'svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
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

<section>
  {#if info}
    <SettingRow title={i18n.t('settings.current_version')}
      ><span class="text-[12.5px] text-[var(--text-secondary)] tabular"
        >{info.version}</span
      ></SettingRow
    >
    <SettingRow title={i18n.t('desktop.schemaVersion')}
      ><span class="text-[12.5px] text-[var(--text-secondary)] tabular"
        >{info.schemaVersion}</span
      ></SettingRow
    >
    <SettingRow title={i18n.t('settings.data')} description={info.dataDir}>
      <Button
        size="sm"
        onclick={() =>
          void call('app_open_log_dir', undefined).catch(() => {
            error = true
          })}>{i18n.t('desktop.openLogFolder')}</Button
      >
    </SettingRow>
  {/if}
  {#if error}<p role="alert" class="mt-2 text-[11.5px] text-[var(--danger)]">
      {i18n.t('common.action_failed')}
    </p>{/if}
</section>
