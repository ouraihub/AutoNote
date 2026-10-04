<script lang="ts">
  import { getBackend, getI18n, getNotes, getSettings } from '@app/root/context'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'

  const backend = getBackend()
  const settings = getSettings()
  const notes = getNotes()
  const i18n = getI18n()
  let busy = $state(false)
  let error = $state<string | null>(null)
  let complete = $state(false)
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

<div class="space-y-4">
  {#if settings.error}<p role="alert">{i18n.t(messageKeyForError(settings.error))}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if complete}<p role="status">{i18n.t('settings.reloaded_all_data')}</p>{/if}
  <button type="button" class="rounded border px-3 py-1" disabled={busy} onclick={() => void syncNow()}>{i18n.t('settings.sync_now')}</button>
  {#if backend.capabilities.realtime}
    <label class="flex items-center gap-2 text-sm"><input type="checkbox" checked={settings.current.sync.realtime}
      onchange={(event) => settings.update({ sync: { realtime: event.currentTarget.checked } })} />{i18n.t('settings.realtime_sync')}</label>
  {/if}
  <label class="flex items-center gap-2 text-sm">{i18n.t('settings.polling_interval')}
    <input type="range" min="5" max="120" step="5" value={settings.current.sync.pollIntervalMs / 1000}
      oninput={(event) => settings.update({ sync: { pollIntervalMs: Number(event.currentTarget.value) * 1000 } })} />
    <output>{settings.current.sync.pollIntervalMs / 1000}{i18n.t('settings.sec')}</output>
  </label>
</div>
