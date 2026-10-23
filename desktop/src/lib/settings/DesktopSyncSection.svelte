<script lang="ts">
  import { onMount } from 'svelte'
  import { getI18n, getNotifier } from '@app/root'
  import Button from '@app/components/primitives/Button.svelte'
  import FormField from '@app/components/primitives/FormField.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { listenSyncStatus } from '../ipc/transport'
  import type { MessageKey } from '@shared/locales/en-US'
  import { syncPort, type BindPreview, type SyncStatus } from '../ipc/ports/remote-sync'

  const i18n = getI18n()
  const notifier = getNotifier()
  let status = $state<SyncStatus>()
  let preview = $state<BindPreview>()
  let origin = $state('')
  let username = $state('')
  let password = $state('')
  let loginId = $state<string>()
  let challengeToken = $state('')
  let totp = $state('')
  let error = $state<string>()
  let busy = $state(false)
  const bound = $derived(status !== undefined && status.phase !== 'unbound')

  onMount(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void listenSyncStatus((value) => {
      if (active) status = value
    })
      .then((dispose) => {
        if (active) unlisten = dispose
        else dispose()
        return syncPort.status()
      })
      .then((value) => {
        if (active) status = value
      })
      .catch((reason: unknown) => {
        if (active) error = message(reason, i18n.t('desktopSync.readStatusFailed'))
      })
    return () => {
      active = false
      unlisten?.()
    }
  })

  function message(reason: unknown, fallback = i18n.t('desktopSync.operationFailed')): string {
    return reason instanceof Error ? reason.message : fallback
  }
  async function step(action: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    error = undefined
    try {
      await action()
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  const run = (action: () => Promise<SyncStatus>) =>
    step(async () => {
      status = await action()
    })
  function login(): Promise<void> {
    return step(async () => {
      const reply = await syncPort.login(origin.trim(), username.trim(), password)
      password = ''
      loginId = reply.loginId
      if ('twoFactorRequired' in reply.result) challengeToken = reply.result.challengeToken
    })
  }
  function completeTotp(): Promise<void> {
    return step(async () => {
      if (!loginId) return
      const reply = await syncPort.completeTotp(loginId, challengeToken, totp.trim())
      loginId = reply.loginId
      challengeToken = ''
      totp = ''
    })
  }
  function makePreview(): Promise<void> {
    return step(async () => {
      if (loginId) preview = await syncPort.preview(loginId)
    })
  }
  async function confirmPreview(): Promise<void> {
    const current = preview
    if (!current) return
    await run(() => syncPort.confirm(current.previewId))
    if (!error) {
      preview = undefined
      loginId = undefined
    }
  }
  async function unbind(): Promise<void> {
    if (
      busy ||
      !(await notifier.confirm({
        titleKey: 'desktopSync.unbindTitle',
        bodyKey: 'desktopSync.unbindBody',
        danger: true,
      }))
    )
      return
    await run(() => syncPort.unbind())
  }
  const phaseLabel = (phase: SyncStatus['phase']) => i18n.t(`desktopSync.phase_${phase}` as MessageKey)
  const time = (at: number) => new Date(at).toLocaleString(i18n.locale)
</script>

<div class="space-y-6">
  {#if !bound}
    <section class="space-y-3" aria-labelledby="sync-login-heading">
      <h3
        id="sync-login-heading"
        class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
      >
        {i18n.t('desktopSync.bindingHeading')}
      </h3>
      <FormField label={i18n.t('desktopSync.siteOrigin')} for="sync-origin">
        <TextInput
          id="sync-origin"
          type="url"
          bind:value={origin}
          placeholder="https://your-autonote.example"
          disabled={busy || !!loginId}
        />
      </FormField>
      <FormField label={i18n.t('desktopSync.username')} for="sync-username">
        <TextInput id="sync-username" autocomplete="username" bind:value={username} disabled={busy || !!loginId} />
      </FormField>
      {#if !loginId}
        <FormField label={i18n.t('desktopSync.password')} for="sync-password">
          <TextInput
            id="sync-password"
            type="password"
            autocomplete="current-password"
            bind:value={password}
            disabled={busy}
          />
        </FormField>
        <Button
          variant="primary"
          disabled={busy || !origin.trim() || !username.trim() || !password}
          onclick={() => void login()}>{i18n.t('desktopSync.signIn')}</Button
        >
      {:else if challengeToken}
        <FormField label={i18n.t('desktopSync.totpCode')} for="sync-totp">
          <TextInput
            id="sync-totp"
            inputmode="numeric"
            autocomplete="one-time-code"
            bind:value={totp}
            disabled={busy}
          />
        </FormField>
        <Button variant="primary" disabled={busy || !totp.trim()} onclick={() => void completeTotp()}
          >{i18n.t('desktopSync.verify')}</Button
        >
      {:else}
        <p class="text-[12px] text-[var(--text-tertiary)]">{i18n.t('desktopSync.mergeExplain')}</p>
        <Button disabled={busy} onclick={() => void makePreview()}>{i18n.t('desktopSync.previewBinding')}</Button>
        {#if preview}
          <p class="text-[11.5px] text-[var(--text-tertiary)]">{i18n.t('desktopSync.previewCounts', { ...preview })}</p>
          <Button variant="primary" disabled={busy} onclick={() => void confirmPreview()}
            >{i18n.t('desktopSync.confirmBinding')}</Button
          >
        {/if}
      {/if}
    </section>
  {/if}

  {#if status && bound}
    <section aria-labelledby="sync-status-heading">
      <h3
        id="sync-status-heading"
        class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
      >
        {i18n.t('desktopSync.statusHeading')}
      </h3>
      <div class="space-y-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[12px] text-[var(--text-primary)]">
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.phase')}</dt>
          <dd>{phaseLabel(status.phase)}</dd>
          {#if status.siteOrigin}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.site')}</dt>
            <dd class="break-all">{status.siteOrigin}</dd>{/if}
          {#if status.account}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.account')}</dt>
            <dd class="break-all">{status.account}</dd>{/if}
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.pending')}</dt>
          <dd>{status.pending}</dd>
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.lastSuccess')}</dt>
          <dd>{status.lastSuccessAt === null ? i18n.t('desktopSync.never') : time(status.lastSuccessAt)}</dd>
          {#if status.errorCode}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.error')}</dt>
            <dd class="break-all text-[var(--danger)]">{status.errorCode}</dd>{/if}
        </dl>
        <div class="flex flex-wrap gap-2">
          {#if status.phase === 'paused'}
            <Button size="sm" disabled={busy} onclick={() => void run(() => syncPort.start())}
              >{i18n.t('desktopSync.start')}</Button
            >
          {:else}
            <Button size="sm" disabled={busy} onclick={() => void run(() => syncPort.stop())}
              >{i18n.t('desktopSync.stop')}</Button
            >
          {/if}
          <Button size="sm" disabled={busy || status.phase === 'syncing'} onclick={() => void run(() => syncPort.now())}
            >{i18n.t('settings.sync_now')}</Button
          >
          <Button size="sm" variant="ghost" disabled={busy} onclick={() => void unbind()}
            >{i18n.t('desktopSync.unbind')}</Button
          >
        </div>
      </div>
    </section>
  {/if}
  {#if error}<p role="alert" class="text-[11.5px] text-[var(--danger)]">{error}</p>{/if}
</div>
