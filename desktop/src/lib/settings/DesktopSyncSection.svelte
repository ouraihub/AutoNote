<script lang="ts">
  import { onMount } from 'svelte'
  import { getI18n, getNotifier } from '@app/root'
  import Button from '@app/components/primitives/Button.svelte'
  import FormField from '@app/components/primitives/FormField.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { listenSyncStatus } from '../ipc/transport'
  import {
    syncPort,
    type BindPreview,
    type BindStrategy,
    type SyncConflict,
    type SyncStatus,
  } from '../ipc/ports/remote-sync'

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
  let strategy = $state<BindStrategy>('keep-local')
  let error = $state<string>()
  let busy = $state(false)

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
  async function run(action: () => Promise<SyncStatus>): Promise<boolean> {
    if (busy) return false
    busy = true
    error = undefined
    try {
      status = await action()
      return true
    } catch (reason) {
      error = message(reason)
      return false
    } finally {
      busy = false
    }
  }
  async function login(): Promise<void> {
    if (busy || !origin.trim() || !username.trim() || !password) return
    busy = true
    error = undefined
    try {
      const reply = await syncPort.login(origin.trim(), username.trim(), password)
      password = ''
      loginId = reply.loginId
      if ('twoFactorRequired' in reply.result) challengeToken = reply.result.challengeToken
      else status = await syncPort.status()
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function completeTotp(): Promise<void> {
    if (busy || !loginId || !challengeToken || !totp.trim()) return
    busy = true
    error = undefined
    try {
      const reply = await syncPort.completeTotp(loginId, challengeToken, totp.trim())
      loginId = reply.loginId
      challengeToken = ''
      totp = ''
      status = await syncPort.status()
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function makePreview(): Promise<void> {
    if (busy || !loginId || challengeToken) return
    busy = true
    error = undefined
    try {
      preview = await syncPort.preview(loginId, strategy)
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function confirmPreview(): Promise<void> {
    const current = preview
    if (!current || busy) return
    if (await run(() => syncPort.confirm(current.previewId))) preview = undefined
  }
  function binding(): { bindingId: string; epoch: number } | null {
    if (
      status?.bindingId === null ||
      status?.bindingId === undefined ||
      status.epoch === null ||
      status.epoch === undefined
    )
      return null
    return { bindingId: status.bindingId, epoch: status.epoch }
  }
  function conflicts(): SyncConflict[] {
    return status?.conflictItems ?? []
  }
  async function unbind(): Promise<void> {
    const current = binding()
    if (
      !current ||
      busy ||
      !(await notifier.confirm({
        titleKey: 'desktopSync.unbindTitle',
        bodyKey: 'desktopSync.unbindBody',
        danger: true,
      }))
    )
      return
    await run(() => syncPort.unbind(current.bindingId, current.epoch))
  }
  async function exportQuarantine(item: { bindingId: string; epoch: number }): Promise<void> {
    if (busy) return
    busy = true
    error = undefined
    try {
      const value = await syncPort.exportQuarantined(item.bindingId, item.epoch)
      const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })
      const href = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = href
      link.download = `autonote-quarantine-${item.bindingId}.json`
      link.click()
      URL.revokeObjectURL(href)
    } catch (reason) {
      error = message(reason)
    } finally {
      busy = false
    }
  }
  async function discardQuarantine(item: { bindingId: string; epoch: number }): Promise<void> {
    if (
      busy ||
      !(await notifier.confirm({
        titleKey: 'desktopSync.discardTitle',
        bodyKey: 'desktopSync.discardBody',
        danger: true,
      }))
    )
      return
    await run(() => syncPort.discardQuarantined(item.bindingId, item.epoch))
  }
</script>

<div class="space-y-6">
  <section class="space-y-3" aria-labelledby="sync-login-heading">
    <h3 id="sync-login-heading" class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
      {i18n.t('desktopSync.bindingHeading')}
    </h3>
    <FormField label={i18n.t('desktopSync.siteOrigin')} for="sync-origin">
      <TextInput
        id="sync-origin"
        type="url"
        bind:value={origin}
        placeholder="https://your-autonote.example"
        disabled={busy}
      />
    </FormField>
    <FormField label={i18n.t('desktopSync.username')} for="sync-username">
      <TextInput id="sync-username" autocomplete="username" bind:value={username} disabled={busy} />
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
      <Button variant="primary" disabled={busy || !origin || !username || !password} onclick={() => void login()}
        >{i18n.t('desktopSync.signIn')}</Button
      >
    {/if}
    {#if loginId && challengeToken}
      <FormField label={i18n.t('desktopSync.totpCode')} for="sync-totp">
        <TextInput
          id="sync-totp"
          inputmode="numeric"
          autocomplete="one-time-code"
          placeholder={i18n.t('desktopSync.totpCode')}
          bind:value={totp}
          disabled={busy}
        />
      </FormField>
      <Button variant="primary" disabled={busy || !totp.trim()} onclick={() => void completeTotp()}
        >{i18n.t('desktopSync.verify')}</Button
      >
    {/if}
  </section>

  {#if status}
    {@const currentBinding = binding()}
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
          <dd>{status.phase}</dd>
          {#if status.siteOrigin}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.site')}</dt>
            <dd class="break-all">{status.siteOrigin}</dd>{/if}
          {#if status.accountHint}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.account')}</dt>
            <dd class="break-all">{status.accountHint}</dd>{/if}
          {#if status.bindingId}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.bindingId')}</dt>
            <dd class="break-all">{status.bindingId}</dd>{/if}
          {#if status.epoch !== null}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.epoch')}</dt>
            <dd>{status.epoch}</dd>{/if}
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.localCursor')}</dt>
          <dd class="break-all">{status.localCursor}</dd>
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.remoteCursor')}</dt>
          <dd class="break-all">{status.remoteCursor}</dd>
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.pending')}</dt>
          <dd>{status.pending}</dd>
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.blocked')}</dt>
          <dd>{status.blocked}</dd>
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.conflicts')}</dt>
          <dd>{status.conflicts}</dd>
          <dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.online')}</dt>
          <dd>{i18n.t(status.online ? 'desktopSync.yes' : 'desktopSync.no')}</dd>
          {#if status.terminal}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.terminal')}</dt>
            <dd>{i18n.t('desktopSync.yes')}</dd>{/if}
          {#if status.errorCode}<dt class="text-[var(--text-tertiary)]">{i18n.t('desktopSync.error')}</dt>
            <dd class="break-all text-[var(--danger)]">{status.errorCode}</dd>{/if}
        </dl>
        {#if status.metadataRisk}<p role="note" class="text-[11.5px] text-[var(--warning)]">
            {i18n.t('desktopSync.metadataRisk')}
          </p>{/if}
        <div class="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !currentBinding} onclick={() => void run(() => syncPort.start())}
            >{i18n.t('desktopSync.start')}</Button
          >
          <Button size="sm" disabled={busy || !currentBinding} onclick={() => void run(() => syncPort.stop())}
            >{i18n.t('desktopSync.stop')}</Button
          >
          <Button size="sm" disabled={busy || !currentBinding} onclick={() => void run(() => syncPort.now())}
            >{i18n.t('settings.sync_now')}</Button
          >
          {#if currentBinding}<Button size="sm" variant="ghost" disabled={busy} onclick={() => void unbind()}
              >{i18n.t('desktopSync.unbind')}</Button
            >{/if}
        </div>
      </div>
    </section>
  {/if}

  {#if loginId && !challengeToken}
    <section class="space-y-3" aria-labelledby="sync-strategy-heading">
      <h3
        id="sync-strategy-heading"
        class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
      >
        {i18n.t('desktopSync.strategyHeading')}
      </h3>
      <label class="flex items-center gap-2 text-[13px] text-[var(--text-primary)]"
        ><input type="radio" class="accent-[var(--accent)]" bind:group={strategy} value="keep-local" />{i18n.t(
          'desktopSync.keepLocalUpload',
        )}</label
      >
      <label class="flex items-center gap-2 text-[13px] text-[var(--text-primary)]"
        ><input type="radio" class="accent-[var(--accent)]" bind:group={strategy} value="import-remote" />{i18n.t(
          'desktopSync.importRemote',
        )}</label
      >
      <label class="flex items-center gap-2 text-[13px] text-[var(--text-primary)]"
        ><input type="radio" class="accent-[var(--accent)]" bind:group={strategy} value="merge" />{i18n.t(
          'desktopSync.merge',
        )}</label
      >
      <Button disabled={busy} onclick={() => void makePreview()}>{i18n.t('desktopSync.previewBinding')}</Button>
      {#if preview}<p class="text-[11.5px] text-[var(--text-tertiary)]">
          {i18n.t('desktopSync.previewCounts', { ...preview.counts })}
        </p>
        <Button variant="primary" disabled={busy} onclick={() => void confirmPreview()}
          >{i18n.t('desktopSync.confirmBinding')}</Button
        >{/if}
    </section>
  {/if}

  {#if conflicts().length}<section aria-labelledby="sync-conflicts-heading">
      <h3
        id="sync-conflicts-heading"
        class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
      >
        {i18n.t('desktopSync.conflictsHeading')}
      </h3>
      {#each conflicts() as conflict (conflict.id)}{@const currentBinding = binding()}
        <SettingRow title={`${conflict.entity}: ${conflict.reason}`}>
          {#if currentBinding}<div class="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={busy}
                onclick={() =>
                  void run(() =>
                    syncPort.resolveConflict(conflict.id, 'local', currentBinding.bindingId, currentBinding.epoch),
                  )}>{i18n.t('desktopSync.keepLocal')}</Button
              >
              <Button
                size="sm"
                disabled={busy}
                onclick={() =>
                  void run(() =>
                    syncPort.resolveConflict(conflict.id, 'remote', currentBinding.bindingId, currentBinding.epoch),
                  )}>{i18n.t('desktopSync.keepRemote')}</Button
              >
              <Button
                size="sm"
                disabled={busy}
                onclick={() =>
                  void run(() =>
                    syncPort.resolveConflict(conflict.id, 'keep-both', currentBinding.bindingId, currentBinding.epoch),
                  )}>{i18n.t('desktopSync.keepBoth')}</Button
              >
            </div>{/if}
        </SettingRow>{/each}
    </section>{/if}

  {#if status?.quarantined.length}<section>
      {#each status.quarantined as item (item.bindingId)}
        <SettingRow title={i18n.t('desktopSync.quarantined')} description={`${item.accountHint} (${item.pending})`}>
          <div class="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onclick={() => void exportQuarantine(item)}
              >{i18n.t('desktopSync.exportQuarantine')}</Button
            >
            <Button size="sm" variant="danger" disabled={busy} onclick={() => void discardQuarantine(item)}
              >{i18n.t('desktopSync.discardQuarantine')}</Button
            >
          </div>
        </SettingRow>{/each}
    </section>{/if}
  {#if error}<p role="alert" class="text-[11.5px] text-[var(--danger)]">{error}</p>{/if}
</div>
