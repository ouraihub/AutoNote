<script lang="ts">
  import { onMount } from 'svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import Switch from '@app/components/primitives/Switch.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import { getBackend, getI18n, getNotifier } from '@app/root'
  import type { LocalMcpPort } from '@app/backend'
  import { isBackendError } from '@app/backend/errors'
  import type { McpLocalStatus } from '@shared/backend-types'
  import type { McpApiKey, McpPreferences } from '@shared/types'

  const i18n = getI18n()
  const notifier = getNotifier()
  const backend = getBackend()
  const mcp = backend.mcp as LocalMcpPort
  let status = $state<McpLocalStatus>()
  let prefs = $state<McpPreferences>()
  let keys = $state<McpApiKey[]>([])
  let port = $state('')
  let keyName = $state('')
  let token = $state<string | null>(null)
  let busy = $state(false)
  let error = $state<'common.action_failed' | 'desktop.mcpPortInUse' | 'settings.mcp_api_key_name_required' | null>(
    null,
  )

  onMount(() => {
    let active = true
    const unsubscribe = mcp.subscribe((value) => {
      if (active) status = value
    })
    void Promise.all([mcp.status(), mcp.getPreferences(), mcp.listKeys()])
      .then(([current, preferences, list]) => {
        if (!active) return
        status = current
        port = String(current.port)
        prefs = preferences
        keys = list
      })
      .catch(() => {
        if (active) error = 'common.action_failed'
      })
    return () => {
      active = false
      unsubscribe()
      // Token is one-time material; never keep it past the view.
      token = null
    }
  })

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return
    busy = true
    error = null
    try {
      await action()
    } catch (cause) {
      error = isBackendError(cause) && cause.code === 'conflict' ? 'desktop.mcpPortInUse' : 'common.action_failed'
    } finally {
      busy = false
    }
  }
  const toggle = (): Promise<void> =>
    run(async () => {
      if (status?.running) status = await mcp.stop()
      else {
        const wanted = Number(port)
        if (status && wanted !== status.port) status = await mcp.setPort(wanted)
        status = await mcp.start()
      }
    })
  const savePreference = (patch: Partial<Pick<McpPreferences, 'writeEnabled' | 'trashEnabled'>>): Promise<void> =>
    run(async () => {
      prefs = await mcp.savePreferences(patch)
    })
  const create = (): Promise<void> =>
    run(async () => {
      const name = keyName.trim()
      if (!name) {
        error = 'settings.mcp_api_key_name_required'
        return
      }
      const created = await mcp.createKey(name)
      token = created.token
      keyName = ''
      keys = [...keys, created.key]
    })
  async function revoke(key: McpApiKey): Promise<void> {
    if (
      busy ||
      !(await notifier.confirm({
        titleKey: 'settings.mcp_api_key_revoke_title',
        bodyKey: 'settings.mcp_api_key_revoke_desc',
        params: { name: key.name },
        danger: true,
      }))
    )
      return
    await run(async () => {
      await mcp.revokeKey(key.id)
      keys = keys.filter((item) => item.id !== key.id)
    })
  }
  // Snippet embeds only the loopback endpoint and the one-time bearer token.
  function snippet(secret: string): string {
    const endpoint = status?.endpoint ?? `http://127.0.0.1:${port}/mcp`
    return `claude mcp add --transport http autonote ${endpoint} --header "Authorization: Bearer ${secret}"`
  }
  async function copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      notifier.toast({ key: 'settings.mcp_copied', tone: 'success' })
    } catch {
      error = 'common.action_failed'
    }
  }
</script>

<div class="space-y-6">
  {#if status && prefs}
    <section class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4">
      <div class="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          class={['size-2 shrink-0 rounded-full', status.running ? 'bg-[var(--success)]' : 'bg-[var(--border-strong)]']}
        ></span>
        <div class="min-w-0 flex-1">
          <div class="text-[13px] font-medium text-[var(--text-primary)]">{i18n.t('settings.mcp')}</div>
          <div role="status" class="mt-0.5 truncate text-[11.5px] text-[var(--text-tertiary)]">
            {status.running && status.endpoint
              ? i18n.t('desktop.mcpRunning', { endpoint: status.endpoint })
              : i18n.t('desktop.mcpStopped')}
          </div>
        </div>
        <Button
          size="sm"
          variant={status.running ? 'secondary' : 'primary'}
          loading={busy}
          onclick={() => void toggle()}
          >{status.running ? i18n.t('desktop.mcpStop') : i18n.t('desktop.mcpStart')}</Button
        >
      </div>
    </section>

    <section>
      <SettingRow title={i18n.t('desktop.mcpPort')} description={i18n.t('desktop.mcpPortHint')}>
        <TextInput
          id="mcp-port"
          aria-label={i18n.t('desktop.mcpPort')}
          class="w-[120px] tabular"
          type="number"
          min={1024}
          max={65535}
          disabled={busy || status.running}
          bind:value={port}
        />
      </SettingRow>
      <SettingRow title={i18n.t('settings.mcp_write_access')} description={i18n.t('settings.mcp_write_access_desc')}>
        <Switch
          id="mcp-write"
          label={i18n.t('settings.mcp_write_access')}
          disabled={busy}
          checked={prefs.writeEnabled}
          onChange={(writeEnabled) => void savePreference({ writeEnabled })}
        />
      </SettingRow>
      <SettingRow title={i18n.t('settings.mcp_trash_access')} description={i18n.t('settings.mcp_trash_access_desc')}>
        <Switch
          id="mcp-trash"
          label={i18n.t('settings.mcp_trash_access')}
          disabled={busy}
          checked={prefs.trashEnabled}
          onChange={(trashEnabled) => void savePreference({ trashEnabled })}
        />
      </SettingRow>
    </section>

    <section aria-labelledby="mcp-keys-title">
      <h3 id="mcp-keys-title" class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {i18n.t('settings.mcp_api_keys')}
      </h3>
      {#if keys.length === 0}<p class="py-3 text-[12px] text-[var(--text-tertiary)]">
          {i18n.t('settings.mcp_api_keys_empty')}
        </p>{/if}
      {#each keys as key (key.id)}
        <SettingRow title={key.name} description={key.scopes.join(' · ')}>
          <Button size="sm" variant="ghost" disabled={busy} onclick={() => void revoke(key)}
            >{i18n.t('settings.mcp_api_key_revoke')}</Button
          >
        </SettingRow>
      {/each}
      <div class="flex gap-2 pt-3">
        <TextInput
          class="flex-1"
          aria-label={i18n.t('settings.mcp_api_key_name')}
          placeholder={i18n.t('settings.mcp_api_key_name_placeholder')}
          maxlength={80}
          autocomplete="off"
          disabled={busy || token !== null}
          bind:value={keyName}
        />
        <Button variant="primary" disabled={busy || token !== null} onclick={() => void create()}
          >{i18n.t('settings.mcp_api_key_create')}</Button
        >
      </div>
      {#if token}
        <div
          class="mt-3 space-y-2 rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
          role="region"
          aria-live="polite"
        >
          <p role="alert" class="text-[12px] font-medium text-[var(--warning)]">
            {i18n.t('settings.mcp_api_key_copy_warning')}
          </p>
          <p class="text-[11px] text-[var(--text-tertiary)]">{i18n.t('desktop.mcpConfigSnippet')}</p>
          <code
            class="block rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-2 text-[11.5px] break-all text-[var(--text-secondary)]"
            >{snippet(token)}</code
          >
          <div class="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onclick={() => (token = null)}>{i18n.t('common.close')}</Button>
            <Button size="sm" onclick={() => void copy(snippet(token!))}>{i18n.t('settings.mcp_copy')}</Button>
          </div>
        </div>
      {/if}
    </section>
  {/if}
  {#if error}<p role="alert" class="text-[11.5px] text-[var(--danger)]">{i18n.t(error)}</p>{/if}
</div>
