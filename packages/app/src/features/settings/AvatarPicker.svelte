<script lang="ts">
  import { Check, RefreshCw, RotateCcw } from '@lucide/svelte'
  import {
    generatedAvatarPreference,
    GENERATED_AVATAR_SEED_LENGTH,
    isBitmapAvatarDataUrl,
    parseStoredAvatarUrl,
    presetAvatarIndex,
    presetAvatarPreference,
    PRESET_AVATAR_COUNT,
  } from '@shared/avatar'
  import { getBackend, getI18n, getSession } from '@app/root/context'
  import Avatar from '@app/components/primitives/Avatar.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import { cn } from '@app/utils'
  import { cloudError } from './accountCloud'

  let { onClose }: { onClose(): void } = $props()
  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const preference = session.user?.avatarUrl ?? ''
  let selected = $state(preference)
  let choices = $state(randomChoices())
  const presets = Array.from({ length: PRESET_AVATAR_COUNT }, (_, index) =>
    presetAvatarPreference(index + 1),
  )
  let busy = $state(false)
  let error = $state('')
  const selectionLabel = $derived(
    selected === ''
      ? i18n.t('settings.name_based_avatar')
      : isBitmapAvatarDataUrl(selected) || parseStoredAvatarUrl(selected)
        ? i18n.t('settings.uploaded_avatar')
        : presetAvatarIndex(selected) !== null
          ? i18n.t('settings.preset_avatar')
          : i18n.t('settings.random_avatar'),
  )

  function randomChoices(): string[] {
    const result: string[] = []
    while (result.length < 5) {
      const bytes = crypto.getRandomValues(
        new Uint8Array(GENERATED_AVATAR_SEED_LENGTH / 2),
      )
      const choice = generatedAvatarPreference(
        Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
          '',
        ),
      )
      if (!result.includes(choice)) result.push(choice)
    }
    return result
  }

  function close(): void {
    if (!busy) onClose()
  }

  async function save(): Promise<void> {
    if (!session.user || busy) return
    if (selected === session.user.avatarUrl) {
      onClose()
      return
    }
    busy = true
    error = ''
    try {
      await backend.session.updateProfile(
        { avatarUrl: selected },
        { signal: session.epochSignal },
      )
      await session.load({ signal: session.epochSignal })
      if (!session.epochSignal.aborted) onClose()
    } catch (cause) {
      if (!session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }
</script>

{#if session.status === 'authed' && session.user}
  {@const displayName = session.user.name}
  <Modal
    open
    onClose={close}
    title={i18n.t('settings.change_avatar')}
    width={620}
  >
    <div class="space-y-5">
      <div
        class="flex items-center gap-4 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
      >
        <Avatar src={selected} name={displayName} size={72} />
        <div class="min-w-0 flex-1">
          <div class="text-[12px] font-semibold text-[var(--text-primary)]">
            {i18n.t('settings.selected_avatar')}
          </div>
          <div class="mt-1 text-[11.5px] text-[var(--text-tertiary)]">
            {selectionLabel}
          </div>
        </div>
        <Button
          size="sm"
          variant="secondary"
          onclick={() => (selected = '')}
          disabled={busy}
        >
          <RotateCcw size={12} />{i18n.t('settings.use_name_avatar')}
        </Button>
      </div>

      <section>
        <h3
          class="mb-2.5 text-[12px] font-semibold text-[var(--text-secondary)]"
        >
          {i18n.t('settings.preset_avatars')}
        </h3>
        <div class="grid grid-cols-6 gap-2.5">
          {#each presets as choice, index (choice)}
            {@const active = selected === choice}
            <button
              type="button"
              aria-label={i18n.t('settings.preset_avatar_number', {
                number: index + 1,
              })}
              aria-pressed={active}
              disabled={busy}
              onclick={() => (selected = choice)}
              class={cn(
                'relative flex aspect-square min-w-0 items-center justify-center rounded-[var(--r-lg)] border transition-[border-color,background-color,transform] duration-[var(--dur-fast)] hover:-translate-y-0.5',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)]',
              )}
            >
              <Avatar
                src={choice}
                name={displayName}
                size={42}
                class="md:!size-[52px]"
              />
              {#if active}
                <span
                  class="absolute right-1.5 bottom-1.5 flex size-4 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]"
                >
                  <Check size={10} strokeWidth={3} />
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </section>

      <section>
        <div class="mb-2.5 flex items-center justify-between gap-3">
          <h3 class="text-[12px] font-semibold text-[var(--text-secondary)]">
            {i18n.t('settings.random_avatars')}
          </h3>
          <Button
            size="sm"
            variant="ghost"
            onclick={() => (choices = randomChoices())}
            disabled={busy}
          >
            <RefreshCw size={12} />{i18n.t('settings.refresh_avatars')}
          </Button>
        </div>
        <div class="grid grid-cols-5 gap-2.5">
          {#each choices as choice, index (choice)}
            {@const active = selected === choice}
            <button
              type="button"
              aria-label={i18n.t('settings.random_avatar_number', {
                number: index + 1,
              })}
              aria-pressed={active}
              disabled={busy}
              onclick={() => (selected = choice)}
              class={cn(
                'relative flex aspect-square min-w-0 items-center justify-center rounded-[var(--r-lg)] border transition-[border-color,background-color,transform] duration-[var(--dur-fast)] hover:-translate-y-0.5',
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border-subtle)] bg-[var(--bg-base)] hover:border-[var(--border-strong)]',
              )}
            >
              <Avatar
                src={choice}
                name={displayName}
                size={42}
                class="md:!size-[60px]"
              />
              {#if active}
                <span
                  class="absolute right-1.5 bottom-1.5 flex size-4 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--accent-contrast)]"
                >
                  <Check size={10} strokeWidth={3} />
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </section>

      {#if error}<p role="alert" class="text-[12px] text-[var(--danger)]">
          {error}
        </p>{/if}
    </div>
    {#snippet footer()}
      <Button variant="ghost" onclick={close} disabled={busy}
        >{i18n.t('common.cancel')}</Button
      >
      <Button
        variant="primary"
        onclick={() => void save()}
        loading={busy}
        disabled={selected === preference}
      >
        {i18n.t('common.save')}
      </Button>
    {/snippet}
  </Modal>
{/if}
