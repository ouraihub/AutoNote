<script lang="ts">
  import { onMount } from 'svelte'
  import * as Field from '@app/components/ui/field'
  import { Switch } from '@app/components/ui/switch'
  import { Input } from '@app/components/ui/input'
  import { Button } from '@app/components/ui/button'
  import { getI18n } from '@app/root'
  import { call } from '../ipc/transport'
  import type { DesktopStatus } from '../ipc/commands'
  import LogSettings from '../log/LogSettings.svelte'
  import { isBackendError } from '@app/backend/errors'
  const i18n = getI18n()
  let prefs = $state<DesktopStatus>()
  let busy = $state(false)
  let error = $state<'common.action_failed' | 'desktop.shortcutUnavailable' | null>(null)
  onMount(() => {
    let active = true
    void call('desktop_prefs_get', undefined)
      .then((value) => {
        if (active) prefs = value
      })
      .catch(() => {
        if (active) error = 'common.action_failed'
      })
    return () => {
      active = false
    }
  })
  async function save(): Promise<void> {
    if (!prefs || busy) return
    busy = true
    error = null
    try {
      prefs = await call('desktop_prefs_save', {
        prefs: {
          closeToTray: prefs.closeToTray,
          globalShortcutEnabled: prefs.globalShortcutEnabled,
          globalShortcut: prefs.globalShortcut,
        },
      })
    } catch (cause) {
      error =
        isBackendError(cause) && cause.code === 'conflict' ? 'desktop.shortcutUnavailable' : 'common.action_failed'
    } finally {
      busy = false
    }
  }
</script>

<div class="flex flex-col gap-6">
  {#if prefs}
    <Field.Group>
      <Field.Field orientation="horizontal"
        ><Field.Content
          ><Field.Label for="close-to-tray">{i18n.t('desktop.closeToTray')}</Field.Label><Field.Description
            >{i18n.t('desktop.closeToTrayHint')}</Field.Description
          ></Field.Content
        ><Switch
          id="close-to-tray"
          disabled={busy || !prefs.trayAvailable}
          bind:checked={prefs.closeToTray}
        /></Field.Field
      >
      <Field.Field orientation="horizontal"
        ><Field.Label for="global-shortcut">{i18n.t('desktop.globalShortcut')}</Field.Label><Switch
          id="global-shortcut"
          disabled={busy}
          bind:checked={prefs.globalShortcutEnabled}
        /></Field.Field
      >
      <Field.Field
        ><Field.Label for="shortcut-combo">{i18n.t('desktop.shortcutCombination')}</Field.Label><Input
          id="shortcut-combo"
          disabled={busy}
          bind:value={prefs.globalShortcut}
          maxlength={128}
        /></Field.Field
      >
      <Button disabled={busy} onclick={() => void save()}>{i18n.t('common.save')}</Button>
    </Field.Group>
    {#if !prefs.trayAvailable}<p role="status">{i18n.t('desktop.trayUnavailable')}</p>{/if}
    {#if !prefs.logAvailable}<p role="status">{i18n.t('desktop.logUnavailable')}</p>{/if}
  {/if}
  {#if error}<p role="alert">{i18n.t(error)}</p>{/if}
  <LogSettings />
</div>
