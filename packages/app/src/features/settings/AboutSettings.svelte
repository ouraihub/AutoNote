<script lang="ts">
  import { GitFork, LogOut, Shield, UserRound } from '@lucide/svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import { getBackend, getExtensions, getI18n, getNotifier, getSession } from '@app/root/context'
  import { messageKeyForError } from '@app/i18n/errors'
  import Avatar from '@app/components/primitives/Avatar.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import Logo from '@app/components/primitives/Logo.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Badge from './Badge.svelte'

  const backend = getBackend()
  const extensions = getExtensions()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const panels = $derived([...extensions.aboutPanels].sort((a, b) => a.order - b.order))

  let busy = $state(false)
  let error = $state<string | null>(null)
  async function logout(): Promise<void> {
    if (busy || !backend.capabilities.accounts || !session.canSignIn) return
    if (!await notifier.confirm({ titleKey: 'common.log_out', bodyKey: 'settings.the_local_cache_will_be_cleared_and_the_cloud_data_will_not_be_affected' })) return
    busy = true
    error = null
    try {
      const result = await session.logout()
      if (result.kind === 'failed') error = i18n.t(messageKeyForError(result.code))
      if (result.kind === 'blocked') error = i18n.t('session.logout_blocked', { count: result.pending + result.failed + Number(result.settingsPending) })
    } finally {
      busy = false
    }
  }
</script>

<div class="space-y-6">
  {#if backend.capabilities.accounts && session.canSignIn && session.user}
    {@const user = session.user}
    <section>
      <div class="flex items-center gap-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
        <Avatar src={user.avatarUrl} name={user.name} size={44} />
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2">
            <span class="truncate text-[14px] font-semibold text-[var(--text-primary)]">{user.name}</span>
            {#if user.role === 'owner'}<Badge tone="accent">{i18n.t('common.owner')}</Badge>{/if}
          </div>
          <div class="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]">
            <UserRound size={11} />@{user.username}
          </div>
        </div>
        <Button size="sm" variant="ghost" loading={busy} onclick={() => void logout()}
          >{#if !busy}<LogOut size={13} />{/if}{i18n.t('common.exit')}</Button
        >
      </div>
      {#if user.createdAt}<p class="mt-2 px-1 text-[11.5px] text-[var(--text-quaternary)]">
          {i18n.t('settings.joined')}{i18n.formatDate(user.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
        </p>{/if}
      {#if error}<p role="alert" class="mt-2 px-1 text-[11.5px] text-[var(--danger)]">{error}</p>{/if}
    </section>
  {/if}

  {#if backend.capabilities.accounts && session.site}
    {@const open = session.site.registrationOpen}
    <section>
      <h3 class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {i18n.t('common.access_control')}
      </h3>
      <SettingRow
        title={i18n.t('settings.registration_status')}
        description={open
          ? i18n.t('settings.new_accounts_can_currently_register_with_a_username_and_password')
          : i18n.t('settings.only_existing_accounts_can_sign_in_new_accounts_are_rejected')}
      >
        <Badge tone={open ? 'warning' : 'success'}
          >{open ? i18n.t('common.open_registration') : i18n.t('settings.private_instance')}</Badge
        >
      </SettingRow>
      <div class="mt-3 flex items-start gap-2.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
        <Shield size={14} class="mt-px shrink-0 text-[var(--text-tertiary)]" />
        <div class="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
          {i18n.t('settings.to_add_users_open_registration_under_settings_account_they_can_then_crea')}
        </div>
      </div>
    </section>
  {/if}

  {#each panels as panel (panel.id)}
    {@const Panel = panel.component}
    <section aria-labelledby={`about-panel-${panel.id}`}>
      <h3 id={`about-panel-${panel.id}`} class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {i18n.t(panel.titleKey as MessageKey)}
      </h3>
      <Panel {...(panel.props ?? {})} />
    </section>
  {/each}

  <section class="flex items-center justify-between rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
    <div class="flex items-center gap-2.5">
      <span class="text-[var(--accent)]"><Logo size={20} /></span>
      <div>
        <div class="text-[13px] font-semibold">{i18n.t('common.product_name')}</div>
        <div class="text-[11.5px] text-[var(--text-quaternary)]">{i18n.t('settings.version')} {session.site?.version ?? '—'}</div>
      </div>
    </div>
    <a
      href="https://github.com/ouraihub/AutoNote"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={i18n.t('settings.open_github_repository')}
      class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--r-md)] px-2.5 text-[11.5px] font-medium text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:outline-none"
    >
      <GitFork size={14} />{i18n.t('common.github')}
    </a>
  </section>
</div>
