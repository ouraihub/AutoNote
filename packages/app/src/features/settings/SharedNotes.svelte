<script lang="ts">
  import { onMount } from 'svelte'
  import type { ShareListItem } from '@shared/types'
  import { getBackend, getI18n, getNotifier, getSession } from '@app/root/context'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const share = backend.kind === 'web' && backend.capabilities.share ? backend.share : undefined
  let items = $state<ShareListItem[] | null>(null)
  let error = $state('')
  let busy = $state(false)
  let active = true

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
    error = ''
    try {
      await share.remove(noteId, { signal: session.epochSignal })
      if (active) items = items?.filter((item) => item.noteId !== noteId) ?? null
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  onMount(() => {
    if (share) void refresh()
    return () => { active = false }
  })
</script>

{#if share && session.status === 'authed'}
  <section class="space-y-3">
    <p>{i18n.t('share.shared_notes_description')}</p>
    <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => void refresh()}>{i18n.t('share.refresh_list')}</button>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if items === null && !error}<p role="status">{i18n.t('common.loading')}</p>
    {:else if items?.length === 0}<p>{i18n.t('share.no_shared_notes')}</p>
    {:else if items}
      <ul class="divide-y rounded border">
        {#each items as item (item.noteId)}
          <li class="space-y-2 p-3">
            <strong>{item.noteTitle || i18n.t('common.untitled_note')}</strong>
            <p><a class="break-all underline" href={item.url} target="_blank" rel="external noopener noreferrer">{item.url}</a></p>
            <p>{i18n.t('share.visits')}: {item.views} · {item.deletedAt ? i18n.t('share.in_trash') : item.expiresAt && item.expiresAt <= Date.now() ? i18n.t('share.expired') : i18n.t('share.active')}</p>
            <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => void revoke(item.noteId)}>{i18n.t('share.revoke_link')}</button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}
