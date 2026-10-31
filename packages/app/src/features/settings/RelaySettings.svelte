<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    Check,
    Copy,
    GitBranch,
    KeyRound,
    RefreshCw,
    Trash2,
    Waypoints,
  } from '@lucide/svelte'
  import type { Protocol } from '@ouraihub/aether-ui/ports'
  import type {
    RelayKey,
    RelayPort,
    RelayRepo,
    RelaySettingsInfo,
  } from '@app/backend'
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

  const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
  const WORKFLOW =
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml$/
  const REF = /^refs\/(heads|tags)\/[A-Za-z0-9_./-]{1,200}$/
  const DEFAULT_REF = 'refs/heads/main'
  const SNIPPET_API: Record<Protocol, string> = {
    'openai-chat': 'openai-completions',
    'openai-responses': 'openai-responses',
    'anthropic-messages': 'anthropic-messages',
  }

  const backend = getBackend()
  const session = getSession()
  const i18n = getI18n()
  const notifier = getNotifier()
  const relay: RelayPort | undefined =
    backend.kind === 'web' && session.user?.role === 'owner'
      ? backend.relay
      : undefined
  let info = $state<RelaySettingsInfo | null>(null)
  let keyName = $state('')
  let repo = $state('')
  let workflow = $state('')
  let ref = $state(DEFAULT_REF)
  let token = $state<string | null>(null)
  let error = $state('')
  let busy = $state(false)
  let copied = $state<string | null>(null)
  let copiedTimer = 0
  let active = true
  const providerBlock = (endpoint: string, api: string) =>
    `  autonote-${api}:\n    baseUrl: ${JSON.stringify(endpoint)}\n    apiKey: ${JSON.stringify(i18n.t('settings.relay_api_key_placeholder'))}\n    api: ${api}\n    discovery:\n      type: openai-models-list\n`
  const snippet = $derived(
    info?.protocols.length
      ? `providers:\n${info.protocols.map((protocol) => providerBlock(info!.endpoint, SNIPPET_API[protocol])).join('')}`
      : 'providers: {}',
  )
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

  async function run(
    action: (port: RelayPort, signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (!relay || busy) return
    busy = true
    error = ''
    try {
      await action(relay, session.epochSignal)
    } catch (cause) {
      if (active && !session.epochSignal.aborted)
        error = i18n.t(cloudError(cause))
    } finally {
      busy = false
    }
  }

  const reload = () =>
    run(async (port, signal) => {
      const latest = await port.get({ signal })
      if (active) info = latest
    })

  const toggle = () =>
    run(async (port, signal) => {
      if (!info) return
      const { enabled } = await port.setEnabled(!info.enabled, { signal })
      if (active && info) info = { ...info, enabled }
    })

  function create(): void {
    const name = keyName.trim()
    if (!name) {
      error = i18n.t('settings.relay_key_name_required')
      return
    }
    void run(async (port, signal) => {
      const created = await port.createKey(name, { signal })
      if (active && info) {
        info = { ...info, keys: [created.key, ...info.keys] }
        token = created.token
        keyName = ''
      }
    })
  }

  async function revoke(key: RelayKey): Promise<void> {
    if (
      busy ||
      !(await notifier.confirm({
        titleKey: 'settings.relay_key_revoke_title',
        bodyKey: 'settings.relay_key_revoke_desc',
        danger: true,
      }))
    )
      return
    await run(async (port, signal) => {
      await port.revokeKey(key.id, { signal })
      if (active && info)
        info = { ...info, keys: info.keys.filter((item) => item.id !== key.id) }
    })
  }

  function addRepo(): void {
    const name = repo.trim()
    const path = workflow.trim()
    const branch = ref.trim()
    if (!REPO.test(name)) {
      error = i18n.t('settings.relay_repo_invalid')
      return
    }
    if (!WORKFLOW.test(path)) {
      error = i18n.t('settings.relay_workflow_invalid')
      return
    }
    if (!REF.test(branch)) {
      error = i18n.t('settings.relay_ref_invalid')
      return
    }
    void run(async (port, signal) => {
      const { repos } = await port.addRepo(name, path, branch, { signal })
      if (active && info) {
        info = { ...info, repos }
        repo = ''
        workflow = ''
        ref = DEFAULT_REF
      }
    })
  }

  async function removeRepo(item: RelayRepo): Promise<void> {
    if (
      busy ||
      !(await notifier.confirm({
        titleKey: 'settings.relay_repo_remove_title',
        bodyKey: 'settings.relay_repo_remove_desc',
        danger: true,
      }))
    )
      return
    await run(async (port, signal) => {
      const { repos } = await port.removeRepo(item.repo, { signal })
      if (active && info) info = { ...info, repos }
    })
  }

  onMount(() => {
    if (relay) void reload()
    return () => {
      active = false
      token = null
      window.clearTimeout(copiedTimer)
    }
  })
</script>

{#if relay && session.status === 'authed'}
  {#if !info}
    {#if error}
      <div
        class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-4"
      >
        <p role="alert" class="text-[12.5px] text-[var(--danger)]">{error}</p>
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
        {i18n.t('settings.relay_loading')}
      </p>
    {/if}
  {:else}
    <div class="space-y-6">
      {#if !info.enabled}
        <p
          role="status"
          class="flex items-start gap-2 rounded-[var(--r-md)] border border-[color-mix(in_oklab,var(--warning)_40%,transparent)] bg-[color-mix(in_oklab,var(--warning)_12%,transparent)] px-3 py-2.5 text-[12px] font-medium text-[var(--warning)]"
        >
          <AlertTriangle size={14} class="mt-0.5 shrink-0" />{i18n.t(
            'settings.relay_paused_notice',
          )}
        </p>
      {/if}
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
            ><Waypoints size={18} /></span
          >
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <h3
                class="text-[13.5px] font-semibold text-[var(--text-primary)]"
              >
                {i18n.t('settings.relay')}
              </h3>
              <span
                class={[
                  badge,
                  info.enabled
                    ? 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]'
                    : 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
                ]}
              >
                {info.enabled
                  ? i18n.t('settings.relay_running')
                  : i18n.t('settings.relay_paused')}
              </span>
            </div>
            <p
              class="mt-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
            >
              {i18n.t('settings.relay_intro')}
            </p>
          </div>
        </div>
        <SettingRow
          title={i18n.t('settings.relay_enable')}
          description={i18n.t('settings.relay_enable_desc')}
        >
          <Switch
            checked={info.enabled}
            disabled={busy}
            label={i18n.t('settings.relay_enable')}
            onChange={() => void toggle()}
          />
        </SettingRow>
      </section>

      <section>
        <h3 class={['mb-2 px-1', sectionHeading]}>
          {i18n.t('settings.relay_keys')}
        </h3>
        <p
          class="mb-3 px-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
        >
          {i18n.t('settings.relay_keys_desc')}
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
            create()
          }}
        >
          <TextInput
            bind:value={keyName}
            disabled={busy || !!token}
            aria-label={i18n.t('settings.relay_key_name')}
            maxlength={80}
            autocomplete="off"
            placeholder={i18n.t('settings.relay_key_name_placeholder')}
            required
          />
          <Button type="submit" variant="secondary" disabled={busy || !!token}>
            <KeyRound size={13} />{i18n.t('settings.mcp_api_key_create')}
          </Button>
        </form>

        {#if info.keys.length}
          <div
            class="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
          >
            {#each info.keys as key (key.id)}
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
                      key.lastUsedAt
                        ? i18n.t('settings.relay_key_last_used', {
                            time: fullTime(key.lastUsedAt),
                          })
                        : i18n.t('settings.mcp_api_key_unused'),
                      i18n.t('settings.relay_key_today', {
                        count: key.todayRequests,
                      }),
                      key.expiresAt
                        ? i18n.t('settings.relay_key_expires', {
                            time: fullTime(key.expiresAt),
                          })
                        : i18n.t('settings.relay_key_never_expires'),
                    ].join(' · ')}
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
            {i18n.t('settings.relay_keys_empty')}
          </div>
        {/if}
      </section>

      <section>
        <h3 class={['mb-2 px-1', sectionHeading]}>
          {i18n.t('settings.relay_repos')}
        </h3>
        <p
          class="mb-3 px-1 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
        >
          {i18n.t('settings.relay_repos_desc')}
        </p>
        <form
          class="mb-2 flex flex-wrap items-center gap-2"
          onsubmit={(event) => {
            event.preventDefault()
            addRepo()
          }}
        >
          <TextInput
            bind:value={repo}
            disabled={busy}
            aria-label={i18n.t('settings.relay_repo')}
            maxlength={201}
            autocomplete="off"
            placeholder={i18n.t('settings.relay_repo_placeholder')}
            required
          />
          <TextInput
            bind:value={workflow}
            disabled={busy}
            aria-label={i18n.t('settings.relay_workflow')}
            autocomplete="off"
            placeholder={i18n.t('settings.relay_workflow_placeholder')}
            required
          />
          <TextInput
            bind:value={ref}
            disabled={busy}
            aria-label={i18n.t('settings.relay_ref')}
            maxlength={220}
            autocomplete="off"
            placeholder={i18n.t('settings.relay_ref_placeholder')}
            required
          />
          <Button type="submit" variant="secondary" disabled={busy}
            ><GitBranch size={13} />{i18n.t('settings.relay_repo_add')}</Button
          >
        </form>
        {#if info.repos.length}
          <div
            class="overflow-hidden rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]"
          >
            {#each info.repos as item (item.repo)}
              <div
                class="flex items-center gap-3 border-b border-[var(--border-subtle)] p-3.5 last:border-b-0"
              >
                <span
                  class="rounded-[var(--r-sm)] bg-[var(--bg-raised)] p-2 text-[var(--text-tertiary)]"
                  ><GitBranch size={15} /></span
                >
                <div class="min-w-0 flex-1">
                  <div
                    class="truncate font-mono text-[12px] font-medium text-[var(--text-primary)]"
                  >
                    {item.repo}
                  </div>
                  <div
                    class="mt-0.5 truncate font-mono text-[10.5px] text-[var(--text-quaternary)]"
                  >
                    {item.workflow}
                  </div>
                  <div
                    class="truncate font-mono text-[10.5px] text-[var(--text-quaternary)]"
                  >
                    {item.ref}
                  </div>
                </div>
                <IconButton
                  label={i18n.t('settings.relay_repo_remove')}
                  title={i18n.t('settings.relay_repo_remove')}
                  size="sm"
                  disabled={busy}
                  onclick={() => void removeRepo(item)}
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
            {i18n.t('settings.relay_repos_empty')}
          </div>
        {/if}
      </section>

      <section>
        <h3 class={['mb-2 px-1', sectionHeading]}>
          {i18n.t('settings.relay_setup')}
        </h3>
        <div
          class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-3.5"
        >
          <div class="mb-1 text-[11px] font-medium text-[var(--text-tertiary)]">
            {i18n.t('settings.relay_endpoint')}
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
          <div class="mt-3 mb-1 flex items-center justify-between gap-2">
            <span class="text-[11px] font-medium text-[var(--text-tertiary)]"
              >{i18n.t('settings.relay_models_yml')}</span
            >
            <Button
              size="sm"
              variant="ghost"
              onclick={() => void copy('snippet', snippet)}
            >
              {#if copied === 'snippet'}<Check size={12} />{:else}<Copy
                  size={12}
                />{/if}{copied === 'snippet'
                ? i18n.t('common.copied')
                : i18n.t('common.copy')}
            </Button>
          </div>
          <pre
            class="overflow-x-auto rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2.5 py-2 font-mono text-[11px] text-[var(--text-secondary)]">{snippet}</pre>
          <p
            class="mt-2 text-[10.5px] leading-relaxed text-[var(--text-quaternary)]"
          >
            {i18n.t('settings.relay_setup_desc')}
          </p>
        </div>
      </section>
    </div>
  {/if}
{/if}
