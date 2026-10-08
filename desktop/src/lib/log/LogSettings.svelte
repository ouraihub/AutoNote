<script lang="ts">
  import { onMount } from 'svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'
  import LogPanel from './LogPanel.svelte'
  import { getI18n } from '@app/root'

  const i18n = getI18n()

  const preferenceKey = 'autonote.desktop.showLogs'
  let showLogs = $state(false)
  let preferenceError = $state<'desktop.prefsReadFailed' | 'desktop.prefsSaveFailed' | null>(null)

  onMount(() => {
    try {
      showLogs = localStorage.getItem(preferenceKey) === 'true'
    } catch {
      preferenceError = 'desktop.prefsReadFailed'
    }
  })

  function setVisibility(checked: boolean): void {
    showLogs = checked
    try {
      localStorage.setItem(preferenceKey, String(checked))
      preferenceError = null
    } catch {
      preferenceError = 'desktop.prefsSaveFailed'
    }
  }
</script>

<section>
  <SettingRow title={i18n.t('desktop.showLogs')} description={i18n.t('desktop.showLogsHint')}>
    <Switch id="desktop-show-logs" checked={showLogs} onChange={setVisibility} label={i18n.t('desktop.showLogs')} />
  </SettingRow>
  {#if preferenceError}<p class="mt-2 text-[11.5px] text-[var(--danger)]" role="alert">
      {i18n.t(preferenceError)}
    </p>{/if}
  {#if showLogs}<div class="mt-3"><LogPanel /></div>{/if}
</section>
