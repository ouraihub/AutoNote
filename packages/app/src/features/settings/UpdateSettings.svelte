<script lang="ts">
  import { ExternalLink, GitFork, RefreshCw } from '@lucide/svelte'
  import type { UpdateCheckResponse } from '@shared/types'
  import { getBackend, getI18n, getSession } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import { cloudError } from './accountCloud'
  import Badge from './Badge.svelte'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const update =
    backend.kind === 'web' &&
    backend.capabilities.updateCheck &&
    session.user?.role === 'owner'
      ? backend.update
      : undefined
  let check = $state<UpdateCheckResponse | null>(null)
  let busy = $state(false)
  let error = $state('')
  const available = $derived(
    Boolean(
      check?.latestVersion && check.latestVersion !== check.currentVersion,
    ),
  )

  async function refresh(): Promise<void> {
    if (!update || busy) return
    busy = true
    error = ''
    try {
      check = await update.check({ signal: session.epochSignal })
    } catch (cause) {
      if (!session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }
</script>

{#if update && session.status === 'authed' && session.user?.role === 'owner'}
  <section class="mt-6">
    <h3
      class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
    >
      {i18n.t('settings.deployment_updates')}
    </h3>
    <SettingRow title={i18n.t('settings.current_version')}>
      <Badge>{check?.currentVersion ?? session.site?.version ?? '—'}</Badge>
    </SettingRow>
    <SettingRow
      title={i18n.t('settings.latest_version')}
      description={check?.checkedAt
        ? `${i18n.t('settings.checked_at')} ${i18n.formatDate(check.checkedAt, { dateStyle: 'medium', timeStyle: 'short' })}`
        : undefined}
    >
      <Badge
        tone={available
          ? 'warning'
          : check?.status === 'unavailable' || !check
            ? 'neutral'
            : 'success'}
      >
        {busy
          ? i18n.t('settings.checking_for_updates')
          : !check
            ? '—'
            : (check.latestVersion ??
              i18n.t('settings.update_check_unavailable'))}
      </Badge>
    </SettingRow>
    {#if !available && check?.latestVersion}<p
        class="mt-2 px-1 text-[11.5px] text-[var(--text-quaternary)]"
      >
        {i18n.t('settings.up_to_date')}
      </p>{/if}
    {#if available}
      <div
        class="mt-3 flex items-start gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3"
      >
        <GitFork size={17} class="mt-0.5 shrink-0 text-[var(--accent)]" />
        <p class="text-[12px] leading-relaxed text-[var(--text-secondary)]">
          {i18n.t('settings.update_manual_fork_hint')}
        </p>
      </div>
    {/if}
    {#if error}<p
        role="alert"
        class="mt-2 px-1 text-[11.5px] text-[var(--danger)]"
      >
        {error}
      </p>{/if}
    <div class="mt-3 flex flex-wrap justify-end gap-2">
      <Button
        size="sm"
        variant="secondary"
        loading={busy}
        onclick={() => void refresh()}
        >{#if !busy}<RefreshCw size={13} />{/if}{i18n.t(
          'settings.recheck_updates',
        )}</Button
      >
      {#if available && check?.updateUrl}<a
          href={check.updateUrl}
          target="_blank"
          rel="external noopener noreferrer"
          class="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[12px] font-medium whitespace-nowrap text-[var(--accent-contrast)] shadow-[0_1px_2px_rgba(0,0,0,.14)] transition-[background-color] duration-[var(--dur-fast)] hover:bg-[var(--accent-hover)] md:h-7 md:px-2.5"
          ><ExternalLink size={13} />{i18n.t('settings.go_to_update')}</a
        >{/if}
    </div>
  </section>
{/if}
