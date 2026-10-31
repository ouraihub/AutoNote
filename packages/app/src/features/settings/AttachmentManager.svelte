<script lang="ts">
  import { onMount } from 'svelte'
  import { Dialog as DialogPrimitive } from 'bits-ui'
  import { FileText, Sparkles, Trash2, X } from '@lucide/svelte'
  import type { AttachmentWithUsage } from '@shared/types'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import { getBackend, getI18n, getNotifier } from '@app/root/context'
  import DialogPortal from '@app/components/ui/dialog/dialog-portal.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Segmented from '@app/components/primitives/Segmented.svelte'
  import { formatBytes } from './format'

  type Filter = 'all' | 'image' | 'document' | 'other'
  interface Props {
    onClose: () => void
    onChanged?: () => void
  }
  let { onClose, onChanged }: Props = $props()
  const backend = getBackend()
  const i18n = getI18n()
  const notifier = getNotifier()
  let files = $state<AttachmentWithUsage[]>([])
  let cursor = $state<string | null>(null)
  let loaded = $state(false)
  let busy = $state(false)
  let error = $state<string | null>(null)
  let status = $state<string | null>(null)
  let filter = $state<Filter>('all')
  let controller: AbortController | null = null
  const isImage = (file: AttachmentWithUsage) => file.mime.startsWith('image/')
  const isDocument = (file: AttachmentWithUsage) =>
    !isImage(file) && file.mime !== 'application/octet-stream'
  const visible = $derived(
    files.filter((file) =>
      filter === 'all'
        ? true
        : filter === 'image'
          ? isImage(file)
          : filter === 'document'
            ? isDocument(file)
            : !isImage(file) && !isDocument(file),
    ),
  )

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
      const page = await backend.files.list(pageCursor ?? undefined, {
        signal: request.signal,
      })
      if (request.signal.aborted) return
      const seen = new Set(next ? files.map((file) => file.id) : [])
      files = [
        ...(next ? files : []),
        ...page.files.filter((file) => !seen.has(file.id)),
      ]
      cursor = page.nextCursor
      loaded = true
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (!request.signal.aborted && reason.code !== 'cancelled')
        error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
      controller = null
    }
  }

  async function remove(file: AttachmentWithUsage): Promise<void> {
    if (busy || file.references > 0) return
    busy = true
    if (
      !(await notifier.confirm({
        titleKey: 'attachments.delete_confirm_value0',
        bodyKey: 'settings.cannot_be_undone',
        params: { value0: file.filename },
        danger: true,
      }))
    ) {
      busy = false
      return
    }
    error = null
    status = null
    try {
      await backend.files.remove(file.id)
      files = files.filter((item) => item.id !== file.id)
      onChanged?.()
      status = i18n.t('attachments.deleted')
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (reason.code !== 'cancelled')
        error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
    }
  }

  async function prune(): Promise<void> {
    if (busy) return
    busy = true
    if (
      !(await notifier.confirm({
        titleKey: 'attachments.cleanup_confirm',
        bodyKey: 'attachments.cleanup_confirm_description',
        danger: true,
      }))
    ) {
      busy = false
      return
    }
    error = null
    status = null
    let succeeded = false
    try {
      const result = await backend.files.prune()
      // The backend checks references atomically; this list is never used as deletion authority.
      status = i18n.t(
        result.removed
          ? 'attachments.cleaned_value0'
          : 'attachments.nothing_to_clean',
        { value0: result.removed },
      )
      onChanged?.()
      succeeded = true
    } catch (reason) {
      if (!isBackendError(reason)) throw reason
      if (reason.code !== 'cancelled')
        error = i18n.t(messageKeyForError(reason.code))
    } finally {
      busy = false
    }
    if (succeeded) await load()
  }
</script>

<DialogPrimitive.Root
  open
  onOpenChange={(next) => {
    if (!next) onClose()
  }}
>
  <DialogPortal>
    <div class="app-viewport-fixed fixed z-[230]">
      <DialogPrimitive.Overlay
        class="anim-fade absolute inset-0 bg-[var(--scrim)]"
      />
      <DialogPrimitive.Content
        class="absolute top-0 right-0 bottom-0 flex w-[min(420px,100vw)] flex-col border-l border-[var(--border-default)] bg-[var(--bg-surface)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)] outline-none md:w-[min(420px,calc(100vw-32px))] md:py-0"
        style="animation: ink-slide-in-right var(--dur-slow) var(--ease-out) both"
      >
        <header
          class="flex h-11 shrink-0 items-center justify-between border-b border-[var(--border-subtle)] px-3"
        >
          <DialogPrimitive.Title class="text-[13px] font-semibold"
            >{i18n.t('attachments.manage')}</DialogPrimitive.Title
          >
          <IconButton
            label={i18n.t('common.close')}
            title={i18n.t('common.close')}
            size="sm"
            onclick={onClose}><X size={15} /></IconButton
          >
        </header>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <div class="flex h-full flex-col">
            <div
              class="shrink-0 space-y-2 border-b border-[var(--border-subtle)] p-2"
            >
              <Segmented
                label={i18n.t('attachments.manage')}
                value={filter}
                onChange={(next) => (filter = next)}
                size="sm"
                options={[
                  { value: 'all', label: i18n.t('attachments.filter_all') },
                  {
                    value: 'image',
                    label: i18n.t('attachments.filter_images'),
                  },
                  {
                    value: 'document',
                    label: i18n.t('attachments.filter_documents'),
                  },
                  { value: 'other', label: i18n.t('attachments.filter_other') },
                ]}
              />
              {#if status}<p
                  role="status"
                  class="px-1 text-[11.5px] text-[var(--text-tertiary)]"
                >
                  {status}
                </p>{/if}
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto p-2">
              {#if error}
                <div
                  role="alert"
                  class="space-y-3 px-3 py-8 text-center text-[12px] text-[var(--danger)]"
                >
                  <p>{error}</p>
                  <Button size="sm" onclick={() => void load(loaded)}
                    >{i18n.t('common.retry')}</Button
                  >
                </div>
              {/if}
              {#if !loaded && !error}
                <div
                  role="status"
                  aria-live="polite"
                  class="flex h-full min-h-[160px] flex-col items-center justify-center gap-2.5 text-[var(--text-quaternary)]"
                >
                  <svg
                    aria-hidden="true"
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    class="animate-[ink-spin_.7s_linear_infinite]"
                    ><circle
                      cx="12"
                      cy="12"
                      r="9"
                      stroke="currentColor"
                      stroke-width="2.4"
                      opacity="0.2"
                    /><path
                      d="M21 12a9 9 0 0 0-9-9"
                      stroke="currentColor"
                      stroke-width="2.4"
                      stroke-linecap="round"
                    /></svg
                  >
                  <span class="text-[12px]">{i18n.t('common.loading')}</span>
                </div>
              {:else if loaded && files.length === 0}
                <div
                  class="px-3 py-10 text-center text-[12px] text-[var(--text-quaternary)]"
                >
                  {i18n.t('attachments.empty')}
                </div>
              {:else if loaded && visible.length === 0}
                <div
                  class="px-3 py-10 text-center text-[12px] text-[var(--text-quaternary)]"
                >
                  {i18n.t('attachments.none_match')}
                </div>
              {:else if loaded}
                <div class="grid grid-cols-2 gap-2">
                  {#each visible as file (file.id)}
                    <div
                      class="group overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
                    >
                      <div
                        class="relative flex aspect-[4/3] items-center justify-center overflow-hidden bg-[var(--bg-sunken)]"
                      >
                        {#if isImage(file)}<img
                            src={file.url}
                            alt=""
                            loading="lazy"
                            class="h-full w-full object-cover"
                          />
                        {:else}<FileText
                            size={26}
                            class="text-[var(--text-tertiary)]"
                          />{/if}
                        <div
                          class="absolute top-1.5 right-1.5 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100"
                        >
                          <IconButton
                            label={`${i18n.t('attachments.delete')}: ${file.filename}`}
                            title={i18n.t('attachments.delete')}
                            size="sm"
                            disabled={busy || file.references > 0}
                            onclick={() => void remove(file)}
                            class="border border-[var(--border-default)] bg-[var(--bg-overlay)] shadow-[var(--shadow-pop)] hover:text-[var(--danger)]"
                            ><Trash2 size={13} /></IconButton
                          >
                        </div>
                      </div>
                      <div class="space-y-0.5 px-2 py-1.5">
                        <div
                          class="truncate text-[11.5px] text-[var(--text-secondary)]"
                        >
                          {file.filename}
                        </div>
                        <div
                          class={[
                            'flex items-center gap-1 text-[10.5px]',
                            file.references > 0
                              ? 'text-[var(--text-quaternary)]'
                              : 'text-[var(--warning)]',
                          ]}
                        >
                          <span class="tabular">{formatBytes(file.size)}</span>
                          <span aria-hidden="true">·</span>
                          <span
                            >{file.references > 0
                              ? i18n.t('attachments.referenced_value0', {
                                  value0: file.references,
                                })
                              : i18n.t('attachments.unreferenced')}</span
                          >
                        </div>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>

            <div
              class="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2"
            >
              <span class="text-[11px] text-[var(--text-quaternary)]">
                {loaded
                  ? cursor
                    ? i18n.t('attachments.shown_value0', {
                        value0: visible.length,
                      })
                    : i18n.t('attachments.total_value0', {
                        value0: visible.length,
                      })
                  : ''}
              </span>
              <div class="ml-auto flex items-center gap-2">
                {#if cursor}<Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onclick={() => void load(true)}
                    >{i18n.t('attachments.load_more')}</Button
                  >{/if}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onclick={() => void prune()}
                  ><Sparkles size={13} />{i18n.t('attachments.cleanup')}</Button
                >
              </div>
            </div>
          </div>
        </div>
      </DialogPrimitive.Content>
    </div>
  </DialogPortal>
</DialogPrimitive.Root>
