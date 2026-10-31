<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    Bot,
    Check,
    Copy,
    KeyRound,
    RefreshCw,
    ShieldCheck,
    Sparkles,
    Trash2,
    Unplug,
  } from '@lucide/svelte'
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
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cloudError } from './accountCloud'

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
  const badge =
    'inline-flex items-center rounded-full px-[7px] py-[1px] text-[11px] font-medium tabular'
  const fullTime = (value: number) =>
    new Date(value).toLocaleString(i18n.locale)

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
        value: `claude mcp add-json autonote '${claudeJson}' --scope user\nclaude mcp login autonote`,
      },
      {
        id: 'hermes',
        name: 'Hermes Agent',
        value: `hermes mcp add autonote --url "${endpoint}" --auth oauth\nhermes mcp login autonote`,
      },
      {
        id: 'openclaw',
        name: 'OpenClaw',
        value: `openclaw mcp add autonote --url "${endpoint}" --transport streamable-http --auth oauth --oauth-scope "${scopeText}"\nopenclaw mcp login autonote`,
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
        class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
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
          class="rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-2 text-[12px] text-[var(--danger)]"
        >
          {error}
        </p>{/if}

      <section
        class="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
      >
        <div class="flex items-start gap-3 p-4">
          <span
            class="mt-0.5 rounded-[var(--r-md)] bg-[var(--accent-soft)] p-2 text-[var(--accent)]"
            ><Bot size={18} /></span
          >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3
                class="text-[13.5px] font-semibold text-[var(--text-primary)]"
              >
                {i18n.t('settings.mcp_private_knowledge')}
              </h3>
              <span
                class={[
                  badge,
                  info.enabled
                    ? 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]'
                    : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]',
                ]}
              >
                {info.enabled
                  ? i18n.t('settings.enabled')
                  : i18n.t('settings.mcp_disabled')}
              </span>
            </div>
            <p
              class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
            >
              {i18n.t('settings.mcp_intro')}
            </p>
          </div>
        </div>
        <div class="border-t border-[var(--border-subtle)] px-4 py-3">
          <div class="mb-1 text-[11px] font-medium text-[var(--text-tertiary)]">
            {i18n.t('settings.mcp_endpoint')}
          </div>
          <div class="flex min-w-0 items-center gap-2">
            <code
              class="min-w-0 flex-1 overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-2 text-[11.5px] text-[var(--text-secondary)]"
              >{info.endpoint}</code
            >
            <IconButton
              label={i18n.t('settings.mcp_copy')}
              title={i18n.t('settings.mcp_copy')}
              size="sm"
              onclick={() => void copy('endpoint', info!.endpoint)}
            >
              {#if copied === 'endpoint'}<Check size={14} />{:else}<Copy
                  size={14}
                />{/if}
            </IconButton>
          </div>
          <p
            class="mt-2 text-[10.5px] leading-relaxed text-[var(--text-quaternary)]"
          >
            {i18n.t('settings.mcp_endpoint_desc')}
          </p>
        </div>
      </section>

      <section>
        <h3 class={['mb-1 px-1', sectionHeading]}>
          {i18n.t('settings.mcp_permissions')}
        </h3>
        {#if info.canManageGlobal}
          <SettingRow
            title={i18n.t('settings.mcp_enable')}
            description={i18n.t('settings.mcp_enable_desc')}
          >
            <Switch
              checked={info.enabled}
              disabled={busy}
              label={i18n.t('settings.mcp_enable')}
              onChange={() => void toggle()}
            />
          </SettingRow>
        {/if}
        <SettingRow
          title={i18n.t('settings.mcp_write_access')}
          description={i18n.t('settings.mcp_write_access_desc')}
        >
          <Switch
            checked={info.preferences.writeEnabled}
            disabled={busy || !info.enabled}
            label={i18n.t('settings.mcp_write_access')}
            onChange={(writeEnabled) => void changePreference({ writeEnabled })}
          />
        </SettingRow>
        <SettingRow
          title={i18n.t('settings.mcp_trash_access')}
          description={i18n.t('settings.mcp_trash_access_desc')}
        >
          <Switch
            checked={info.preferences.trashEnabled}
            disabled={busy || !info.enabled}
            label={i18n.t('settings.mcp_trash_access')}
            onChange={(trashEnabled) => void changePreference({ trashEnabled })}
          />
        </SettingRow>
      </section>

      <section>
        <h3 class={['mb-2 px-1', sectionHeading]}>
          {i18n.t('settings.mcp_api_keys')}
        </h3>
        <p
          class="mb-3 px-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
        >
          {i18n.t('settings.mcp_api_keys_desc')}
        </p>

        {#if token}
          {@const created = token}
          <div
            class="mb-3 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3"
          >
            <div
              class="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-[var(--text-primary)]"
            >
              <KeyRound size={12} class="text-[var(--accent)]" />
              {i18n.t('settings.mcp_api_key_copy_warning')}
            </div>
            <div class="flex items-center gap-2">
              <code
                class="min-w-0 flex-1 break-all rounded-[var(--r-sm)] bg-[var(--bg-base)] px-2.5 py-2 font-mono text-[11px] text-[var(--text-secondary)] select-all"
                >{created}</code
              >
              <Button
                size="sm"
                variant="secondary"
                onclick={() => void copy('new-token', created)}
              >
                {#if copied === 'new-token'}<Check size={12} />{:else}<Copy
                    size={12}
                  />{/if}{copied === 'new-token'
                  ? i18n.t('common.copied')
                  : i18n.t('common.copy')}
              </Button>
              <Button size="sm" variant="ghost" onclick={() => (token = null)}
                >{i18n.t('common.close')}</Button
              >
            </div>
            <p class="mt-1.5 text-[10.5px] text-[var(--text-quaternary)]">
              {i18n.t('settings.mcp_api_key_show_once')}
            </p>
          </div>
        {/if}

        <form
          class="mb-2 flex items-center gap-2"
          onsubmit={(event) => {
            event.preventDefault()
            void create()
          }}
        >
          <TextInput
            bind:value={keyName}
            disabled={busy || !info.enabled || !!token}
            aria-label={i18n.t('settings.mcp_api_key_name')}
            maxlength={80}
            autocomplete="off"
            placeholder={i18n.t('settings.mcp_api_key_name_placeholder')}
            required
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || !info.enabled || !!token}
          >
            <KeyRound size={13} />{i18n.t('settings.mcp_api_key_create')}
          </Button>
        </form>

        {#if info.apiKeys.length}
          <div
            class="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
          >
            {#each info.apiKeys as key (key.id)}
              <div
                class="flex items-center gap-3 border-b border-[var(--border-subtle)] p-3.5 last:border-b-0"
              >
                <span
                  class="rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-2 text-[var(--text-tertiary)]"
                  ><KeyRound size={15} /></span
                >
                <div class="min-w-0 flex-1">
                  <div
                    class="truncate text-[12.5px] font-medium text-[var(--text-primary)]"
                  >
                    {key.name}
                  </div>
                  <div
                    class="mt-0.5 truncate text-[10.5px] text-[var(--text-quaternary)]"
                  >
                    {[
                      scopeSummary(key.scopes),
                      key.lastUsedAt
                        ? i18n.t('settings.mcp_api_key_used', {
                            time: fullTime(key.lastUsedAt),
                          })
                        : i18n.t('settings.mcp_api_key_unused'),
                      i18n.t('settings.mcp_granted_at', {
                        time: fullTime(key.createdAt),
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </div>
                <IconButton
                  label={i18n.t('settings.mcp_api_key_revoke')}
                  title={i18n.t('settings.mcp_api_key_revoke')}
                  size="sm"
                  disabled={busy}
                  onclick={() => void revoke(key)}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            {/each}
          </div>
        {:else}
          <div
            class="rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] p-5 text-center text-[11.5px] text-[var(--text-quaternary)]"
          >
            {i18n.t('settings.mcp_api_keys_empty')}
          </div>
        {/if}
      </section>

      <section>
        <div class="mb-2 flex items-center justify-between gap-3 px-1">
          <div class="flex items-center gap-1.5">
            <Sparkles size={13} class="text-[var(--accent)]" />
            <h3 class={sectionHeading}>{i18n.t('settings.mcp_ai_search')}</h3>
            {#if info.aiSearch.available}
              <span
                class={[
                  badge,
                  info.aiSearch.enabled
                    ? 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]'
                    : 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]',
                ]}
              >
                {info.aiSearch.enabled
                  ? i18n.t('settings.enabled')
                  : i18n.t('settings.mcp_disabled')}
              </span>
            {:else}
              <span
                class={[
                  badge,
                  'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
                ]}>{i18n.t('settings.mcp_ai_search_unavailable')}</span
              >
            {/if}
          </div>
          <Switch
            checked={info.aiSearch.enabled}
            disabled={busy || !info.enabled || !info.aiSearch.available}
            label={i18n.t('settings.mcp_ai_search')}
            onChange={(enabled) => void aiSearch(enabled)}
          />
        </div>
        <div
          class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3.5"
        >
          <p class="text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">
            {i18n.t('settings.mcp_ai_search_desc')}
          </p>
          {#if info.aiSearch.available}
            <p class="mt-2 text-[10.5px] text-[var(--text-quaternary)]">
              {i18n.t('settings.mcp_ai_search_indexed', {
                count: info.aiSearch.indexedCount,
              })}{info.aiSearch.pendingCount > 0
                ? ` · ${i18n.t('settings.mcp_ai_search_pending', { count: info.aiSearch.pendingCount })}`
                : ''}
            </p>
          {:else}
            <p
              class="mt-2 flex items-center gap-1.5 text-[10.5px] text-[var(--danger)]"
            >
              <AlertTriangle size={12} />{i18n.t(
                'settings.mcp_ai_search_unavailable_desc',
              )}
            </p>
          {/if}
          <div class="mt-3 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !info.aiSearch.enabled}
              onclick={() => void changeIndex('reindex')}
              ><RefreshCw size={12} />{i18n.t(
                'settings.mcp_ai_search_reindex',
              )}</Button
            >
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !info.aiSearch.enabled}
              onclick={() => void changeIndex('clear')}
              ><Trash2 size={12} />{i18n.t(
                'settings.mcp_ai_search_clear',
              )}</Button
            >
          </div>
        </div>
      </section>

      <section>
        <h3 class={['mb-2 px-1', sectionHeading]}>
          {i18n.t('settings.mcp_connect_clients')}
        </h3>
        <p
          class="mb-3 px-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
        >
          {i18n.t('settings.mcp_connect_desc')}
        </p>
        <div class="space-y-2">
          {#each snippets as snippet (snippet.id)}
            <details
              class="group overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
            >
              <summary
                class="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-3 text-[12.5px] font-medium text-[var(--text-primary)]"
              >
                <span>{snippet.name}</span>
                <span
                  class="text-[10.5px] font-normal text-[var(--text-quaternary)]"
                  >{i18n.t('settings.mcp_transport')}</span
                >
              </summary>
              <div class="border-t border-[var(--border-subtle)] p-3">
                <div class="flex items-start gap-2">
                  <pre
                    class="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-[var(--r-sm)] bg-[var(--bg-inset)] p-2.5 text-[10.5px] leading-relaxed text-[var(--text-secondary)]">{snippet.value}</pre>
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

      <section>
        <div class="mb-2 flex items-center justify-between gap-3 px-1">
          <h3 class={sectionHeading}>
            {i18n.t('settings.mcp_connected_clients')}
          </h3>
          {#if info.grants.length > 1}<Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onclick={() => void revokeAll()}
              >{i18n.t('settings.mcp_revoke_all')}</Button
            >{/if}
        </div>
        {#if info.grants.length}
          <div
            class="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
          >
            {#each info.grants as grant (grant.id)}
              <div
                class="flex items-center gap-3 border-b border-[var(--border-subtle)] p-3.5 last:border-b-0"
              >
                <span
                  class="rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-2 text-[var(--text-tertiary)]"
                  ><ShieldCheck size={15} /></span
                >
                <div class="min-w-0 flex-1">
                  <div
                    class="truncate text-[12.5px] font-medium text-[var(--text-primary)]"
                  >
                    {grant.clientName}
                  </div>
                  <div
                    class="mt-0.5 truncate text-[10.5px] text-[var(--text-quaternary)]"
                  >
                    {scopeSummary(grant.scopes)} · {i18n.t(
                      'settings.mcp_granted_at',
                      { time: fullTime(grant.createdAt) },
                    )}
                  </div>
                </div>
                <IconButton
                  label={i18n.t('settings.mcp_revoke')}
                  title={i18n.t('settings.mcp_revoke')}
                  size="sm"
                  disabled={busy}
                  onclick={() => void revokeGrant(grant)}
                >
                  <Unplug size={14} />
                </IconButton>
              </div>
            {/each}
          </div>
        {:else}
          <div
            class="rounded-[var(--r-lg)] border border-dashed border-[var(--border-default)] p-5 text-center text-[11.5px] text-[var(--text-quaternary)]"
          >
            {i18n.t('settings.mcp_no_clients')}
          </div>
        {/if}
      </section>

      <section
        class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
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
              class="mt-1 text-[11px] leading-relaxed text-[var(--text-tertiary)]"
            >
              {i18n.t('settings.mcp_privacy_desc')}
            </p>
          </div>
        </div>
      </section>
    </div>
  {/if}
{/if}
