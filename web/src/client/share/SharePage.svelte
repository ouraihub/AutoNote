<script lang="ts">
  import { onMount } from 'svelte'
  import { BackendError } from '@app/backend'
  import { MarkdownArticle } from '@app/features/preview'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import type { Logger } from '@app/log/logger'
  import type { RenderServices } from '@app/markdown/embeds'
  import { countText, readingMinutes } from '@shared/markdown-utils'
  import { LIMITS } from '@shared/constants'
  import { SharePageState } from './share-page.svelte'
  import { addShareAccess } from './share-access'
  import type { FetchLike } from '../backend/transport'

  interface Props {
    slug: string
    fetch: FetchLike
    logger: Logger
    language: I18nState
    notifier: Notifier
    clientId: string
    resolveFileUrl?(url: string): string
  }
  let { slug, fetch, logger, language, notifier, clientId, resolveFileUrl }: Props = $props()
  // svelte-ignore state_referenced_locally
  const shareState = new SharePageState({
    fetch,
    logger,
    clientId,
    origin: location.origin,
    getLocale: () => language.locale,
  })
  let password = $state('')
  let dark = $state(document.documentElement.dataset.theme === 'dark')
  let host = $state<HTMLDivElement>()
  let image = $state<HTMLImageElement | null>(null)
  let dialog = $state<HTMLDialogElement>()
  const originalTitle = document.title
  let appliedTitle: string | null = null
  const stats = $derived(shareState.note ? countText(shareState.note.content) : null)
  const resolveAssetUrl = (url: string): string => {
    const shared = addShareAccess(url, slug, location.origin)
    return resolveFileUrl ? resolveFileUrl(shared) : shared
  }
  const services: RenderServices = {
    resolveNote: async () => null,
    resolveAssetUrl,
    openNote: () =>
      notifier.toast({ key: 'share.embedded_private_notes_are_not_included_in_public_shares', tone: 'info' }),
    toggleTask: async () => {
      throw new BackendError('forbidden', 403, 'Public shares are read-only')
    },
  }
  $effect(() => {
    const currentSlug = slug
    void shareState.load(currentSlug)
  })
  $effect(() => {
    const note = shareState.note
    if (!note) return
    appliedTitle = `${note.title || language.t('common.untitled_note')} · ${note.site.name}`
    document.title = appliedTitle
  })
  $effect(() => {
    if (image && dialog && !dialog.open) dialog.showModal()
    if (!image && dialog?.open) dialog.close()
  })
  $effect(() => {
    if (shareState.retryAfter <= 0) return
    const timer = window.setTimeout(() => {
      shareState.retryAfter = Math.max(0, shareState.retryAfter - 1)
    }, 1000)
    return () => window.clearTimeout(timer)
  })
  onMount(() => () => {
    shareState.dispose()
    if (appliedTitle && document.title === appliedTitle) document.title = originalTitle
  })
  const prepareLinks = (): void => {
    for (const link of host?.querySelectorAll<HTMLAnchorElement>('a[href]') ?? []) {
      const raw = link.getAttribute('href') ?? ''
      if (!raw.startsWith('#')) link.href = resolveAssetUrl(raw)
    }
  }
  const submit = (event: SubmitEvent): void => {
    event.preventDefault()
    const submitted = password
    password = ''
    void shareState.load(slug, submitted)
  }
</script>

<div class="h-dvh overflow-y-auto bg-[var(--bg-base)] text-[var(--text-primary)]">
  <header class="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-base)]">
    <div class="mx-auto flex max-w-[860px] items-center gap-3 px-5 py-3">
      <img src="/autonote-logo.png" width="24" height="24" alt="" />
      <span class="font-semibold">{shareState.note?.site.name ?? language.t('common.product_name')}</span>
      <button
        class="ml-auto rounded p-2 hover:bg-[var(--bg-hover)]"
        type="button"
        onclick={() => {
          dark = !dark
          document.documentElement.dataset.theme = dark ? 'dark' : 'light'
        }}
        aria-label={language.t('share.switch_theme')}>{language.t(dark ? 'settings.light' : 'settings.dark')}</button
      >
    </div>
  </header>
  <main class="mx-auto max-w-[860px] px-5 pb-16 pt-8">
    {#if shareState.status === 'loading'}<p role="status">{language.t('share.opening')}</p>
    {:else if shareState.status === 'passwordRequired'}
      <section class="mx-auto max-w-sm py-16">
        <h1 class="text-xl font-semibold">{language.t('share.this_note_requires_a_password')}</h1>
        <p class="my-3 text-[var(--text-tertiary)]">
          {language.t('share.ask_the_person_who_shared_this_note_for_its_passcode')}
        </p>
        <form onsubmit={submit} class="grid gap-3">
          <label for="share-password">{language.t('share.passcode')}</label><input
            id="share-password"
            class="rounded border border-[var(--border-default)] bg-[var(--bg-surface)] p-2"
            type="password"
            bind:value={password}
            autocomplete="off"
            maxlength={LIMITS.passwordMaxLength}
            required
          />{#if shareState.errorKey}<p role="alert">{language.t(shareState.errorKey)}</p>{/if}<button
            class="rounded bg-[var(--accent)] p-2 text-[var(--text-on-accent)]"
            type="submit">{language.t('share.view_content')}</button
          >
        </form>
      </section>
    {:else if shareState.status === 'ready' && shareState.note}
      <h1 class="text-3xl font-bold">{shareState.note.title || language.t('common.untitled_note')}</h1>
      <div class="my-4 flex flex-wrap items-center gap-3 text-sm text-[var(--text-tertiary)]">
        {#if shareState.note.author.avatarUrl}<img
            class="rounded-full"
            src={resolveAssetUrl(shareState.note.author.avatarUrl)}
            width="24"
            height="24"
            alt=""
          />{/if}<span>{shareState.note.author.name}</span><time
          datetime={new Date(shareState.note.updatedAt).toISOString()}
          >{new Date(shareState.note.updatedAt).toLocaleString(language.locale)}</time
        >{#if stats}<span
            >{stats.words} {language.t('common.words')} · {readingMinutes(stats.words)} {language.t('common.min')}</span
          >{/if}
      </div>
      <div bind:this={host}>
        <MarkdownArticle
          noteId={slug}
          source={shareState.note.content}
          {services}
          math={true}
          mermaid={true}
          {dark}
          collapseLines={24}
          publicReadonly={true}
          onHeadings={() => undefined}
          onReady={prepareLinks}
          onImage={(value) => {
            image = value
          }}
          onTag={() => undefined}
        />
      </div>
      <footer class="mt-12 border-t border-[var(--border-subtle)] pt-5">
        <button type="button" class="text-[var(--accent)]" onclick={() => location.assign('/')}
          >{language.t('share.shared_via_site', { site: shareState.note.site.name })}</button
        >
      </footer>
    {:else}<h1 class="text-xl font-semibold">{language.t('share.content_unavailable')}</h1>
      {#if shareState.errorKey}<p role="alert" class="my-3">
          {language.t(shareState.errorKey)}
        </p>{/if}{#if shareState.retryAfter}<p role="status">
          {language.t('host.retry_after_seconds', { seconds: shareState.retryAfter })}
        </p>{/if}{#if shareState.status === 'failed' && !shareState.retryAfter}<button
          type="button"
          class="my-3 rounded border border-[var(--border-default)] p-2"
          onclick={() => {
            void shareState.load(slug)
          }}>{language.t('common.retry')}</button
        >{/if}
    {/if}
  </main>
</div>
<dialog
  bind:this={dialog}
  class="max-h-[90vh] max-w-[90vw] rounded bg-[var(--bg-base)] p-4 text-[var(--text-primary)]"
  onclose={() => {
    image = null
  }}
>
  <button
    type="button"
    class="mb-3 rounded border border-[var(--border-default)] p-2"
    onclick={() => {
      image = null
    }}>{language.t('common.close')}</button
  >{#if image}<img class="max-h-[75vh] max-w-full" src={image.src} alt={image.alt} />{/if}
</dialog>
