<script lang="ts">
  import { onMount } from 'svelte'
  import type { ProgressEvent, ProgressPhase } from '@shared/backend-types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import { getBackend, getI18n, getNotes } from '@app/root/context'
  import AttachmentManager from './AttachmentManager.svelte'

  const backend = getBackend()
  const notes = getNotes()
  const phaseLabels: Record<ProgressPhase, MessageKey> = {
    validating: 'settings.transfer_phase_validating', reading: 'settings.transfer_phase_reading',
    writing: 'settings.transfer_phase_writing', uploading: 'settings.transfer_phase_uploading',
    finalizing: 'settings.transfer_phase_finalizing',
  }
  const i18n = getI18n()
  let stats = $state<Record<string, number> | null>(null)
  let statsError = $state<string | null>(null)
  let error = $state<string | null>(null)
  let status = $state<string | null>(null)
  let busy = $state(false)
  let progress = $state<ProgressEvent | null>(null)
  let attachmentsOpen = $state(false)
  let conflict = $state<'skip' | 'newer' | 'duplicate'>('newer')
  let controller: AbortController | null = null
  let cancelled = $state(false)
  let statsController: AbortController | null = null

  onMount(() => {
    void loadStats()
    return () => { controller?.abort(); statsController?.abort() }
  })
  function cancel(): void {
    cancelled = true
    controller?.abort()
  }
  async function loadStats(): Promise<void> {
    statsController?.abort()
    const request = new AbortController()
    statsController = request
    statsError = null
    try {
      const result = await backend.settings.stats({ signal: request.signal })
      if (!request.signal.aborted) stats = result
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (!request.signal.aborted && reason.code !== 'cancelled') statsError = i18n.t(messageKeyForError(reason.code))
    }
  }
  async function transfer(action: 'zip' | 'json' | 'files' | 'folder'): Promise<void> {
    if (busy) return
    busy = true
    error = null
    status = null
    progress = null
    cancelled = false
    const request = new AbortController()
    controller = request
    try {
      if (action === 'zip' || action === 'json') {
        const result = await backend.transfer.exportTo(action, { signal: request.signal, onProgress: (event) => { if (!request.signal.aborted) progress = event } })
        if (!request.signal.aborted && result?.saved) status = i18n.t('settings.transfer_export_completed')
      } else {
        const result = await backend.transfer.importFrom(action, conflict, { signal: request.signal, onProgress: (event) => { if (!request.signal.aborted) progress = event } })
        if (!request.signal.aborted && result) {
          status = i18n.t('settings.created_value0_updated_value1_skipped_value2_restored_value3_attachments', {
            value0: result.createdNotes, value1: result.updatedNotes, value2: result.skippedNotes,
            value3: result.createdAttachments, value4: result.skippedAttachments,
          })
          if (result.warnings.length) status += ` · ${result.warnings.join('; ')}`
          try {
            const snapshot = await backend.notes.snapshot({ signal: request.signal })
            if (!request.signal.aborted) notes.applySync(snapshot)
          } catch (reason) {
            if (!isBackendError(reason)) throw reason
            if (!request.signal.aborted && reason.code !== 'cancelled') error = i18n.t('settings.operation_completed_but_refresh_failed')
          }
          if (!request.signal.aborted) void loadStats()
        }
      }
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (!request.signal.aborted && reason.code !== 'cancelled') error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
      controller = null
      progress = null
    }
  }
</script>

<div class="space-y-5">
  <section class="space-y-2">
    <h3 class="font-medium">{i18n.t('settings.overview')}</h3>
    {#if statsError}<p role="alert">{statsError} <button type="button" onclick={() => void loadStats()}>{i18n.t('common.retry')}</button></p>{/if}
    {#if stats}
      <dl class="grid grid-cols-2 gap-2 text-sm">
        {#each Object.entries(stats) as [name, count] (name)}
          <div><dt>{name}</dt><dd>{i18n.formatNumber(count)}</dd></div>
        {/each}
      </dl>
    {:else if !statsError}<p role="status">{i18n.t('common.loading')}</p>{/if}
  </section>
  <section class="space-y-2">
    <button type="button" onclick={() => attachmentsOpen = !attachmentsOpen}>{i18n.t('attachments.manage')}</button>
    {#if attachmentsOpen}<AttachmentManager onChanged={() => void loadStats()} />{/if}
  </section>
  <section class="space-y-2">
    <h3 class="font-medium">{i18n.t('settings.export')}</h3>
    <div class="flex gap-2">
      <button type="button" disabled={busy} onclick={() => void transfer('zip')}>{i18n.t('settings.download_zip')}</button>
      <button type="button" disabled={busy} onclick={() => void transfer('json')}>{i18n.t('settings.download_json')}</button>
    </div>
  </section>
  <section class="space-y-2">
    <h3 class="font-medium">{i18n.t('settings.import')}</h3>
    <label class="flex items-center gap-2 text-sm">{i18n.t('settings.transfer_conflict')}
      <select class="rounded border p-1" bind:value={conflict} disabled={busy}>
        <option value="skip">{i18n.t('settings.transfer_skip')}</option>
        <option value="newer">{i18n.t('settings.transfer_newer')}</option>
        <option value="duplicate">{i18n.t('settings.transfer_duplicate')}</option>
      </select>
    </label>
    {#each backend.transfer.sources as source (source)}
      <button type="button" disabled={busy} class="mr-3" onclick={() => void transfer(source)}>
        {source === 'files' ? i18n.t('settings.select_file') : i18n.t('settings.select_backup_folder')}
      </button>
    {/each}
  </section>
  {#if busy}
    <button type="button" disabled={cancelled} onclick={cancel}>{i18n.t('common.cancel')}</button>
    {#if progress}
      <p role="status">{i18n.t(phaseLabels[progress.phase])} {progress.total === null ? i18n.formatNumber(progress.completed) : `${i18n.formatNumber(progress.completed)} / ${i18n.formatNumber(progress.total)}`}</p>
      {#if progress.total !== null && progress.total > 0}
        <progress value={progress.completed} max={progress.total} aria-label={i18n.t('common.loading')}></progress>
      {/if}
    {:else}<p role="status">{i18n.t('common.loading')}</p>{/if}
  {/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if status && !busy}<p role="status">{status}</p>{/if}
</div>
