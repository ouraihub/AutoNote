<script lang="ts">
  import { onMount } from 'svelte'
  import { LIMITS } from '@shared/constants'
  import type { TotpSetupInfo, TotpStatus } from '@shared/types'
  import { getBackend, getI18n, getSession } from '@app/root/context'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const totp = backend.kind === 'web' && backend.capabilities.accounts && backend.capabilities.totp
    ? backend.session.account?.totp : undefined
  let status = $state<TotpStatus | null>(null)
  let setup = $state<TotpSetupInfo | null>(null)
  let recovery = $state<string[]>([])
  let stage = $state<'idle' | 'enable' | 'setup' | 'regenerate' | 'disable' | 'recovery'>('idle')
  let password = $state('')
  let code = $state('')
  let error = $state('')
  let busy = $state(false)
  let active = true

  onMount(() => {
    if (totp) void totp.status({ signal: session.epochSignal }).then((result) => { if (active) status = result })
      .catch((cause: unknown) => { if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause)) })
    return () => { active = false; recovery = []; setup = null }
  })

  function reset(next: typeof stage = 'idle'): void {
    stage = next
    password = code = error = ''
    if (next !== 'setup') setup = null
    if (next !== 'recovery') recovery = []
  }

  async function submit(): Promise<void> {
    if (!totp || busy) return
    if (stage === 'enable' || stage === 'regenerate' || stage === 'disable') {
      if (!password) { error = i18n.t('settings.enter_your_current_password'); return }
    }
    if (stage === 'regenerate' || stage === 'setup') {
      if (!/^\d{6}$/.test(code)) { error = i18n.t('settings.totp_enter_six_digit_code'); return }
    }
    if (stage === 'disable' && !code.trim()) { error = i18n.t('settings.totp_enter_code_or_recovery'); return }
    busy = true
    error = ''
    try {
      if (stage === 'enable') {
        setup = await totp.startSetup(password, { signal: session.epochSignal })
        if (active) reset('setup')
      } else if (stage === 'setup' && setup) {
        const result = await totp.confirmSetup(setup.setupToken, code, { signal: session.epochSignal })
        if (active) {
          status = { available: true, enabled: true, enabledAt: result.enabledAt, recoveryCodesRemaining: result.recoveryCodesRemaining }
          reset('recovery')
          recovery = result.recoveryCodes
        }
      } else if (stage === 'regenerate') {
        const result = await totp.regenerateRecoveryCodes(password, code, { signal: session.epochSignal })
        if (active) {
          status = status && { ...status, recoveryCodesRemaining: result.recoveryCodesRemaining }
          reset('recovery')
          recovery = result.recoveryCodes
        }
      } else if (stage === 'disable') {
        await totp.disable(password, code, { signal: session.epochSignal })
        if (active) { status = { available: true, enabled: false, enabledAt: null, recoveryCodesRemaining: 0 }; reset() }
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function cancel(): Promise<void> {
    const pending = setup
    if (!totp || busy) return
    if (pending) {
      busy = true
      try { await totp.cancelSetup(pending.setupToken, { signal: session.epochSignal }) }
      catch (cause) { if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause)); return }
      finally { busy = false }
    }
    reset()
  }
</script>

{#if totp && session.status === 'authed'}
  <section class="space-y-3 border-t pt-4">
    <h3 class="font-semibold">{i18n.t('settings.totp_title')}</h3>
    {#if !status && error}<button class="rounded border px-2 py-1" type="button" onclick={() => { error = ''; void totp.status({ signal: session.epochSignal }).then((next) => { if (active) status = next }).catch((cause: unknown) => { if (active) error = i18n.t(cloudError(cause)) }) }}>{i18n.t('common.retry')}</button>
    {:else if !status}<p role="status">{i18n.t('settings.totp_loading')}</p>
    {:else}
      <p>{status.enabled ? i18n.t('settings.totp_enabled_description', { count: status.recoveryCodesRemaining }) : status.available ? i18n.t('settings.totp_disabled_description', { count: status.recoveryCodesRemaining }) : i18n.t('settings.totp_unavailable_description', { count: status.recoveryCodesRemaining })}</p>
      {#if stage === 'idle'}
        {#if status.enabled}
          <button class="rounded border px-2 py-1" type="button" onclick={() => reset('regenerate')}>{i18n.t('settings.totp_manage')}</button>
          <button class="rounded border px-2 py-1" type="button" onclick={() => reset('disable')}>{i18n.t('settings.totp_disable')}</button>
        {:else if status.available}
          <button class="rounded border px-2 py-1" type="button" onclick={() => reset('enable')}>{i18n.t('settings.totp_enable')}</button>
        {/if}
      {:else if stage === 'recovery'}
        <p>{i18n.t('settings.totp_recovery_codes_once')}</p>
        <ul class="grid gap-2 sm:grid-cols-2">{#each recovery as item (item)}<li><code class="select-all">{item}</code></li>{/each}</ul>
        <button class="rounded border px-2 py-1" type="button" onclick={() => reset()}>{i18n.t('settings.totp_saved_codes')}</button>
      {:else}
        <form class="space-y-2" onsubmit={(event) => { event.preventDefault(); void submit() }}>
          {#if stage === 'setup' && setup}
            <p>{i18n.t('settings.totp_scan_qr_description')}</p>
            <p>{i18n.t('settings.totp_manual_secret')} <code class="select-all break-all">{setup.secret}</code></p>
          {:else}
            <label class="block">{i18n.t('settings.current_password')} <input class="rounded border bg-background px-2 py-1" type="password" autocomplete="current-password" maxlength={LIMITS.passwordMaxLength} bind:value={password} required disabled={busy} /></label>
          {/if}
          {#if stage === 'setup' || stage === 'regenerate' || stage === 'disable'}
            <label class="block">{stage === 'disable' ? i18n.t('settings.totp_code_or_recovery') : i18n.t('settings.totp_authenticator_code')}
              <input class="rounded border bg-background px-2 py-1" autocomplete="one-time-code" inputmode={stage === 'disable' ? 'text' : 'numeric'} maxlength={stage === 'disable' ? 24 : 6} bind:value={code} required disabled={busy} />
            </label>
          {/if}
          <button class="rounded border px-2 py-1" type="submit" disabled={busy}>{stage === 'enable' ? i18n.t('common.continue') : stage === 'setup' ? i18n.t('settings.totp_confirm_enable') : stage === 'disable' ? i18n.t('settings.totp_confirm_disable') : i18n.t('settings.totp_generate_new_codes')}</button>
          <button class="rounded border px-2 py-1" type="button" disabled={busy} onclick={() => void cancel()}>{i18n.t('common.cancel')}</button>
        </form>
      {/if}
    {/if}
    {#if error}<p role="alert">{error}</p>{/if}
  </section>
{/if}
