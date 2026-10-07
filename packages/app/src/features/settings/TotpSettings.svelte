<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, Copy, KeyRound, QrCode, RefreshCw, ShieldCheck, ShieldOff, TriangleAlert } from '@lucide/svelte'
  import { LIMITS } from '@shared/constants'
  import type { TotpSetupInfo, TotpStatus } from '@shared/types'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getBackend, getI18n, getNotifier, getSession } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
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

  async function copy(value: string, key: MessageKey): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      notifier.toast({ key, tone: 'success' })
    } catch {
      error = i18n.t('settings.totp_copy_failed')
    }
  }

  function retry(): void {
    if (!totp) return
    error = ''
    void totp.status({ signal: session.epochSignal }).then((next) => { if (active) status = next }).catch((cause: unknown) => { if (active) error = i18n.t(cloudError(cause)) })
  }
</script>

{#snippet passwordInput()}
  <label class="block">
    <span class="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">{i18n.t('settings.current_password')}</span>
    <TextInput type="password" bind:value={password} maxlength={LIMITS.passwordMaxLength} disabled={busy} autocomplete="current-password" required />
  </label>
{/snippet}

{#snippet codeInput(label: string)}
  <label class="block">
    <span class="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">{label}</span>
    <TextInput
      bind:value={code}
      maxlength={6}
      oninput={() => (code = code.replace(/\D/g, '').slice(0, 6))}
      disabled={busy}
      inputmode="numeric"
      autocomplete="one-time-code"
      placeholder="000000"
      required
    />
  </label>
{/snippet}

{#snippet inlineError()}
  {#if error}<p role="alert" class="text-[12px] text-[var(--danger)]">{error}</p>{/if}
{/snippet}

{#snippet actionRow(submitLabel: string, onCancel: () => void, danger = false)}
  <div class="flex justify-end gap-2">
    <Button type="button" size="sm" variant="ghost" disabled={busy} onclick={onCancel}>{i18n.t('common.cancel')}</Button>
    <Button type="submit" size="sm" variant={danger ? 'danger' : 'primary'} loading={busy}>{submitLabel}</Button>
  </div>
{/snippet}

{#if totp && session.status === 'authed'}
  {#if !status && !error}
    <p role="status" class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 text-[12px] text-[var(--text-tertiary)]">{i18n.t('settings.totp_loading')}</p>
  {:else if !status}
    <div class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
      <p role="alert" class="text-[12px] text-[var(--danger)]">{error || i18n.t('settings.totp_load_failed')}</p>
      <Button class="mt-3" size="sm" onclick={retry}><RefreshCw size={12} />{i18n.t('common.retry')}</Button>
    </div>
  {:else}
    <div class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
      <SettingRow
        class="px-4"
        title={i18n.t('settings.totp_title')}
        description={status.enabled ? i18n.t('settings.totp_enabled_description', { count: status.recoveryCodesRemaining }) : status.available ? i18n.t('settings.totp_disabled_description', { count: status.recoveryCodesRemaining }) : i18n.t('settings.totp_unavailable_description', { count: status.recoveryCodesRemaining })}
      >
        <div class="flex items-center gap-2">
          <span class={['inline-flex items-center rounded-full px-[7px] py-[1px] text-[11px] font-medium tabular', status.enabled ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]']}>
            {status.enabled ? i18n.t('common.on') : i18n.t('common.off')}
          </span>
          {#if stage === 'idle'}
            {#if status.enabled}
              <Button size="sm" variant="secondary" onclick={() => reset('regenerate')}><KeyRound size={12} />{i18n.t('settings.totp_manage')}</Button>
            {:else}
              <Button size="sm" variant="primary" disabled={!status.available} onclick={() => reset('enable')}><ShieldCheck size={12} />{i18n.t('settings.totp_enable')}</Button>
            {/if}
          {/if}
        </div>
      </SettingRow>

      {#if stage === 'idle' && error}<div class="border-t border-[var(--border-subtle)] px-4 py-3">{@render inlineError()}</div>{/if}

      {#if stage === 'enable'}
        <form class="space-y-3 border-t border-[var(--border-subtle)] px-4 py-4" onsubmit={(event) => { event.preventDefault(); void submit() }}>
          <p class="text-[12px] leading-relaxed text-[var(--text-tertiary)]">{i18n.t('settings.totp_enable_password_description')}</p>
          {@render passwordInput()}
          {@render inlineError()}
          {@render actionRow(i18n.t('common.continue'), () => void cancel())}
        </form>
      {:else if stage === 'setup' && setup}
        {@const secret = setup.secret}
        <form class="space-y-4 border-t border-[var(--border-subtle)] px-4 py-4" onsubmit={(event) => { event.preventDefault(); void submit() }}>
          <div class="min-w-0 space-y-3">
            <div>
              <div class="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <QrCode size={15} class="text-[var(--accent)]" />
                {i18n.t('settings.totp_scan_qr')}
              </div>
              <p class="mt-1 text-[12px] leading-relaxed text-[var(--text-tertiary)]">{i18n.t('settings.totp_scan_qr_description')}</p>
            </div>
            <div class="rounded-[var(--r-md)] bg-[var(--bg-surface)] p-3">
              <div class="flex items-center justify-between gap-2">
                <span class="text-[11px] font-medium text-[var(--text-tertiary)]">{i18n.t('settings.totp_manual_secret')}</span>
                <Button type="button" size="sm" variant="ghost" onclick={() => void copy(secret, 'settings.totp_secret_copied')}><Copy size={11} />{i18n.t('common.copy')}</Button>
              </div>
              <code class="mt-1.5 block break-all font-mono text-[12px] tracking-[0.08em] text-[var(--text-primary)] select-all">{secret.match(/.{1,4}/g)?.join(' ')}</code>
            </div>
            {@render codeInput(i18n.t('settings.totp_confirm_code'))}
          </div>
          {@render inlineError()}
          {@render actionRow(i18n.t('settings.totp_confirm_enable'), () => void cancel())}
        </form>
      {:else if stage === 'recovery' && recovery.length > 0}
        <div class="space-y-4 border-t border-[var(--border-subtle)] px-4 py-4">
          <div class="flex items-start gap-2.5 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--warning)_8%,transparent)] p-3">
            <TriangleAlert size={15} class="mt-0.5 shrink-0 text-[var(--warning)]" />
            <div>
              <p class="text-[12.5px] font-semibold text-[var(--text-primary)]">{i18n.t('settings.totp_save_recovery_codes')}</p>
              <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{i18n.t('settings.totp_recovery_codes_once')}</p>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {#each recovery as item, index (item)}
              <code class="select-all rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-2 text-center font-mono text-[12px] tracking-[0.04em] text-[var(--text-primary)]">
                <span class="mr-2 text-[var(--text-quaternary)]">{index + 1}.</span>{item}
              </code>
            {/each}
          </div>
          {@render inlineError()}
          <div class="flex flex-wrap justify-end gap-2">
            <Button size="sm" variant="secondary" onclick={() => void copy(recovery.join('\n'), 'settings.totp_recovery_codes_copied')}><Copy size={12} />{i18n.t('settings.totp_copy_all')}</Button>
            <Button size="sm" variant="primary" onclick={() => reset()}><Check size={12} />{i18n.t('settings.totp_saved_codes')}</Button>
          </div>
        </div>
      {:else if stage === 'regenerate'}
        <form class="space-y-3 border-t border-[var(--border-subtle)] px-4 py-4" onsubmit={(event) => { event.preventDefault(); void submit() }}>
          <div class="flex items-start justify-between gap-3">
            <div>
              <p class="text-[12.5px] font-semibold text-[var(--text-primary)]">{i18n.t('settings.totp_recovery_codes')}</p>
              <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{i18n.t('settings.totp_regenerate_description')}</p>
            </div>
            <Button type="button" size="sm" variant="danger" disabled={busy} onclick={() => reset('disable')}><ShieldOff size={12} />{i18n.t('settings.totp_disable')}</Button>
          </div>
          <div class="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {@render passwordInput()}
            {@render codeInput(i18n.t('settings.totp_authenticator_code'))}
          </div>
          {@render inlineError()}
          {@render actionRow(i18n.t('settings.totp_generate_new_codes'), () => reset())}
        </form>
      {:else if stage === 'disable'}
        <form class="space-y-3 border-t border-[var(--border-subtle)] px-4 py-4" onsubmit={(event) => { event.preventDefault(); void submit() }}>
          <div class="flex items-start gap-2.5 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--danger)_30%,transparent)] bg-[color-mix(in_oklab,var(--danger)_7%,transparent)] p-3">
            <ShieldOff size={15} class="mt-0.5 shrink-0 text-[var(--danger)]" />
            <div>
              <p class="text-[12.5px] font-semibold text-[var(--text-primary)]">{i18n.t('settings.totp_disable_title')}</p>
              <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{i18n.t('settings.totp_disable_description')}</p>
            </div>
          </div>
          <div class="grid grid-cols-1 gap-2.5 md:grid-cols-2">
            {@render passwordInput()}
            <label class="block">
              <span class="mb-1 block text-[11.5px] text-[var(--text-tertiary)]">{i18n.t('settings.totp_code_or_recovery')}</span>
              <TextInput
                bind:value={code}
                maxlength={24}
                disabled={busy}
                autocomplete="one-time-code"
                autocapitalize="characters"
                spellcheck={false}
                placeholder={i18n.t('settings.totp_code_or_recovery_placeholder')}
                required
              />
            </label>
          </div>
          {@render inlineError()}
          {@render actionRow(i18n.t('settings.totp_confirm_disable'), () => reset('regenerate'), true)}
        </form>
      {/if}
    </div>
  {/if}
{/if}
