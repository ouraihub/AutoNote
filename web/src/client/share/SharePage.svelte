<script lang="ts">
  import { onMount } from 'svelte'
  import { KeyRound, Lock, Moon, Sun, X } from '@lucide/svelte'
  import { BackendError } from '@app/backend'
  import Avatar from '@app/components/primitives/Avatar.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Logo from '@app/components/primitives/Logo.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { MarkdownArticle } from '@app/features/preview'
  import LoadingBlock from '@app/features/share/LoadingBlock.svelte'
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { Notifier } from '@app/platform/notifier'
  import type { Logger } from '@app/log/logger'
  import type { RenderServices } from '@app/markdown/embeds'
  import type { MessageKey } from '@shared/locales/en-US'
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


<div class="h-dvh overflow-y-auto overscroll-contain bg-[var(--bg-base)] text-[var(--text-primary)]">
  <header
    class="sticky top-0 z-10 border-b border-[var(--border-subtle)] bg-[var(--bg-base)]/85 pt-[env(safe-area-inset-top)] backdrop-blur"
  >
    <div class="mx-auto flex h-12 max-w-[860px] items-center gap-3 px-4 md:px-5">
      <span class="flex items-center gap-1.5 text-[var(--accent)]"><Logo size={15} /></span>
      <span class="text-[12.5px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
        {shareState.note?.site.name ?? language.t('common.product_name')}
      </span>
      <span class="flex-1"></span>
      <button
        type="button"
        onclick={() => {
          dark = !dark
          document.documentElement.dataset.theme = dark ? 'dark' : 'light'
        }}
        aria-label={language.t('share.switch_theme')}
        title={language.t('share.switch_theme')}
        class="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7"
      >
        {#if dark}<Sun size={14} />{:else}<Moon size={14} />{/if}
      </button>
    </div>
  </header>

  <main class="mx-auto max-w-[860px] px-4 pb-[calc(64px+env(safe-area-inset-bottom))] md:px-5 md:pb-24">
    {#if shareState.status === 'loading'}
      <div class="pt-24"><LoadingBlock label={language.t('share.opening')} /></div>
    {:else if shareState.status === 'passwordRequired'}
      <div class="anim-rise mx-auto max-w-[340px] pt-[16vh] text-center">
        <div
          class="mx-auto mb-4 flex size-12 items-center justify-center rounded-[16px] border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-tertiary)]"
        >
          <Lock size={20} />
        </div>
        <h1 class="text-[16px] font-semibold text-[var(--text-primary)]">
          {language.t('share.this_note_requires_a_password')}
        </h1>
        <p class="mt-1.5 text-[12.5px] text-[var(--text-tertiary)]">
          {language.t('share.ask_the_person_who_shared_this_note_for_its_passcode')}
        </p>
        <form class="mt-5 space-y-2.5" onsubmit={submit}>
          <TextInput
            aria-label={language.t('common.access_passcode')}
            type="password"
            bind:value={password}
            placeholder={language.t('common.access_passcode')}
            autocomplete="current-password"
            maxlength={LIMITS.passwordMaxLength}
            required
            autofocus
            invalid={Boolean(shareState.errorKey)}
          >
            {#snippet leading()}<KeyRound size={13} />{/snippet}
          </TextInput>
          {#if shareState.errorKey}<p role="alert" class="text-[12px] text-[var(--danger)]">
              {language.t(shareState.errorKey as MessageKey)}
            </p>{/if}
          <Button type="submit" variant="primary" block>{language.t('share.view_content')}</Button>
        </form>
      </div>
    {:else if shareState.status === 'ready' && shareState.note}
      {@const note = shareState.note}
      <article class="pt-7 md:pt-10">
        <header class="mb-6 md:mb-8">
          <h1
            class="text-[26px] leading-[1.25] font-bold tracking-[-0.03em] text-[var(--text-primary)] md:text-[30px]"
          >
            {note.title || language.t('common.untitled_note')}
          </h1>
          <div
            class="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-[var(--text-quaternary)]"
          >
            <span class="flex items-center gap-1.5">
              <Avatar src={note.author.avatarUrl} name={note.author.name} size={18} />
              {note.author.name}
            </span>
            <span>·</span>
            <time datetime={new Date(note.updatedAt).toISOString()}>
              {language.formatDate(note.updatedAt, {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
            {#if stats}
              <span>·</span>
              <span>{stats.words}{language.t('common.words')}</span>
              <span>·</span>
              <span>{language.t('common.about')}{readingMinutes(stats.words)}{language.t('common.min')}</span>
            {/if}
          </div>
        </header>

        <div bind:this={host}>
          <MarkdownArticle
            noteId={slug}
            source={note.content}
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

        <footer class="mt-16 border-t border-[var(--border-subtle)] pt-6 text-center">
          <a
            href="/"
            rel="external"
            class="inline-flex items-center gap-1.5 text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:text-[var(--accent)]"
          >
            <Logo size={12} />{language.t('share.shared_via_site', { site: note.site.name })}
          </a>
        </footer>
      </article>
    {:else}
      <div class="mx-auto max-w-[380px] pt-[18vh] text-center">
        <h1 class="text-[16px] font-semibold text-[var(--text-primary)]">
          {language.t('share.content_unavailable')}
        </h1>
        {#if shareState.errorKey}<p role="alert" class="mt-2 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
            {language.t(shareState.errorKey as MessageKey)}
          </p>{/if}
        {#if shareState.retryAfter}<p role="status" class="mt-2 text-[12px] text-[var(--text-quaternary)]">
            {language.t('host.retry_after_seconds', { seconds: shareState.retryAfter })}
          </p>{/if}
        {#if shareState.status === 'failed' && !shareState.retryAfter}
          <Button
            class="mt-5"
            size="sm"
            onclick={() => {
              void shareState.load(slug)
            }}>{language.t('common.retry')}</Button
          >
        {/if}
      </div>
    {/if}
  </main>
</div>
<dialog
  bind:this={dialog}
  aria-label={language.t('preview.image_preview')}
  class="app-viewport-fixed anim-fade m-0 flex max-h-none max-w-none items-center justify-center border-0 bg-transparent p-0 backdrop:bg-[oklch(0%_0_0/78%)] backdrop:backdrop-blur-[2px] not-open:hidden"
  onclose={() => {
    image = null
  }}
>
  <div class="absolute top-[calc(12px+env(safe-area-inset-top))] right-2 md:top-4 md:right-4">
    <IconButton
      label={language.t('common.close')}
      title={language.t('common.close')}
      class="text-white/70 hover:bg-white/10 hover:text-white"
      onclick={() => {
        image = null
      }}><X size={17} /></IconButton
    >
  </div>
  {#if image}<img
      class="max-h-[86vh] max-w-[92vw] rounded-[var(--r-md)] object-contain"
      src={image.src}
      alt={image.alt}
    />{/if}
</dialog>
