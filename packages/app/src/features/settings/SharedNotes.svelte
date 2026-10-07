<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, Copy, ExternalLink, Eye, Link2, RefreshCw, Search, Trash2 } from '@lucide/svelte'
  import type { ShareListItem } from '@shared/types'
  import { getBackend, getI18n, getNotifier, getSession } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cn } from '@app/utils'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const share = backend.kind === 'web' && backend.capabilities.share ? backend.share : undefined
  let items = $state<ShareListItem[] | null>(null)
  let error = $state('')
  let busy = $state(false)
  let revoking = $state<string | null>(null)
  let query = $state('')
  let copied = $state<string | null>(null)
  let copiedTimer = 0
  let active = true
  const visible = $derived.by(() => {
    const needle = query.trim().toLocaleLowerCase()
    return items?.filter((item) => !needle || item.noteTitle.toLocaleLowerCase().includes(needle) || item.url.toLocaleLowerCase().includes(needle)) ?? []
  })
  const fullTime = (value: number) => new Date(value).toLocaleString(i18n.locale)

  async function copy(item: ShareListItem): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.url)
      copied = item.noteId
      window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => (copied = null), 1500)
    } catch {
      notifier.toast({ key: 'preview.could_not_copy', tone: 'error' })
    }
  }

  async function refresh(): Promise<void> {
    if (!share || busy) return
    busy = true
    error = ''
    try {
      const result = await share.list({ signal: session.epochSignal })
      if (active) items = result
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function revoke(noteId: string): Promise<void> {
    if (!share || busy || !await notifier.confirm({ titleKey: 'share.revoke_this_public_link', bodyKey: 'share.anyone_who_gets_the_link_will_immediately_lose_access', danger: true })) return
    busy = true
    revoking = noteId
    try {
      await share.remove(noteId, { signal: session.epochSignal })
      if (active) items = items?.filter((item) => item.noteId !== noteId) ?? null
    } catch (cause) {
      if (active && !session.epochSignal.aborted) notifier.toast({ key: cloudError(cause), tone: 'error' })
    } finally {
      busy = false
      revoking = null
    }
  }

  onMount(() => {
    if (share) void refresh()
    return () => { active = false; window.clearTimeout(copiedTimer) }
  })
</script>

{#if share && session.status === 'authed'}
  <section>
    <div class="mb-2 flex items-center justify-between gap-2">
      <div>
        <h3 class="text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">{i18n.t('share.shared_notes')}</h3>
        <p class="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">{i18n.t('share.shared_notes_description')}</p>
      </div>
      <Button size="sm" variant="ghost" loading={busy && !revoking} disabled={busy} onclick={() => void refresh()} aria-label={i18n.t('share.refresh_list')} title={i18n.t('share.refresh_list')}>
        {#if !busy || revoking}<RefreshCw size={13} />{/if}
      </Button>
    </div>

    {#if items && items.length > 0}
      <div class="relative mb-2">
        <Search size={14} class="pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2 text-[var(--text-quaternary)]" />
        <TextInput bind:value={query} placeholder={i18n.t('share.search_shared_notes')} aria-label={i18n.t('share.search_shared_notes')} class="w-full pl-8" />
      </div>
    {/if}

    {#if error}
      <div role="alert" class="mb-2 flex items-center justify-between gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2 text-[12px] text-[var(--danger)]">
        <span>{i18n.t('share.could_not_load_list')}: {error}</span>
        <Button size="sm" variant="secondary" disabled={busy} onclick={() => void refresh()}>{i18n.t('common.retry')}</Button>
      </div>
    {/if}

    {#if items === null}
      {#if !error}<p role="status" class="py-4 text-center text-[12px] text-[var(--text-tertiary)]">{i18n.t('common.loading')}</p>{/if}
    {:else if items.length === 0}
      <p class="rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-4 text-center text-[12px] text-[var(--text-tertiary)]">{i18n.t('share.no_shared_notes')}</p>
    {:else if visible.length === 0}
      <p class="py-4 text-center text-[12px] text-[var(--text-tertiary)]">{i18n.t('share.no_matching_shares')}</p>
    {:else}
      <div class="divide-y divide-[var(--border-subtle)] overflow-hidden rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
        {#each visible as item (item.noteId)}
          {@const expired = item.expiresAt !== null && item.expiresAt <= Date.now()}
          {@const trashed = item.deletedAt !== null}
          {@const title = item.noteTitle || i18n.t('common.untitled_note')}
          <div class="px-3 py-3">
            <div class="flex items-start justify-between gap-2">
              <span class="min-w-0 truncate text-left text-[13px] font-medium text-[var(--text-primary)]" {title}>{title}</span>
              <span class={cn('shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-medium', trashed || expired ? 'bg-[var(--bg-inset)] text-[var(--text-tertiary)]' : 'bg-[var(--accent-soft)] text-[var(--accent)]')}>
                {trashed ? i18n.t('share.in_trash') : expired ? i18n.t('share.expired') : i18n.t('share.active')}
              </span>
            </div>
            <div class="mt-1.5 flex items-center gap-1.5 text-[11px] text-[var(--text-tertiary)]">
              <Link2 size={12} class="shrink-0" />
              <input readonly value={item.url} aria-label={`${i18n.t('share.public_link')}: ${title}`} onfocus={(event) => event.currentTarget.select()} class="min-w-0 flex-1 truncate bg-transparent text-[11px] text-[var(--text-secondary)] outline-none" />
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--text-quaternary)]">
              <span class="inline-flex items-center gap-1"><Eye size={11} />{item.views}{i18n.t('share.visits')}</span>
              {#if item.hasPassword}<span>{i18n.t('share.passcode_protected')}</span>{/if}
              <span>{item.expiresAt ? i18n.t('share.expires_value0', { value0: fullTime(item.expiresAt) }) : i18n.t('share.never_expires_71ab34')}</span>
              {#if item.createdAt}<span title={fullTime(item.createdAt)}>{i18n.t('common.created')}{fullTime(item.createdAt)}</span>{/if}
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="secondary" onclick={() => void copy(item)}>
                {#if copied === item.noteId}<Check size={12} />{:else}<Copy size={12} />{/if}{copied === item.noteId ? i18n.t('common.copied') : i18n.t('common.copy')}
              </Button>
              <a href={item.url} target="_blank" rel="external noopener noreferrer" class="inline-flex h-7 items-center gap-1 rounded-[var(--r-sm)] px-2 text-[11.5px] font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"><ExternalLink size={12} />{i18n.t('share.open_link')}</a>
              <Button size="sm" variant="ghost" class="text-[var(--danger)]" loading={revoking === item.noteId} disabled={busy} onclick={() => void revoke(item.noteId)}>
                {#if revoking !== item.noteId}<Trash2 size={12} />{/if}{i18n.t('share.revoke_link')}
              </Button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
