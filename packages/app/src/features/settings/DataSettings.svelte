<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertCircle,
    Download,
    FileJson,
    FileUp,
    FolderOpen,
    ImageIcon,
    RefreshCw,
    Sparkles,
    Trash2,
  } from '@lucide/svelte'
  import type { ProgressEvent, ProgressPhase } from '@shared/backend-types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import { getBackend, getI18n, getNotes, getNotifier } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import Select from '@app/components/primitives/Select.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import AttachmentManager from './AttachmentManager.svelte'
  import SettingsLoading from './SettingsLoading.svelte'
  import { formatBytes } from './format'

  const backend = getBackend()
  const notes = getNotes()
  const notifier = getNotifier()
  const phaseLabels: Record<ProgressPhase, MessageKey> = {
    validating: 'settings.transfer_phase_validating',
    reading: 'settings.transfer_phase_reading',
    writing: 'settings.transfer_phase_writing',
    uploading: 'settings.transfer_phase_uploading',
    finalizing: 'settings.transfer_phase_finalizing',
  }
  const i18n = getI18n()
  const overview: { key: string; label: MessageKey }[] = [
    { key: 'notes', label: 'common.note' },
    { key: 'folders', label: 'navigation.folder' },
    { key: 'tags', label: 'navigation.tag' },
    { key: 'links', label: 'common.wiki_links' },
    { key: 'words', label: 'settings.total_words' },
    { key: 'versions', label: 'settings.version_history' },
    { key: 'attachments', label: 'settings.attachments' },
    { key: 'trashed', label: 'navigation.trash' },
  ]
  let stats = $state<Record<string, number> | null>(null)
  let statsError = $state<string | null>(null)
  let error = $state<string | null>(null)
  let status = $state<string | null>(null)
  let busy = $state(false)
  let action = $state<string | null>(null)
  let working = $state<'reindex' | 'prune' | 'trash' | null>(null)
  let progress = $state<ProgressEvent | null>(null)
  let attachmentsOpen = $state(false)
  let conflict = $state<'skip' | 'newer' | 'duplicate'>('newer')
  let controller: AbortController | null = null
  let cancelled = $state(false)
  let statsController: AbortController | null = null

  onMount(() => {
    void loadStats()
    return () => {
      controller?.abort()
      statsController?.abort()
    }
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
      if (!request.signal.aborted && reason.code !== 'cancelled')
        statsError = i18n.t(messageKeyForError(reason.code))
    }
  }
  async function maintain(
    kind: 'reindex' | 'prune' | 'trash',
    task: () => Promise<string | null>,
  ): Promise<void> {
    if (busy || working) return
    working = kind
    error = null
    status = null
    try {
      const message = await task()
      if (message) status = message
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (reason.code !== 'cancelled')
        error = i18n.t(messageKeyForError(reason.code))
    } finally {
      working = null
    }
  }
  const reindex = () =>
    maintain('reindex', async () => {
      const result = await backend.search.reindex()
      return i18n.t('settings.rebuilt_the_index_for_value0_notes', {
        value0: result.indexed,
      })
    })
  const prune = () =>
    maintain('prune', async () => {
      if (
        !(await notifier.confirm({
          titleKey: 'settings.clean_unreferenced_attachments_a17dbd',
          bodyKey:
            'settings.only_files_that_do_not_appear_in_the_body_of_any_note_will_be_deleted_an',
          danger: true,
        }))
      )
        return null
      const result = await backend.files.prune()
      void loadStats()
      return result.removed
        ? `${i18n.t('settings.cleaned_value0_attachments', { value0: result.removed })} · ${i18n.t('settings.freed_value0', { value0: formatBytes(result.freedBytes) })}`
        : i18n.t('settings.there_are_no_attachments_to_clean')
    })
  const emptyTrash = () =>
    maintain('trash', async () => {
      if (
        !(await notifier.confirm({
          titleKey: 'common.empty_trash',
          bodyKey: 'settings.cannot_be_undone',
          danger: true,
        }))
      )
        return null
      const result = await backend.notes.emptyTrash()
      notes.applySync(await backend.notes.snapshot())
      void loadStats()
      return i18n.t('common.permanently_deleted_value0_notes', {
        value0: result.purged,
      })
    })
  async function transfer(
    kind: 'zip' | 'json' | 'files' | 'folder',
  ): Promise<void> {
    if (busy || working) return
    busy = true
    action = kind
    error = null
    status = null
    progress = null
    cancelled = false
    const request = new AbortController()
    controller = request
    try {
      if (kind === 'zip' || kind === 'json') {
        const result = await backend.transfer.exportTo(kind, {
          signal: request.signal,
          onProgress: (event) => {
            if (!request.signal.aborted) progress = event
          },
        })
        if (!request.signal.aborted && result?.saved)
          status = i18n.t('settings.transfer_export_completed')
      } else {
        const result = await backend.transfer.importFrom(kind, conflict, {
          signal: request.signal,
          onProgress: (event) => {
            if (!request.signal.aborted) progress = event
          },
        })
        if (!request.signal.aborted && result) {
          status = i18n.t(
            'settings.created_value0_updated_value1_skipped_value2_restored_value3_attachments',
            {
              value0: result.createdNotes,
              value1: result.updatedNotes,
              value2: result.skippedNotes,
              value3: result.createdAttachments,
              value4: result.skippedAttachments,
            },
          )
          if (result.warnings.length)
            status += ` · ${result.warnings.join('; ')}`
          try {
            const snapshot = await backend.notes.snapshot({
              signal: request.signal,
            })
            if (!request.signal.aborted) notes.applySync(snapshot)
          } catch (reason) {
            if (!isBackendError(reason)) throw reason
            if (!request.signal.aborted && reason.code !== 'cancelled')
              error = i18n.t('settings.operation_completed_but_refresh_failed')
          }
          if (!request.signal.aborted) void loadStats()
        }
      }
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (!request.signal.aborted && reason.code !== 'cancelled')
        error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
      action = null
      controller = null
      progress = null
    }
  }
</script>

<div class="space-y-6">
  <section>
    <h3
      class="mb-2 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.overview')}
    </h3>
    {#if stats === null}
      {#if statsError}
        <div
          role="alert"
          class="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))] bg-[var(--bg-base)] px-3 py-3"
        >
          <AlertCircle size={14} class="mt-0.5 shrink-0 text-[var(--danger)]" />
          <div class="min-w-0 flex-1">
            <div class="text-[12.5px] font-medium text-[var(--text-primary)]">
              {i18n.t('settings.could_not_load_data_overview')}
            </div>
            <p
              class="mt-0.5 break-words text-[11.5px] text-[var(--text-tertiary)]"
            >
              {statsError}
            </p>
          </div>
          <Button size="sm" variant="secondary" onclick={() => void loadStats()}
            >{i18n.t('common.retry')}</Button
          >
        </div>
      {:else}<SettingsLoading />{/if}
    {:else}
      {#if statsError}
        <div
          role="alert"
          class="mb-2 flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_25%,var(--border-subtle))] bg-[var(--bg-base)] px-3 py-2 text-[11.5px] text-[var(--danger)]"
        >
          <AlertCircle size={13} class="mt-0.5 shrink-0" />
          <span class="min-w-0 flex-1 break-words">{statsError}</span>
          <button
            type="button"
            class="shrink-0 font-medium underline underline-offset-2"
            onclick={() => void loadStats()}>{i18n.t('common.retry')}</button
          >
        </div>
      {/if}
      <div class="grid grid-cols-2 gap-2 md:grid-cols-4">
        {#each overview as item (item.key)}
          <div
            class="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2.5"
          >
            <div
              class="text-[17px] font-semibold tabular tracking-[-0.02em] text-[var(--text-primary)]"
            >
              {i18n.formatNumber(stats[item.key] ?? 0)}
            </div>
            <div class="mt-0.5 text-[11px] text-[var(--text-quaternary)]">
              {i18n.t(item.label as MessageKey)}
            </div>
          </div>
        {/each}
      </div>
      {#if stats.attachmentBytes}<p
          class="mt-2 text-[11.5px] text-[var(--text-quaternary)]"
        >
          {i18n.t('settings.attachment_storage')}
          {formatBytes(stats.attachmentBytes)}
        </p>{/if}
    {/if}
  </section>

  <section>
    <h3
      class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.attachments')}
    </h3>
    <SettingRow
      title={i18n.t('attachments.manage')}
      description={i18n.t('attachments.manage_description')}
    >
      <Button size="sm" onclick={() => (attachmentsOpen = true)}
        ><ImageIcon size={13} />{i18n.t('attachments.manage')}</Button
      >
    </SettingRow>
  </section>

  <section>
    <h3
      class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.export')}
    </h3>
    <SettingRow
      title={i18n.t('settings.export_to_zip')}
      description={i18n.t(
        'settings.includes_every_note_folder_tag_and_attachment_for_a_complete_restore_plu',
      )}
    >
      <Button
        size="sm"
        loading={action === 'zip'}
        disabled={busy || working !== null}
        onclick={() => void transfer('zip')}
        >{#if action !== 'zip'}<Download size={13} />{/if}{i18n.t(
          'settings.download_zip',
        )}</Button
      >
    </SettingRow>
    <SettingRow
      title={i18n.t('settings.export_to_json')}
      description={i18n.t(
        'settings.structured_note_data_without_attachment_binaries_download_zip_for_a_comp',
      )}
    >
      <Button
        size="sm"
        variant="ghost"
        loading={action === 'json'}
        disabled={busy || working !== null}
        onclick={() => void transfer('json')}
        >{#if action !== 'json'}<FileJson size={13} />{/if}{i18n.t(
          'settings.download_json',
        )}</Button
      >
    </SettingRow>
  </section>

  <section>
    <h3
      class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.import')}
    </h3>
    <SettingRow title={i18n.t('settings.transfer_conflict')}>
      <Select
        bind:value={conflict}
        disabled={busy}
        aria-label={i18n.t('settings.transfer_conflict')}
        class="w-[200px]"
      >
        <option value="skip">{i18n.t('settings.transfer_skip')}</option>
        <option value="newer">{i18n.t('settings.transfer_newer')}</option>
        <option value="duplicate"
          >{i18n.t('settings.transfer_duplicate')}</option
        >
      </Select>
    </SettingRow>
    {#if backend.transfer.sources.includes('folder')}
      <SettingRow
        title={i18n.t('settings.restore_backup_folder')}
        description={i18n.t('settings.restore_backup_folder_description')}
      >
        <Button
          size="sm"
          loading={action === 'folder'}
          disabled={busy || working !== null}
          onclick={() => void transfer('folder')}
          >{#if action !== 'folder'}<FolderOpen size={13} />{/if}{i18n.t(
            'settings.select_backup_folder',
          )}</Button
        >
      </SettingRow>
    {/if}
    {#if backend.transfer.sources.includes('files')}
      <SettingRow
        title={i18n.t('settings.import_file')}
        description={i18n.t(
          'settings.supports_md_txt_zip_and_autonote_json_exports_for_matching_ids_the_newer',
        )}
      >
        <Button
          size="sm"
          loading={action === 'files'}
          disabled={busy || working !== null}
          onclick={() => void transfer('files')}
          >{#if action !== 'files'}<FileUp size={13} />{/if}{i18n.t(
            'settings.select_file',
          )}</Button
        >
      </SettingRow>
    {/if}
    {#if busy}
      <div
        class="mt-3 flex items-center gap-3 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2.5"
      >
        <div class="min-w-0 flex-1 space-y-1.5">
          <p role="status" class="text-[11.5px] text-[var(--text-secondary)]">
            {#if progress}{i18n.t(phaseLabels[progress.phase])}
              {progress.total === null
                ? i18n.formatNumber(progress.completed)
                : `${i18n.formatNumber(progress.completed)} / ${i18n.formatNumber(progress.total)}`}
            {:else}{i18n.t('common.loading')}{/if}
          </p>
          {#if progress && progress.total !== null && progress.total > 0}
            <progress
              class="h-1 w-full"
              value={progress.completed}
              max={progress.total}
              aria-label={i18n.t('common.loading')}
            ></progress>
          {/if}
        </div>
        <Button size="sm" variant="ghost" disabled={cancelled} onclick={cancel}
          >{i18n.t('common.cancel')}</Button
        >
      </div>
    {/if}
  </section>

  <section>
    <h3
      class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.maintenance')}
    </h3>
    <SettingRow
      title={i18n.t('settings.rebuild_search_index')}
      description={i18n.t(
        'settings.try_this_when_your_search_results_don_t_look_right',
      )}
    >
      <Button
        size="sm"
        variant="secondary"
        loading={working === 'reindex'}
        disabled={busy || working !== null}
        onclick={() => void reindex()}
        >{#if working !== 'reindex'}<RefreshCw size={13} />{/if}{i18n.t(
          'settings.rebuild_index',
        )}</Button
      >
    </SettingRow>
    <SettingRow
      title={i18n.t('settings.clean_unreferenced_attachments')}
      description={i18n.t(
        'settings.delete_pictures_and_files_that_no_longer_appear_in_any_notes',
      )}
    >
      <Button
        size="sm"
        variant="secondary"
        loading={working === 'prune'}
        disabled={busy || working !== null}
        onclick={() => void prune()}
        >{#if working !== 'prune'}<Sparkles size={13} />{/if}{i18n.t(
          'settings.clean_up',
        )}</Button
      >
    </SettingRow>
    <SettingRow
      title={i18n.t('settings.empty_trash')}
      description={i18n.t('settings.permanently_delete_every_note_in_trash')}
    >
      <Button
        size="sm"
        variant="ghost"
        class="text-[var(--danger)]"
        loading={working === 'trash'}
        disabled={busy || working !== null}
        onclick={() => void emptyTrash()}
        >{#if working !== 'trash'}<Trash2 size={13} />{/if}{i18n.t(
          'common.clear',
        )}</Button
      >
    </SettingRow>
  </section>

  {#if error}<p role="alert" class="text-[11.5px] text-[var(--danger)]">
      {error}
    </p>{/if}
  {#if status && !busy}<p
      role="status"
      class="text-[11.5px] text-[var(--text-tertiary)]"
    >
      {status}
    </p>{/if}

  {#if attachmentsOpen}<AttachmentManager
      onClose={() => (attachmentsOpen = false)}
      onChanged={() => void loadStats()}
    />{/if}
</div>
