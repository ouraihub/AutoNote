<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { LIMITS } from '@shared/constants'
  import type { AppLocale, TotpLoginChallenge } from '@shared/types'
  import type { BackendSession, ErrorCode } from '@shared/backend-types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { messageKeyForError } from '@app/i18n/errors'
  import Logo from '@app/components/primitives/Logo.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'

  export interface AuthSession {
    readonly canSignIn: boolean
    readonly site: BackendSession['site'] | null
    readonly authError: ErrorCode | null
    readonly challenge: TotpLoginChallenge | null
    readonly busy: boolean
    login(
      username: string,
      password: string,
      options?: { signal?: AbortSignal },
    ): Promise<'authed' | 'challenge' | 'rejected' | 'superseded'>
    completeTotp(
      code: string,
      options?: { signal?: AbortSignal },
    ): Promise<'authed' | 'challenge' | 'rejected' | 'superseded'>
    register(
      username: string,
      password: string,
      locale: AppLocale,
      options?: { signal?: AbortSignal },
    ): Promise<'authed' | 'challenge' | 'rejected' | 'superseded'>
    cancelChallenge(): void
  }

  export interface AuthI18n {
    readonly locale: AppLocale
    t(key: MessageKey, params?: Readonly<Record<string, boolean | number | string | null | undefined>>): string
  }

  interface Props {
    session: AuthSession
    i18n: AuthI18n
    defaults?: Readonly<{ username: string; password: string }> | undefined
  }

  let { session, i18n, defaults }: Props = $props()

  let mode = $state<'login' | 'register'>('login')
  let username = $state(untrack(() => defaults?.username ?? ''))
  let password = $state(untrack(() => defaults?.password ?? ''))
  let confirmation = $state('')
  let verificationCode = $state('')
  let recoveryMode = $state(false)
  let localError = $state<MessageKey | null>(null)
  let submitController = $state<AbortController | null>(null)

  const firstRun = $derived(Boolean(session.site && !session.site.initialized))
  const registerMode = $derived(firstRun || mode === 'register')
  const showModeSwitch = $derived(!firstRun && Boolean(session.site?.registrationOpen))
  const challenge = $derived(session.challenge)
  const errorKey = $derived(localError ?? (session.authError ? messageKeyForError(session.authError) : null))
  const errorMessage = $derived(errorKey ? i18n.t(errorKey) : null)

  function clearError(): void {
    localError = null
  }

  function resetChallenge(): void {
    submitController?.abort()
    submitController = null
    session.cancelChallenge()
    verificationCode = ''
    recoveryMode = false
    clearError()
  }

  function switchMode(): void {
    mode = registerMode ? 'login' : 'register'
    password = ''
    confirmation = ''
    clearError()
  }

  function normalizeVerificationCode(value: string): void {
    verificationCode = recoveryMode
      ? value.toUpperCase().replace(/\s/g, '').slice(0, 24)
      : value.replace(/\D/g, '').slice(0, 6)
    clearError()
  }

  function toggleRecoveryMode(): void {
    recoveryMode = !recoveryMode
    verificationCode = ''
    clearError()
  }

  async function submit(): Promise<void> {
    if (session.busy || submitController) return
    clearError()

    if (challenge) {
      if (!verificationCode.trim()) {
        localError = recoveryMode ? 'auth.enter_recovery_code' : 'auth.enter_authenticator_code'
        return
      }
      const controller = new AbortController()
      submitController = controller
      try {
        await session.completeTotp(verificationCode.trim(), { signal: controller.signal })
      } finally {
        if (submitController === controller) submitController = null
      }
      return
    }

    if (!username.trim() || !password) {
      localError = 'auth.enter_a_username_and_password'
      return
    }
    if (registerMode && password !== confirmation) {
      localError = 'common.the_passwords_do_not_match'
      return
    }

    const controller = new AbortController()
    submitController = controller
    try {
      if (registerMode) {
        await session.register(username.trim(), password, i18n.locale, { signal: controller.signal })
      } else {
        const outcome = await session.login(username.trim(), password, { signal: controller.signal })
        if (outcome === 'challenge') {
          password = ''
          confirmation = ''
          verificationCode = ''
          recoveryMode = false
        }
      }
    } finally {
      if (submitController === controller) submitController = null
    }
  }

  onDestroy(() => {
    submitController?.abort()
    submitController = null
    if (session.busy) session.cancelChallenge()
  })
</script>

{#snippet field(label: string, value: string, set: (value: string) => void, attrs: Record<string, unknown>)}
  <TextInput
    {...attrs}
    aria-label={label}
    placeholder={(attrs.placeholder as string | undefined) ?? label}
    {value}
    disabled={session.busy}
    oninput={(event) => set(event.currentTarget.value)}
  />
{/snippet}

{#if session.canSignIn}
  <main
    class="relative flex min-h-full flex-col items-center justify-center overflow-y-auto px-4 pt-[calc(32px+env(safe-area-inset-top))] pb-[calc(24px+env(safe-area-inset-bottom))] md:px-6 md:py-10"
  >
    <div aria-hidden="true" class="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        class="absolute left-1/2 top-[-22%] size-[720px] -translate-x-1/2 rounded-full opacity-[0.13] blur-[120px]"
        style:background="var(--accent)"
      ></div>
      <div
        class="absolute inset-0 opacity-[0.5]"
        style="background-image: linear-gradient(var(--border-subtle) 1px, transparent 1px), linear-gradient(90deg, var(--border-subtle) 1px, transparent 1px); background-size: 52px 52px; mask-image: radial-gradient(ellipse 80% 55% at 50% 40%, #000 20%, transparent 78%)"
      ></div>
    </div>

    <div class="anim-rise relative w-full max-w-[380px]">
      <div class="mb-6 flex flex-col items-center text-center md:mb-8">
        <div
          class="mb-5 flex size-14 items-center justify-center rounded-[18px] border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--accent)] shadow-[var(--shadow-pop)]"
        >
          <Logo size={27} />
        </div>
        <h1
          class="text-[30px] font-semibold tracking-[0.01em] text-[var(--text-primary)]"
          style:font-family="var(--font-serif)"
        >
          {i18n.t('common.product_name')}
        </h1>
        <p class="mt-2.5 text-[13px] leading-relaxed text-[var(--text-tertiary)]">
          {#if challenge}
            {i18n.t('auth.two_step_verification_description')}
          {:else if firstRun}
            {i18n.t('auth.create_the_owner_account_this_step_appears_only_once')}
          {:else}
            {i18n.t('auth.tagline')}
          {/if}
        </p>
      </div>

      <form
        class="space-y-2.5"
        onsubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {#if challenge}
          <div
            class="mb-3 flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2.5 text-[12px] text-[var(--text-secondary)]"
          >
            <KeyRound size={14} class="shrink-0 text-[var(--accent)]" />
            <span class="min-w-0 truncate">@{username.trim()}</span>
          </div>
          <TextInput
            aria-label={i18n.t(recoveryMode ? 'auth.recovery_code' : 'auth.authenticator_code')}
            value={verificationCode}
            maxlength={recoveryMode ? 24 : 6}
            placeholder={recoveryMode ? 'XXXX-XXXX-XXXX-XXXX' : '000000'}
            autocomplete={recoveryMode ? 'off' : 'one-time-code'}
            autocapitalize={recoveryMode ? 'characters' : 'none'}
            inputmode={recoveryMode ? 'text' : 'numeric'}
            spellcheck={false}
            disabled={session.busy}
            invalid={Boolean(errorMessage)}
            autofocus
            oninput={(event) => normalizeVerificationCode(event.currentTarget.value)}
          />
        {:else}
          {@render field(
            i18n.t('common.username'),
            username,
            (value) => {
              username = value
              clearError()
            },
            { autocomplete: 'username', autocapitalize: 'none', spellcheck: false },
          )}
          {@render field(
            i18n.t('common.password'),
            password,
            (value) => {
              password = value
              clearError()
            },
            {
              type: 'password',
              maxlength: LIMITS.passwordMaxLength,
              autocomplete: registerMode ? 'new-password' : 'current-password',
              placeholder: registerMode ? i18n.t('auth.password_minimum_8_characters') : undefined,
            },
          )}
          {#if registerMode}
            {@render field(
              i18n.t('auth.confirm_password'),
              confirmation,
              (value) => {
                confirmation = value
                clearError()
              },
              {
                type: 'password',
                maxlength: LIMITS.passwordMaxLength,
                autocomplete: 'new-password',
                'aria-invalid': localError === 'common.the_passwords_do_not_match',
              },
            )}
          {/if}
        {/if}

        <button
          type="submit"
          disabled={session.busy || submitController !== null}
          class="flex h-11 w-full items-center justify-center gap-2.5 rounded-[var(--r-lg)] bg-[var(--accent)] text-[13.5px] font-medium text-[var(--accent-contrast)] transition-[transform,opacity,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:bg-[var(--accent-hover)] active:translate-y-px disabled:opacity-50"
        >
          {#if session.busy}<LoaderCircle
              size={16}
              class="animate-[ink-spin_.7s_linear_infinite]"
              aria-hidden="true"
            />{/if}
          {#if challenge}
            {i18n.t('auth.verify_and_sign_in')}
          {:else if registerMode}
            {i18n.t(firstRun ? 'auth.create_owner_account' : 'auth.sign_up')}
          {:else}
            {i18n.t('auth.sign_in')}
          {/if}
        </button>

        {#if challenge}
          <div class="flex items-center justify-between gap-3 pt-1">
            <button
              type="button"
              disabled={session.busy}
              onclick={resetChallenge}
              class="inline-flex items-center gap-1 text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
            >
              <ArrowLeft size={12} aria-hidden="true" />
              {i18n.t('auth.back_to_password')}
            </button>
            <button
              type="button"
              disabled={session.busy}
              onclick={toggleRecoveryMode}
              class="text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
            >
              {i18n.t(recoveryMode ? 'auth.use_authenticator_code' : 'auth.use_recovery_code')}
            </button>
          </div>
        {:else if showModeSwitch}
          <button
            type="button"
            disabled={session.busy}
            onclick={switchMode}
            class="mx-auto block text-[12px] text-[var(--text-tertiary)] transition-colors hover:text-[var(--accent)]"
          >
            {i18n.t(registerMode ? 'auth.already_have_an_account_sign_in' : 'auth.no_account_create_one')}
          </button>
        {/if}
      </form>

      {#if errorMessage}
        <div
          role="alert"
          class="anim-rise mt-4 flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_35%,transparent)] bg-[color-mix(in_oklab,var(--danger)_9%,transparent)] px-3 py-2.5"
        >
          <TriangleAlert size={14} class="mt-[1px] shrink-0 text-[var(--danger)]" aria-hidden="true" />
          <span class="text-[12px] leading-relaxed text-[var(--text-secondary)]">{errorMessage}</span>
        </div>
      {/if}

      <div class="mt-6 space-y-2 text-center md:mt-8">
        {#if session.site?.initialized && !session.site.registrationOpen}
          <p class="text-[11.5px] leading-relaxed text-[var(--text-quaternary)]">
            {i18n.t('auth.this_is_a_private_instance_registration_is_closed_so_only_existing_accou')}
          </p>
        {/if}
        <p class="text-[11px] tracking-[0.04em] text-[var(--text-quaternary)]">
          {i18n.t('auth.live_split_view_markdown_preview_realtime_multi_device_sync_multiple_web')}
        </p>
      </div>
    </div>

    <footer
      class="pointer-events-none mt-6 text-center text-[11px] tracking-[0.05em] text-[var(--text-quaternary)] md:mt-8"
    >
      {i18n.t('auth.self_hosted_on_cloudflare_workers_your_data_is_yours')}
    </footer>
  </main>
{/if}
