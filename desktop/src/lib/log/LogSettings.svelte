<script lang="ts">
  import * as Field from '@app/components/ui/field'
  import { Switch } from '@app/components/ui/switch'
  import LogPanel from './LogPanel.svelte'

  const preferenceKey = 'autonote.desktop.showLogs'
  let showLogs = $state(false)
  let preferenceError = $state('')

  try {
    showLogs = localStorage.getItem(preferenceKey) === 'true'
  } catch {
    preferenceError = '无法读取界面偏好。'
  }

  function setVisibility(checked: boolean): void {
    showLogs = checked
    try {
      localStorage.setItem(preferenceKey, String(checked))
      preferenceError = ''
    } catch {
      preferenceError = '无法保存界面偏好。'
    }
  }
</script>

<div class="flex flex-col gap-5">
  <Field.Group>
    <Field.Field orientation="horizontal">
      <Field.Content>
        <Field.Label for="desktop-show-logs">显示后台日志</Field.Label>
        <Field.Description>日志只在此设置页打开时读取，不影响后台写入。</Field.Description>
      </Field.Content>
      <Switch id="desktop-show-logs" checked={showLogs} onCheckedChange={setVisibility} />
    </Field.Field>
  </Field.Group>
  {#if preferenceError}<p class="text-sm text-destructive" role="alert">{preferenceError}</p>{/if}
  {#if showLogs}<LogPanel />{/if}
</div>
