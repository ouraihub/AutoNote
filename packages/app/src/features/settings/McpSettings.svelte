<script lang="ts">
  import { onMount } from 'svelte'
  import { Check, Copy, RefreshCw, ShieldCheck } from '@lucide/svelte'
  import type { McpApiKey, McpGrant, McpSettingsInfo } from '@shared/types'
  import type { RemoteMcpPort } from '@app/backend'
  import {
    getBackend,
    getI18n,
    getNotifier,
    getSession,
  } from '@app/root/context'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import { cloudError } from './accountCloud'
  import McpAccess from './McpAccess.svelte'
  import McpCredentials from './McpCredentials.svelte'
  import McpAiSearch from './McpAiSearch.svelte'
  import McpGrants from './McpGrants.svelte'

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const mcp: RemoteMcpPort | undefined =
    backend.kind === 'web' &&
    backend.capabilities.mcp === 'remote' &&
    backend.mcp &&
    'get' in backend.mcp
      ? backend.mcp
      : undefined
  let info = $state<McpSettingsInfo | null>(null)
  let keyName = $state('')
  let token = $state<string | null>(null)
  let error = $state('')
  let busy = $state(false)
  let copied = $state<string | null>(null)
  let copiedTimer = 0
  let active = true
  const snippets = $derived(info ? clientSnippets(info) : [])
  const sectionHeading =
    'text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]'

  async function copy(id: string, value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      copied = id
      window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => (copied = null), 1500)
    } catch {
      notifier.toast({ key: 'preview.could_not_copy', tone: 'error' })
    }
  }

  function scopeSummary(scopes: string[]): string {
    return scopes
      .map((scope) =>
        scope === 'notes:read'
          ? i18n.t('settings.mcp_scope_read')
          : scope === 'notes:write'
            ? i18n.t('settings.mcp_scope_write')
            : scope === 'notes:trash'
              ? i18n.t('settings.mcp_scope_trash')
              : scope,
      )
      .join(' · ')
  }

  function clientSnippets(
    current: McpSettingsInfo,
  ): Array<{ id: string; name: string; value: string }> {
    const scopeText = [
      'notes:read',
      ...(current.preferences.writeEnabled ? ['notes:write'] : []),
      ...(current.preferences.trashEnabled ? ['notes:trash'] : []),
    ].join(' ')
    const endpoint = current.endpoint
    const claudeJson = JSON.stringify({
      type: 'http',
      url: endpoint,
      oauth: { scopes: scopeText },
    })
    const bearerJson = JSON.stringify({
      type: 'http',
      url: endpoint,
      headers: { Authorization: 'Bearer <API_KEY>' },
    })
    return [
      {
        id: 'codex',
        name: 'Codex',
        value: `codex mcp add autonote --url "${endpoint}"`,
      },
      {
        id: 'claude-code',
        name: 'Claude Code',
        value:
          `claude mcp add-json autonote '${claudeJson}' --scope user\n` +
          'claude mcp login autonote',
      },
      {
        id: 'hermes',
        name: 'Hermes Agent',
        value:
          `hermes mcp add autonote --url "${endpoint}" --auth oauth\n` +
          'hermes mcp login autonote',
      },
      {
        id: 'openclaw',
        name: 'OpenClaw',
        value:
          `openclaw mcp add autonote --url "${endpoint}" ` +
          '--transport streamable-http --auth oauth ' +
          `--oauth-scope "${scopeText}"\nopenclaw mcp login autonote`,
      },
      {
        id: 'generic',
        name: i18n.t('settings.mcp_generic_client'),
        value: i18n.t('settings.mcp_generic_client_snippet', {
          endpoint,
          bearerJson,
        }),
      },
    ]
  }

  async function reload(): Promise<void> {
    if (!mcp || busy) return
    busy = true
    error = ''
    try {
      const latest = await mcp.get({ signal: session.epochSignal })
      if (active) info = latest
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function create(): Promise<void> {
    if (!mcp || busy || !info?.enabled || token) return
    const name = keyName.trim()
    if (!name) {
      error = i18n.t('settings.mcp_api_key_name_required')
      return
    }
    busy = true
    error = ''
    try {
      const created = await mcp.createKey(name, { signal: session.epochSignal })
      if (active) {
        info = { ...info, apiKeys: [created.key, ...info.apiKeys] }
        token = created.token
        keyName = ''
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function revoke(key: McpApiKey): Promise<void> {
    if (
      !mcp ||
      busy ||
      !(await notifier.confirm({
        titleKey: 'settings.mcp_api_key_revoke_title',
        bodyKey: 'settings.mcp_api_key_show_once',
        danger: true,
      }))
    )
      return
    busy = true
    error = ''
    try {
      await mcp.revokeKey(key.id, { signal: session.epochSignal })
      if (active && info)
        info = {
          ...info,
          apiKeys: info.apiKeys.filter((item) => item.id !== key.id),
        }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }
  async function revokeGrant(grant: McpGrant): Promise<void> {
    if (
      !mcp ||
      busy ||
      !(await notifier.confirm({
        titleKey: 'settings.mcp_revoke_title',
        bodyKey: 'settings.mcp_reconnect_notice',
        danger: true,
      }))
    )
      return
    busy = true
    error = ''
    try {
      await mcp.revokeGrant(grant.id, { signal: session.epochSignal })
      if (active && info)
        info = {
          ...info,
          grants: info.grants.filter((item) => item.id !== grant.id),
        }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function revokeAll(): Promise<void> {
    if (
      !mcp ||
      busy ||
      !info?.grants.length ||
      !(await notifier.confirm({
        titleKey: 'settings.mcp_revoke_all_title',
        bodyKey: 'settings.mcp_revoke_all_desc',
        danger: true,
      }))
    )
      return
    busy = true
    error = ''
    try {
      await mcp.revokeAllGrants({ signal: session.epochSignal })
      if (active && info) info = { ...info, grants: [] }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function aiSearch(enabled: boolean): Promise<void> {
    if (!mcp || busy || !info?.aiSearch.available || !info.enabled) return
    busy = true
    error = ''
    try {
      const updated = await mcp.saveAiSearch(enabled, {
        signal: session.epochSignal,
      })
      if (active && info) info = { ...info, aiSearch: updated }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function changeIndex(action: 'reindex' | 'clear'): Promise<void> {
    if (
      !mcp ||
      busy ||
      !info?.aiSearch.available ||
      !info.aiSearch.enabled ||
      !(await notifier.confirm({
        titleKey:
          action === 'clear'
            ? 'settings.mcp_ai_search_clear_title'
            : 'settings.mcp_ai_search_reindex_title',
        bodyKey:
          action === 'clear'
            ? 'settings.mcp_ai_search_clear_desc'
            : 'settings.mcp_ai_search_reindex_desc',
        danger: action === 'clear',
      }))
    )
      return
    busy = true
    error = ''
    try {
      if (action === 'clear') {
        await mcp.clearAiSearch({ signal: session.epochSignal })
        if (active && info)
          info = {
            ...info,
            aiSearch: { ...info.aiSearch, indexedCount: 0, pendingCount: 0 },
          }
      } else {
        const next = await mcp.reindexAiSearch({ signal: session.epochSignal })
        if (active && info) info = { ...info, aiSearch: next }
      }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function changePreference(patch: {
    writeEnabled?: boolean
    trashEnabled?: boolean
  }): Promise<void> {
    if (!mcp || busy || !info?.enabled) return
    busy = true
    error = ''
    try {
      const preferences = await mcp.savePreferences(patch, {
        signal: session.epochSignal,
      })
      if (active && info) info = { ...info, preferences }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  async function toggle(): Promise<void> {
    if (!mcp || busy || !info?.canManageGlobal) return
    busy = true
    error = ''
    try {
      const updated = await mcp.setEnabled(!info.enabled, {
        signal: session.epochSignal,
      })
      if (active && info)
        info = {
          ...info,
          enabled: updated.enabled,
          preferences: updated.preferences,
        }
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  onMount(() => {
    if (mcp) void reload()
    return () => {
      active = false
      token = null
      window.clearTimeout(copiedTimer)
    }
  })
</script>

{#if mcp && session.status === 'authed'}
  {#if !info}
    {#if error}
      <div
        class="rounded-[var(--r-lg)] border border-[var(--border-subtle)]
          bg-[var(--bg-base)] p-4"
      >
        <p role="alert" class="text-[12.5px] text-[var(--danger)]">
          {error || i18n.t('settings.mcp_load_failed')}
        </p>
        <Button
          class="mt-3"
          size="sm"
          disabled={busy}
          onclick={() => void reload()}
          ><RefreshCw size={12} />{i18n.t('common.retry')}</Button
        >
      </div>
    {:else}
      <p
        role="status"
        class="py-4 text-center text-[12px] text-[var(--text-tertiary)]"
      >
        {i18n.t('settings.mcp_loading')}
      </p>
    {/if}
  {:else}
    <div class="space-y-6">
      {#if error}<p
          role="alert"
          class="rounded-[var(--r-md)] border border-[var(--border-subtle)]
            px-3 py-2 text-[12px] text-[var(--danger)]"
        >
          {error}
        </p>{/if}

      <McpAccess {info} {busy} {copied} {copy} {toggle} {changePreference} />
      <McpCredentials
        {info}
        {busy}
        {copied}
        {copy}
        {create}
        {revoke}
        {scopeSummary}
        bind:token
        bind:keyName
      />
      <McpAiSearch {info} {busy} {aiSearch} {changeIndex} />

      <section>
        <h3 class={['mb-2 px-1', sectionHeading]}>
          {i18n.t('settings.mcp_connect_clients')}
        </h3>
        <p
          class="mb-3 px-1 text-[11.5px] leading-relaxed
            text-[var(--text-tertiary)]"
        >
          {i18n.t('settings.mcp_connect_desc')}
        </p>
        <div class="space-y-2">
          {#each snippets as snippet (snippet.id)}
            <details
              class="group overflow-hidden rounded-[var(--r-lg)] border
                border-[var(--border-subtle)] bg-[var(--bg-base)]"
            >
              <summary
                class="flex cursor-pointer list-none items-center
                  justify-between gap-3 px-3.5 py-3 text-[12.5px]
                  font-medium text-[var(--text-primary)]"
              >
                <span>{snippet.name}</span>
                <span
                  class="text-[10.5px] font-normal
                    text-[var(--text-quaternary)]"
                  >{i18n.t('settings.mcp_transport')}</span
                >
              </summary>
              <div class="border-t border-[var(--border-subtle)] p-3">
                <div class="flex items-start gap-2">
                  <pre
                    class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap
                      break-all rounded-[var(--r-sm)] bg-[var(--bg-inset)]
                      p-2.5 text-[10.5px] leading-relaxed
                      text-[var(--text-secondary)]">{snippet.value}</pre>
                  <IconButton
                    label={i18n.t('settings.mcp_copy')}
                    title={i18n.t('settings.mcp_copy')}
                    size="sm"
                    onclick={() => void copy(snippet.id, snippet.value)}
                  >
                    {#if copied === snippet.id}<Check size={14} />{:else}<Copy
                        size={14}
                      />{/if}
                  </IconButton>
                </div>
              </div>
            </details>
          {/each}
        </div>
      </section>
      <McpGrants
        grants={info.grants}
        {busy}
        {scopeSummary}
        {revokeGrant}
        {revokeAll}
      />

      <section
        class="rounded-[var(--r-lg)] border border-[var(--border-subtle)]
          bg-[var(--bg-base)] p-4"
      >
        <div class="flex items-start gap-3">
          <ShieldCheck
            size={16}
            class="mt-0.5 shrink-0 text-[var(--success)]"
          />
          <div>
            <h3 class="text-[12.5px] font-medium text-[var(--text-primary)]">
              {i18n.t('settings.mcp_privacy')}
            </h3>
            <p
              class="mt-1 text-[11px] leading-relaxed
                text-[var(--text-tertiary)]"
            >
              {i18n.t('settings.mcp_privacy_desc')}
            </p>
          </div>
        </div>
      </section>
    </div>
  {/if}
{/if}
