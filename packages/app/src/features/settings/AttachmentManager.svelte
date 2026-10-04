<script lang="ts">
  import { onMount } from 'svelte'
  import type { AttachmentWithUsage } from '@shared/types'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import { getBackend, getI18n, getNotifier } from '@app/root/context'

  interface Props { onChanged?: () => void }
  let { onChanged }: Props = $props()
  const backend = getBackend()
  const i18n = getI18n()
  const notifier = getNotifier()
  let files = $state<AttachmentWithUsage[]>([])
  let cursor = $state<string | null>(null)
  let loaded = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let status = $state<string | null>(null)
  let filter = $state('all')
  let controller: AbortController | null = null
  const filters = [
    { id: 'all', label: 'attachments.filter_all' },
    { id: 'image', label: 'attachments.filter_images' },
    { id: 'document', label: 'attachments.filter_documents' },
    { id: 'other', label: 'attachments.filter_other' },
  ] as const
  const visible = $derived(files.filter((file) => filter === 'all' || (filter === 'image' ? file.mime.startsWith('image/') : filter === 'document' ? !file.mime.startsWith('image/') && file.mime !== 'application/octet-stream' : !file.mime.startsWith('image/') && file.mime === 'application/octet-stream')))

  onMount(() => {
    void load()
    return () => controller?.abort()
  })

  async function load(next = false): Promise<void> {
    if (busy) return
    busy = true
    error = null
    const request = new AbortController()
    controller = request
    const pageCursor = next ? cursor : null
    if (!next) loaded = false
    try {
      const page = await backend.files.list(pageCursor ?? undefined, { signal: request.signal })
      if (request.signal.aborted) return
      const seen = new Set(next ? files.map((file) => file.id) : [])
      files = [...(next ? files : []), ...page.files.filter((file) => !seen.has(file.id))]
      cursor = page.nextCursor
      loaded = true
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (!request.signal.aborted && reason.code !== 'cancelled') error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
      controller = null
    }
  }

  async function remove(file: AttachmentWithUsage): Promise<void> {
    if (busy || file.references > 0) return
    busy = true
    if (!await notifier.confirm({ titleKey: 'common.delete', bodyKey: 'settings.cannot_be_undone', danger: true })) { busy = false; return }
    error = null
    status = null
    try {
      await backend.files.remove(file.id)
      files = files.filter((item) => item.id !== file.id)
      onChanged?.()
      status = i18n.t('attachments.deleted')
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (reason.code !== 'cancelled') error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
    }
  }

  async function prune(): Promise<void> {
    if (busy) return
    busy = true
    if (!await notifier.confirm({ titleKey: 'attachments.cleanup_confirm', bodyKey: 'attachments.cleanup_confirm_description', danger: true })) { busy = false; return }
    error = null
    status = null
    let succeeded = false
    try {
      const result = await backend.files.prune()
      // The backend checks references atomically; this list is never used as deletion authority.
      status = i18n.t(result.removed ? 'attachments.cleaned_value0' : 'attachments.nothing_to_clean', { value0: result.removed })
      onChanged?.()
      succeeded = true
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (reason.code !== 'cancelled') error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
    }
    if (succeeded) await load()
  }
</script>

<section class="space-y-3" aria-label={i18n.t('attachments.manage')}>
  <div class="flex flex-wrap gap-2">
    {#each filters as option (option.id)}
      <button type="button" aria-pressed={filter === option.id} class="rounded border px-2 py-1 text-sm aria-pressed:bg-accent"
        onclick={() => filter = option.id}>{i18n.t(option.label)}</button>
    {/each}
  </div>
  {#if error}<p role="alert">{error} <button type="button" onclick={() => void load(loaded)}>{i18n.t('common.retry')}</button></p>{/if}
  {#if status}<p role="status">{status}</p>{/if}
  {#if !loaded && !error}<p role="status">{i18n.t('common.loading')}</p>{/if}
  {#if loaded && files.length === 0}<p>{i18n.t('attachments.empty')}</p>{/if}
  {#if loaded && files.length > 0 && visible.length === 0}<p>{i18n.t('attachments.none_match')}</p>{/if}
  <ul class="space-y-2">
    {#each visible as file (file.id)}
      <li class="flex items-center justify-between gap-2 rounded border p-2 text-sm">
        <span class="min-w-0 truncate">{file.filename} · {file.references ? i18n.t('attachments.referenced_value0', { value0: file.references }) : i18n.t('attachments.unreferenced')}</span>
        <button type="button" disabled={busy || file.references > 0} aria-label={`${i18n.t('attachments.delete')}: ${file.filename}`}
          onclick={() => void remove(file)}>{i18n.t('common.delete')}</button>
      </li>
    {/each}
  </ul>
  <div class="flex gap-2">
    {#if cursor}<button type="button" disabled={busy} onclick={() => void load(true)}>{i18n.t('attachments.load_more')}</button>{/if}
    <button type="button" disabled={busy} onclick={() => void prune()}>{i18n.t('attachments.cleanup')}</button>
  </div>
</section>
