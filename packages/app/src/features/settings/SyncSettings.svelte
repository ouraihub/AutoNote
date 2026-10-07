<script lang="ts">
  import { online } from 'svelte/reactivity/window'
  import { CheckCircle2, CloudOff, RefreshCw } from '@lucide/svelte'
  import { getBackend, getI18n, getNotes, getSettings } from '@app/root/context'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Slider from '@app/components/primitives/Slider.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'

  const backend = getBackend()
  const settings = getSettings()
  const notes = getNotes()
  const i18n = getI18n()
  let busy = $state(false)
  let error = $state<string | null>(null)
  let complete = $state(false)
  const connected = $derived(online.current !== false)
  const pending = $derived(Object.keys(notes.dirtyById ?? {}).length)
  async function syncNow(): Promise<void> {
    if (busy) return
    busy = true
    error = null
    complete = false
    try {
      if (backend.notes.syncNow) {
        await backend.notes.syncNow()
        notes.applySync(await backend.notes.snapshot())
      } else notes.applySync(await backend.notes.snapshot())
      complete = true
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (reason.code !== 'cancelled') error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
    }
  }
</script>

<div class="space-y-6">
  <section class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
    <div class="flex items-center gap-2.5">
      <span class={connected ? 'text-[var(--success)]' : 'text-[var(--warning)]'}>
        {#if connected}<CheckCircle2 size={16} />{:else}<CloudOff size={16} />{/if}
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-[13px] font-medium text-[var(--text-primary)]">
          {connected ? i18n.t('settings.connected') : i18n.t('settings.offline')}
        </div>
        {#if !connected}<div class="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
            {pending
              ? i18n.t('settings.value0_changes_will_upload_automatically_after_reconnecting', { value0: pending })
              : i18n.t('settings.changes_are_saved_locally_and_sync_automatically_after_reconnecting')}
          </div>{/if}
      </div>
      <Button size="sm" variant="secondary" loading={busy} onclick={() => void syncNow()}
        >{#if !busy}<RefreshCw size={12} />{/if}{i18n.t('settings.sync_now')}</Button
      >
    </div>
    {#if settings.error}<p role="alert" class="mt-2 text-[11.5px] text-[var(--danger)]">
        {i18n.t(messageKeyForError(settings.error))}
      </p>{/if}
    {#if error}<p role="alert" class="mt-2 text-[11.5px] text-[var(--danger)]">{error}</p>{/if}
    {#if complete}<p role="status" class="mt-2 text-[11.5px] text-[var(--text-tertiary)]">
        {i18n.t('settings.reloaded_all_data')}
      </p>{/if}
  </section>

  <section>
    {#if backend.capabilities.realtime}
      <SettingRow
        title={i18n.t('settings.realtime_sync')}
        description={i18n.t('settings.receive_changes_from_other_devices_quickly')}
      >
        <Switch
          checked={settings.current.sync.realtime}
          onChange={(realtime) => settings.update({ sync: { realtime } })}
          label={i18n.t('settings.realtime_sync')}
        />
      </SettingRow>
    {/if}

    <SettingRow title={i18n.t('settings.polling_interval')}>
      <Slider
        label={i18n.t('settings.polling_interval')}
        class="w-[200px]"
        value={Math.round(settings.current.sync.pollIntervalMs / 1000)}
        min={5}
        max={120}
        step={5}
        onChange={(seconds) => settings.update({ sync: { pollIntervalMs: seconds * 1000 } })}
        suffix={i18n.t('settings.sec')}
      />
    </SettingRow>
  </section>
</div>
