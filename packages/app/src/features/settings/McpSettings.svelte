<script lang="ts">
  import { onMount } from 'svelte'
  import type { McpApiKey, McpGrant, McpSettingsInfo } from '@shared/types'
  import type { RemoteMcpPort } from '@app/backend'
  import { getBackend, getI18n, getNotifier, getSession } from '@app/root/context'
  import { cloudError } from './accountCloud'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const mcp: RemoteMcpPort | undefined = backend.kind === 'web' && backend.capabilities.mcp === 'remote' && backend.mcp && 'get' in backend.mcp ? backend.mcp : undefined
  let info = $state<McpSettingsInfo | null>(null)
  let keyName = $state('')
  let token = $state<string | null>(null)
  let error = $state('')
  let busy = $state(false)
  let active = true

  async function reload(): Promise<void> {
    if (!mcp || busy) return
    busy = true
    error = ''
    try {
      const latest = await mcp.get({ signal: session.epochSignal })
      if (active) info = latest
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function create(): Promise<void> {
    if (!mcp || busy || !info?.enabled || token) return
    const name = keyName.trim()
    if (!name) { error = i18n.t('settings.mcp_api_key_name_required'); return }
    busy = true
    error = ''
    try {
      const created = await mcp.createKey(name, { signal: session.epochSignal })
      if (active) { info = { ...info, apiKeys: [created.key, ...info.apiKeys] }; token = created.token; keyName = '' }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function revoke(key: McpApiKey): Promise<void> {
    if (!mcp || busy || !await notifier.confirm({ titleKey: 'settings.mcp_api_key_revoke_title', bodyKey: 'settings.mcp_api_key_show_once', danger: true })) return
    busy = true
    error = ''
    try {
      await mcp.revokeKey(key.id, { signal: session.epochSignal })
      if (active && info) info = { ...info, apiKeys: info.apiKeys.filter((item) => item.id !== key.id) }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }
  async function revokeGrant(grant: McpGrant): Promise<void> {
    if (!mcp || busy || !await notifier.confirm({ titleKey: 'settings.mcp_revoke_title', bodyKey: 'settings.mcp_reconnect_notice', danger: true })) return
    busy = true
    error = ''
    try {
      await mcp.revokeGrant(grant.id, { signal: session.epochSignal })
      if (active && info) info = { ...info, grants: info.grants.filter((item) => item.id !== grant.id) }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function revokeAll(): Promise<void> {
    if (!mcp || busy || !info?.grants.length || !await notifier.confirm({ titleKey: 'settings.mcp_revoke_all_title', bodyKey: 'settings.mcp_revoke_all_desc', danger: true })) return
    busy = true
    error = ''
    try {
      await mcp.revokeAllGrants({ signal: session.epochSignal })
      if (active && info) info = { ...info, grants: [] }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function aiSearch(enabled: boolean): Promise<void> {
    if (!mcp || busy || !info?.aiSearch.available || !info.enabled) return
    busy = true
    error = ''
    try {
      const updated = await mcp.saveAiSearch(enabled, { signal: session.epochSignal })
      if (active && info) info = { ...info, aiSearch: updated }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function changeIndex(action: 'reindex' | 'clear'): Promise<void> {
    if (!mcp || busy || !info?.aiSearch.available || !info.aiSearch.enabled || !await notifier.confirm({ titleKey: action === 'clear' ? 'settings.mcp_ai_search_clear_title' : 'settings.mcp_ai_search_reindex_title', bodyKey: action === 'clear' ? 'settings.mcp_ai_search_clear_desc' : 'settings.mcp_ai_search_reindex_desc', danger: action === 'clear' })) return
    busy = true
    error = ''
    try {
      if (action === 'clear') {
        await mcp.clearAiSearch({ signal: session.epochSignal })
        if (active && info) info = { ...info, aiSearch: { ...info.aiSearch, indexedCount: 0, pendingCount: 0 } }
      } else {
        const next = await mcp.reindexAiSearch({ signal: session.epochSignal })
        if (active && info) info = { ...info, aiSearch: next }
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function changePreference(patch: { writeEnabled?: boolean; trashEnabled?: boolean }): Promise<void> {
    if (!mcp || busy || !info?.enabled) return
    busy = true
    error = ''
    try {
      const preferences = await mcp.savePreferences(patch, { signal: session.epochSignal })
      if (active && info) info = { ...info, preferences }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  async function toggle(): Promise<void> {
    if (!mcp || busy || !info?.canManageGlobal) return
    busy = true
    error = ''
    try {
      const updated = await mcp.setEnabled(!info.enabled, { signal: session.epochSignal })
      if (active && info) info = { ...info, enabled: updated.enabled, preferences: updated.preferences }
    } catch (cause) {
      if (active && !session.epochSignal.aborted) error = i18n.t(cloudError(cause))
    } finally { busy = false }
  }

  onMount(() => { if (mcp) void reload(); return () => { active = false; token = null } })
</script>

{#if mcp && session.status === 'authed'}
  <section class="space-y-4">
    <button class="rounded border px-2 py-1" disabled={busy} onclick={() => void reload()}>{i18n.t('common.retry')}</button>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if !info && !error}<p role="status">{i18n.t('settings.mcp_loading')}</p>{/if}
    {#if info}
      <p>{i18n.t('settings.mcp_endpoint')}: <code class="break-all">{info.endpoint}</code></p>
      {#if info.canManageGlobal}<button class="rounded border px-2 py-1" disabled={busy} onclick={() => void toggle()}>{i18n.t('settings.mcp_enable')}: {info.enabled ? i18n.t('common.on') : i18n.t('common.off')}</button>{/if}
      <label class="block"><input type="checkbox" checked={info.preferences.writeEnabled} disabled={busy || !info.enabled} onchange={(event) => void changePreference({ writeEnabled: event.currentTarget.checked })} /> {i18n.t('settings.mcp_write_access')}</label>
      <label class="block"><input type="checkbox" checked={info.preferences.trashEnabled} disabled={busy || !info.enabled} onchange={(event) => void changePreference({ trashEnabled: event.currentTarget.checked })} /> {i18n.t('settings.mcp_trash_access')}</label>
      <h3 class="font-semibold">{i18n.t('settings.mcp_api_keys')}</h3>
      {#if token}
        <div class="space-y-2 rounded border p-3"><p>{i18n.t('settings.mcp_api_key_copy_warning')}</p><code class="block select-all break-all">{token}</code><button class="rounded border px-2 py-1" onclick={() => token = null}>{i18n.t('common.close')}</button></div>
      {/if}
      <form class="flex flex-wrap gap-2" onsubmit={(event) => { event.preventDefault(); void create() }}>
        <label>{i18n.t('settings.mcp_api_key_name')} <input class="rounded border bg-background px-2 py-1" maxlength="80" autocomplete="off" bind:value={keyName} disabled={busy || !info.enabled || !!token} required /></label>
        <button class="rounded border px-2 py-1" type="submit" disabled={busy || !info.enabled || !!token}>{i18n.t('settings.mcp_api_key_create')}</button>
      </form>
      {#if info.apiKeys.length}<ul class="divide-y rounded border">{#each info.apiKeys as key (key.id)}<li class="flex items-center justify-between gap-2 p-2"><span>{key.name}</span><button class="rounded border px-2 py-1" disabled={busy} onclick={() => void revoke(key)}>{i18n.t('settings.mcp_api_key_revoke')}</button></li>{/each}</ul>{:else}<p>{i18n.t('settings.mcp_api_keys_empty')}</p>{/if}
      <h3 class="font-semibold">{i18n.t('settings.mcp_connected_clients')}</h3>
      {#if info.grants.length}<button class="rounded border px-2 py-1" disabled={busy} onclick={() => void revokeAll()}>{i18n.t('settings.mcp_revoke_all')}</button>
        <ul>{#each info.grants as grant (grant.id)}<li class="flex justify-between gap-2"><span>{grant.clientName}</span><button class="rounded border px-2 py-1" disabled={busy} onclick={() => void revokeGrant(grant)}>{i18n.t('settings.mcp_revoke')}</button></li>{/each}</ul>
      {:else}<p>{i18n.t('settings.mcp_no_clients')}</p>{/if}
      <h3 class="font-semibold">{i18n.t('settings.mcp_ai_search')}</h3>
      {#if info.aiSearch.available}
        <label><input type="checkbox" checked={info.aiSearch.enabled} disabled={busy || !info.enabled} onchange={(event) => void aiSearch(event.currentTarget.checked)} />{i18n.t('settings.mcp_ai_search')}</label>
        <p>{i18n.t('settings.mcp_ai_search_indexed', { count: info.aiSearch.indexedCount })} · {i18n.t('settings.mcp_ai_search_pending', { count: info.aiSearch.pendingCount })}</p>
        {#if info.aiSearch.enabled}<button class="rounded border px-2 py-1" disabled={busy} onclick={() => void changeIndex('reindex')}>{i18n.t('settings.mcp_ai_search_reindex')}</button><button class="rounded border px-2 py-1" disabled={busy} onclick={() => void changeIndex('clear')}>{i18n.t('settings.mcp_ai_search_clear')}</button>{/if}
      {:else}<p>{i18n.t('settings.mcp_ai_search_unavailable')}</p>{/if}
    {/if}
  </section>
{/if}
