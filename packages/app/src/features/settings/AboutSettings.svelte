<script lang="ts">
  import type { MessageKey } from '@shared/locales/en-US'
  import { getBackend, getExtensions, getI18n, getNotifier, getSession } from '@app/root/context'
  import { messageKeyForError } from '@app/i18n/errors'

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

<div class="space-y-4 text-sm">
  {#if backend.capabilities.accounts && session.canSignIn && session.user}
    <section class="flex items-center justify-between gap-3 rounded border p-3">
      <div><strong>{session.user.name}</strong><p>@{session.user.username}</p></div>
      <button type="button" disabled={busy} onclick={() => void logout()}>{i18n.t('common.exit')}</button>
    </section>
    {#if error}<p role="alert">{error}</p>{/if}
  {/if}
  <section class="flex items-center justify-between rounded border p-3">
    <div><strong>{i18n.t('common.product_name')}</strong><p>{i18n.t('settings.version')} {session.site?.version ?? '—'}</p></div>
    <a href="https://github.com/ouraihub/AutoNote" target="_blank" rel="noopener noreferrer">{i18n.t('common.github')}</a>
  </section>
  {#each panels as panel (panel.id)}
    {@const Panel = panel.component}
    <section class="space-y-2 border-t pt-4" aria-labelledby={`about-panel-${panel.id}`}>
      <h3 id={`about-panel-${panel.id}`} class="font-semibold">{i18n.t(panel.titleKey as MessageKey)}</h3>
      <Panel {...(panel.props ?? {})} />
    </section>
  {/each}
</div>
