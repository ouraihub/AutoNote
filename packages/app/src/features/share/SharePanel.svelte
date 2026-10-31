<script lang="ts">
  import {
    Check,
    Copy,
    ExternalLink,
    Eye,
    Globe,
    Link2,
    Lock,
    Trash2,
  } from '@lucide/svelte'
  import { LIMITS } from '@shared/constants'
  import type { ShareInfo } from '@shared/types'
  import type { MessageKey } from '@shared/locales/en-US'
  import Button from '@app/components/primitives/Button.svelte'
  import Empty from '@app/components/primitives/Empty.svelte'
  import FormField from '@app/components/primitives/FormField.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cloudError } from '@app/features/settings/accountCloud'
  import {
    getBackend,
    getI18n,
    getNotes,
    getNotifier,
    getSession,
    getUi,
  } from '@app/root/context'
  import { cn } from '@app/utils'
  import LoadingBlock from './LoadingBlock.svelte'

  let { onClose }: { onClose: () => void } = $props()
  const backend = getBackend()
  const ui = getUi()
  const notes = getNotes()
  const i18n = getI18n()
  const notifier = getNotifier()
  const session = getSession()
  const port = backend.capabilities.share ? backend.share : undefined
  const KEEP = 'current'
  const EXPIRY: { value: string; key: MessageKey }[] = [
    { value: '0', key: 'share.never_expires' },
    { value: String(24 * 3600000), key: 'share.1_day' },
    { value: String(7 * 24 * 3600000), key: 'share.7_days' },
    { value: String(30 * 24 * 3600000), key: 'share.30_days' },
  ]
  const noteId = $derived(ui.activeNoteId)
  const note = $derived(noteId ? notes.summaries[noteId] : undefined)
  let share = $state<ShareInfo | null | undefined>(undefined)
  let loadError = $state<MessageKey | null>(null)
  let reload = $state(0)
  let password = $state('')
  let usePassword = $state(false)
  let expiry = $state('0')
  let busy = $state<'save' | 'revoke' | null>(null)
  let copied = $state(false)
  let copiedTimer = 0
  let epoch = 0
  const expiryOptions = $derived([
    ...(share?.expiresAt
      ? [{ value: KEEP, key: 'share.keep_current_expiration' as MessageKey }]
      : []),
    ...EXPIRY,
  ])
  const fullTime = (value: number): string =>
    i18n.formatDate(value, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  $effect(() => {
    const id = noteId
    void reload
    const current = ++epoch
    busy = null
    share = undefined
    loadError = null
    password = ''
    usePassword = false
    expiry = '0'
    copied = false
    if (!id || !port) return
    port.get(id, { signal: session.epochSignal }).then(
      (result) => {
        if (current !== epoch) return
        share = result
        usePassword = Boolean(result?.hasPassword)
        expiry = result?.expiresAt ? KEEP : '0'
      },
      (cause: unknown) => {
        if (current === epoch && !session.epochSignal.aborted)
          loadError = cloudError(cause)
      },
    )
    return () => {
      epoch++
      window.clearTimeout(copiedTimer)
    }
  })

  function fail(cause: unknown): void {
    if (!session.epochSignal.aborted)
      notifier.toast({ key: cloudError(cause), tone: 'error' })
  }

  async function create(): Promise<void> {
    if (!port || !noteId || busy || share === undefined || loadError) return
    if (usePassword && password.length > 0 && password.length < 4) {
      notifier.toast({ key: 'share.passcode_too_short', tone: 'error' })
      return
    }
    if (usePassword && !share?.hasPassword && !password) {
      notifier.toast({ key: 'share.enter_a_passcode', tone: 'error' })
      return
    }
    const id = noteId
    const current = ++epoch
    const wasShared = Boolean(share)
    const body: { password?: string; expiresIn?: number } = usePassword
      ? password
        ? { password }
        : {}
      : { password: '' }
    if (expiry !== KEEP) body.expiresIn = Number(expiry)
    busy = 'save'
    try {
      const result = await port.create(id, body, {
        signal: session.epochSignal,
      })
      if (current !== epoch) return
      share = result
      password = ''
      expiry = result.expiresAt ? KEEP : '0'
      notifier.toast({
        key: wasShared
          ? 'share.sharing_settings_updated'
          : 'share.public_link_created',
        tone: 'success',
      })
    } catch (cause) {
      if (current === epoch) fail(cause)
    } finally {
      if (current === epoch) busy = null
    }
  }

  async function revoke(): Promise<void> {
    if (!port || !noteId || busy) return
    const id = noteId
    const current = ++epoch
    const previous = { share, usePassword, expiry }
    busy = 'revoke'
    try {
      const ok = await notifier.confirm({
        titleKey: 'share.revoke_this_public_link',
        bodyKey: 'share.anyone_who_gets_the_link_will_immediately_lose_access',
        danger: true,
      })
      if (current !== epoch || !ok) return
      share = null
      usePassword = false
      expiry = '0'
      await port.remove(id, { signal: session.epochSignal })
      if (current === epoch)
        notifier.toast({ key: 'share.link_revoked', tone: 'info' })
    } catch (cause) {
      if (current !== epoch) return
      ;({ share, usePassword, expiry } = previous)
      fail(cause)
    } finally {
      if (current === epoch) busy = null
    }
  }

  async function copy(): Promise<void> {
    if (!share) return
    const current = epoch
    try {
      await navigator.clipboard.writeText(share.url)
      if (current !== epoch) return
      copied = true
      window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => (copied = false), 1400)
    } catch {
      if (current === epoch)
        notifier.toast({ key: 'preview.could_not_copy', tone: 'error' })
    }
  }

  function expiryKeydown(event: KeyboardEvent, index: number): void {
    const last = expiryOptions.length - 1
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    const option = next === null ? undefined : expiryOptions[next]
    if (!option) return
    event.preventDefault()
    expiry = option.value
    const group = (event.currentTarget as HTMLElement).parentElement
    group
      ?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
      [next ?? 0]?.focus()
  }
</script>

{#if port && note}
  <Modal
    open
    {onClose}
    title={i18n.t('share.share_note')}
    description={`"${note.title || i18n.t('common.untitled_note')}"`}
    width={480}
  >
    {#if loadError}
      <Empty
        art="notes"
        compact
        title={i18n.t('share.could_not_load_sharing_status')}
        description={i18n.t(loadError as MessageKey)}
      >
        {#snippet action()}<Button
            size="sm"
            variant="secondary"
            onclick={() => reload++}>{i18n.t('common.retry')}</Button
          >{/snippet}
      </Empty>
    {:else if share === undefined}
      <LoadingBlock label={i18n.t('share.loading_share_status')} />
    {:else}
      <div class="space-y-4">
        {#if share}
          <div
            class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3"
          >
            <div class="flex items-center gap-2">
              <Link2 size={13} class="shrink-0 text-[var(--accent)]" />
              <input
                aria-label={i18n.t('share.public_link')}
                readonly
                value={share.url}
                onfocus={(event) => event.currentTarget.select()}
                class="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-[var(--text-secondary)] focus:outline-none"
              />
              <Button
                size="sm"
                variant={copied ? 'ghost' : 'secondary'}
                onclick={() => void copy()}
              >
                {#if copied}<Check
                    size={12}
                    class="text-[var(--success)]"
                  />{:else}<Copy size={12} />{/if}
                {i18n.t(copied ? 'common.copied' : 'common.copy')}
              </Button>
              <a
                href={share.url}
                target="_blank"
                rel="external noopener noreferrer"
                aria-label={i18n.t('share.open_link')}
                title={i18n.t('share.open_link')}
                class="inline-flex size-9 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-7"
              >
                <ExternalLink size={13} />
              </a>
            </div>
            <div
              class="mt-2.5 flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-2.5 text-[11px] text-[var(--text-quaternary)]"
            >
              <span class="flex items-center gap-1"
                ><Eye size={11} />{share.views}{i18n.t('share.visits')}</span
              >
              {#if share.hasPassword}<span
                  class="tabular inline-flex items-center rounded-full bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] px-[7px] py-[1px] text-[11px] font-medium text-[var(--warning)]"
                  >{i18n.t('share.passcode_protected')}</span
                >{/if}
              {#if share.expiresAt}
                <span
                  class={cn(
                    share.expiresAt < Date.now() && 'text-[var(--danger)]',
                  )}
                >
                  {share.expiresAt < Date.now()
                    ? i18n.t('share.expired')
                    : i18n.t('share.expires_value0', {
                        value0: fullTime(share.expiresAt),
                      })}
                </span>
              {:else}
                <span>{i18n.t('share.never_expires_71ab34')}</span>
              {/if}
              <span class="ml-auto"
                >{i18n.t('common.created')} {fullTime(share.createdAt)}</span
              >
            </div>
          </div>
        {/if}

        <div class="flex items-center justify-between gap-4 py-1">
          <div class="min-w-0">
            <div class="flex items-center gap-1.5 text-[13px] font-medium">
              <Lock size={12} class="text-[var(--text-tertiary)]" />{i18n.t(
                'common.access_passcode',
              )}
            </div>
            <p class="mt-0.5 text-[11.5px] text-[var(--text-tertiary)]">
              {i18n.t('share.require_a_passcode_to_view_this_note')}
            </p>
          </div>
          <Switch
            checked={usePassword}
            disabled={busy !== null}
            onChange={(next) => (usePassword = next)}
            label={i18n.t('common.access_passcode')}
          />
        </div>

        {#if usePassword}
          <FormField
            label={i18n.t('share.passcode')}
            for="share-passcode"
            {...share?.hasPassword
              ? {
                  hint: i18n.t(
                    'share.leave_blank_to_keep_the_current_passcode',
                  ),
                }
              : {}}
          >
            <TextInput
              id="share-passcode"
              type="password"
              bind:value={password}
              disabled={busy !== null}
              maxlength={LIMITS.passwordMaxLength}
              placeholder={i18n.t(
                share?.hasPassword ? 'share.unchanged' : 'share.set_a_passcode',
              )}
              autocomplete="new-password"
            />
          </FormField>
        {/if}

        <div class="flex flex-col gap-1.5">
          <span
            id="share-expiration"
            class="block text-[12px] font-medium text-[var(--text-secondary)]"
            >{i18n.t('share.expiration')}</span
          >
          <div
            role="radiogroup"
            aria-labelledby="share-expiration"
            aria-disabled={busy !== null || undefined}
            class="relative inline-flex w-fit items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[3px]"
          >
            {#each expiryOptions as option, index (option.value)}
              {@const active = option.value === expiry}
              <button
                type="button"
                role="radio"
                aria-checked={active}
                disabled={busy !== null}
                tabindex={active ? 0 : -1}
                onclick={() => (expiry = option.value)}
                onkeydown={(event) => expiryKeydown(event, index)}
                class={cn(
                  'relative z-10 inline-flex h-9 items-center justify-center gap-1.5 rounded-[var(--r-sm)] px-3 text-[12.5px] font-medium md:h-[26px] md:px-2.5',
                  'transition-[color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
                  'disabled:pointer-events-none disabled:opacity-45',
                  active
                    ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,.10)]'
                    : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
                )}>{i18n.t(option.key as MessageKey)}</button
              >
            {/each}
          </div>
        </div>

        <p
          class="rounded-[var(--r-md)] bg-[var(--bg-inset)] px-3 py-2.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
        >
          {i18n.t(
            'share.public_links_are_read_only_visitors_can_see_only_the_latest_version_of_t',
          )}
        </p>
      </div>
    {/if}
    {#snippet footer()}
      {#if share}
        <Button
          variant="ghost"
          class="mr-auto text-[var(--danger)]"
          loading={busy === 'revoke'}
          disabled={busy === 'save'}
          onclick={() => void revoke()}
          >{#if busy !== 'revoke'}<Trash2 size={13} />{/if}{i18n.t(
            'share.revoke_link',
          )}</Button
        >
        <Button variant="secondary" disabled={busy !== null} onclick={onClose}
          >{i18n.t('share.done')}</Button
        >
        <Button
          variant="primary"
          loading={busy === 'save'}
          disabled={busy === 'revoke'}
          onclick={() => void create()}
          >{i18n.t('share.update_settings')}</Button
        >
      {:else}
        <Button variant="ghost" disabled={busy !== null} onclick={onClose}
          >{i18n.t('common.cancel')}</Button
        >
        <Button
          variant="primary"
          loading={busy === 'save'}
          disabled={share === undefined || busy !== null}
          onclick={() => void create()}
          >{#if busy !== 'save'}<Globe size={13} />{/if}{i18n.t(
            'share.generate_public_link',
          )}</Button
        >
      {/if}
    {/snippet}
  </Modal>
{/if}
