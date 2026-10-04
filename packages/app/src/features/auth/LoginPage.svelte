<script lang="ts">
  import { onDestroy } from 'svelte'
  import ArrowLeft from '@lucide/svelte/icons/arrow-left'
  import KeyRound from '@lucide/svelte/icons/key-round'
  import LoaderCircle from '@lucide/svelte/icons/loader-circle'
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert'
  import { LIMITS } from '@shared/constants'
  import type { AppLocale, TotpLoginChallenge } from '@shared/types'
  import type { BackendSession, ErrorCode } from '@shared/backend-types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { messageKeyForError } from '@app/i18n/errors'
  import { Button } from '@app/components/ui/button'
  import * as Field from '@app/components/ui/field'
  import { Input } from '@app/components/ui/input'

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
  }

  let { session, i18n }: Props = $props()

  let mode = $state<'login' | 'register'>('login')
  let username = $state('')
  let password = $state('')
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

{#if session.canSignIn}
  <main
    class="relative flex min-h-dvh flex-col items-center justify-center overflow-y-auto bg-background px-4 py-10 text-foreground"
  >
    <div class="relative w-full max-w-md">
      <header class="mb-8 text-center">
        <div
          class="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-border bg-muted text-primary"
        >
          <KeyRound aria-hidden="true" />
        </div>
        <h1 class="text-2xl font-semibold">{i18n.t('common.product_name')}</h1>
        <p class="mt-2 text-sm text-muted-foreground">
          {#if challenge}
            {i18n.t('auth.two_step_verification_description')}
          {:else if firstRun}
            {i18n.t('auth.create_the_owner_account_this_step_appears_only_once')}
          {:else}
            {i18n.t('auth.between_the_paper_and_ink_the_pen_comes_to_life_an_autonote_is_used_to_p')}
          {/if}
        </p>
      </header>

      <form
        class="flex flex-col gap-5"
        onsubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        {#if challenge}
          <div
            class="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground"
          >
            <KeyRound aria-hidden="true" />
            <span class="truncate">@{username.trim()}</span>
          </div>
          <Field.FieldGroup>
            <Field.Field data-invalid={Boolean(errorMessage)}>
              <Field.FieldLabel for="auth-verification-code">
                {i18n.t(recoveryMode ? 'auth.recovery_code' : 'auth.authenticator_code')}
              </Field.FieldLabel>
              <Input
                id="auth-verification-code"
                value={verificationCode}
                maxlength={recoveryMode ? 24 : 6}
                placeholder={recoveryMode ? 'XXXX-XXXX-XXXX-XXXX' : '000000'}
                autocomplete={recoveryMode ? 'off' : 'one-time-code'}
                autocapitalize={recoveryMode ? 'characters' : 'none'}
                inputmode={recoveryMode ? 'text' : 'numeric'}
                spellcheck={false}
                disabled={session.busy}
                aria-invalid={Boolean(errorMessage)}
                autofocus
                oninput={(event) => normalizeVerificationCode(event.currentTarget.value)}
              />
              {#if errorMessage}<Field.FieldError>{errorMessage}</Field.FieldError>{/if}
            </Field.Field>
          </Field.FieldGroup>
        {:else}
          <Field.FieldGroup>
            <Field.Field>
              <Field.FieldLabel for="auth-username">{i18n.t('common.username')}</Field.FieldLabel>
              <Input
                id="auth-username"
                value={username}
                autocomplete="username"
                autocapitalize="none"
                spellcheck={false}
                disabled={session.busy}
                oninput={(event) => {
                  username = event.currentTarget.value
                  clearError()
                }}
              />
            </Field.Field>
            <Field.Field>
              <Field.FieldLabel for="auth-password">{i18n.t('common.password')}</Field.FieldLabel>
              <Input
                id="auth-password"
                type="password"
                value={password}
                maxlength={LIMITS.passwordMaxLength}
                autocomplete={registerMode ? 'new-password' : 'current-password'}
                disabled={session.busy}
                oninput={(event) => {
                  password = event.currentTarget.value
                  clearError()
                }}
              />
            </Field.Field>
            {#if registerMode}
              <Field.Field>
                <Field.FieldLabel for="auth-confirm-password">{i18n.t('auth.confirm_password')}</Field.FieldLabel>
                <Input
                  id="auth-confirm-password"
                  type="password"
                  value={confirmation}
                  maxlength={LIMITS.passwordMaxLength}
                  autocomplete="new-password"
                  disabled={session.busy}
                  aria-invalid={Boolean(localError === 'common.the_passwords_do_not_match')}
                  oninput={(event) => {
                    confirmation = event.currentTarget.value
                    clearError()
                  }}
                />
              </Field.Field>
            {/if}
          </Field.FieldGroup>
        {/if}

        <Button type="submit" class="w-full" size="lg" disabled={session.busy || submitController !== null}>
          {#if session.busy}<LoaderCircle data-icon="inline-start" class="animate-spin" aria-hidden="true" />{/if}
          {#if challenge}
            {i18n.t('auth.verify_and_sign_in')}
          {:else if registerMode}
            {i18n.t(firstRun ? 'auth.create_owner_account' : 'auth.sign_up')}
          {:else}
            {i18n.t('auth.sign_in')}
          {/if}
        </Button>

        {#if challenge}
          <div class="flex items-center justify-between gap-3">
            <Button type="button" variant="ghost" size="sm" disabled={session.busy} onclick={resetChallenge}>
              <ArrowLeft data-icon="inline-start" aria-hidden="true" />
              {i18n.t('auth.back_to_password')}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={session.busy} onclick={toggleRecoveryMode}>
              {i18n.t(recoveryMode ? 'auth.use_authenticator_code' : 'auth.use_recovery_code')}
            </Button>
          </div>
        {:else if showModeSwitch}
          <Button type="button" variant="link" class="mx-auto" disabled={session.busy} onclick={switchMode}>
            {i18n.t(registerMode ? 'auth.already_have_an_account_sign_in' : 'auth.no_account_create_one')}
          </Button>
        {/if}
      </form>

      {#if errorMessage && !challenge}
        <div
          class="mt-5 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive"
          role="alert"
        >
          <TriangleAlert aria-hidden="true" />
          <span>{errorMessage}</span>
        </div>
      {/if}

      {#if session.site && !session.site.registrationOpen && !firstRun}
        <p class="mt-6 text-center text-xs text-muted-foreground">
          {i18n.t('auth.this_is_a_private_instance_registration_is_closed_so_only_existing_accou')}
        </p>
      {/if}
    </div>
  </main>
{/if}
