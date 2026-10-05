<script lang="ts">
  import { onMount } from 'svelte'
  import * as Field from '@app/components/ui/field'
  import { Switch } from '@app/components/ui/switch'
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

<div class="flex flex-col gap-5">
  <Field.Group>
    <Field.Field orientation="horizontal">
      <Field.Content>
        <Field.Label for="desktop-show-logs">{i18n.t('desktop.showLogs')}</Field.Label>
        <Field.Description>{i18n.t('desktop.showLogsHint')}</Field.Description>
      </Field.Content>
      <Switch id="desktop-show-logs" checked={showLogs} onCheckedChange={setVisibility} />
    </Field.Field>
  </Field.Group>
  {#if preferenceError}<p class="text-sm text-destructive" role="alert">{i18n.t(preferenceError)}</p>{/if}
  {#if showLogs}<LogPanel />{/if}
</div>
