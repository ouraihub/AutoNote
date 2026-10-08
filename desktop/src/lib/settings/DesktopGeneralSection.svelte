<script lang="ts">
  import { onMount } from 'svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import { getI18n } from '@app/root'
  import { call } from '../ipc/transport'
  import type { DesktopStatus } from '../ipc/commands'
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

<div class="space-y-6">
  {#if prefs}
    <section>
      <SettingRow title={i18n.t('desktop.closeToTray')} description={i18n.t('desktop.closeToTrayHint')}>
        <Switch
          id="close-to-tray"
          label={i18n.t('desktop.closeToTray')}
          disabled={busy || !prefs.trayAvailable}
          checked={prefs.closeToTray}
          onChange={(next) => prefs && (prefs.closeToTray = next)}
        />
      </SettingRow>
      <SettingRow title={i18n.t('desktop.globalShortcut')}>
        <Switch
          id="global-shortcut"
          label={i18n.t('desktop.globalShortcut')}
          disabled={busy}
          checked={prefs.globalShortcutEnabled}
          onChange={(next) => prefs && (prefs.globalShortcutEnabled = next)}
        />
      </SettingRow>
      <SettingRow title={i18n.t('desktop.shortcutCombination')}>
        <TextInput
          id="shortcut-combo"
          aria-label={i18n.t('desktop.shortcutCombination')}
          class="w-[200px]"
          disabled={busy}
          bind:value={prefs.globalShortcut}
          maxlength={128}
        />
      </SettingRow>
      <div class="flex justify-end pt-3">
        <Button variant="primary" size="sm" loading={busy} onclick={() => void save()}>{i18n.t('common.save')}</Button>
      </div>
      {#if !prefs.trayAvailable}<p role="status" class="mt-2 text-[11.5px] text-[var(--text-tertiary)]">
          {i18n.t('desktop.trayUnavailable')}
        </p>{/if}
      {#if !prefs.logAvailable}<p role="status" class="mt-2 text-[11.5px] text-[var(--text-tertiary)]">
          {i18n.t('desktop.logUnavailable')}
        </p>{/if}
    </section>
  {/if}
  {#if error}<p role="alert" class="text-[11.5px] text-[var(--danger)]">{i18n.t(error)}</p>{/if}
</div>
