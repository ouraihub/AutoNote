<script lang="ts">
  import { onMount } from 'svelte'
  import { ModelSelect, ProvidersSettings } from '@ouraihub/aether-ui/providers'
  import type { ModelRef } from '@ouraihub/aether-ui/ports'
  import Button from '@app/components/primitives/Button.svelte'
  import Select from '@app/components/primitives/Select.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import type { AiRole, AiRoleBinding } from '@app/backend'
  import { errorMessageKey } from '@app/i18n/errors'
  import { logFailure } from '@app/log/logger'
  import { getBackend, getI18n, getLogger, getSession } from '@app/root/context'
  import type { MessageKey } from '@shared/locales/en-US'

  const aiHost = getBackend().aiHost
  const i18n = getI18n()
  const logger = getLogger()
  const session = getSession()
  const uid = $props.id()
  let roles = $state<AiRoleBinding[]>([])
  let endpoints = $state<{ id: string; label: string }[]>([])
  let endpointId = $state('')
  let password = $state('')
  let revealed = $state<string | null>(null)
  let busy = $state(false)
  let error = $state<MessageKey | null>(null)
  const errorText = $derived(error ? i18n.t(error) : '')
  const chatRole = $derived(roles.find((role) => role.role === 'chat'))
  const writingRole = $derived(roles.find((role) => role.role === 'writing'))

  async function attempt(event: string, action: () => Promise<void>): Promise<void> {
    busy = true
    error = null
    try {
      await action()
    } catch (cause) {
      logFailure(logger, event, cause)
      error = errorMessageKey(cause)
    } finally {
      busy = false
    }
  }
  const loadEndpoints = (): Promise<void> =>
    attempt('ai.endpoints.load_failed', async () => {
      const providers = (await aiHost?.kit.providers?.list()) ?? []
      endpoints = providers.flatMap((provider) =>
        provider.endpoints
          .filter((endpoint) => endpoint.hasKey)
          .map((endpoint) => ({ id: endpoint.id, label: `${provider.name} · ${endpoint.slug}` })),
      )
      if (!endpoints.some((endpoint) => endpoint.id === endpointId)) endpointId = endpoints[0]?.id ?? ''
    })
  const setRole = (role: AiRole, binding: ModelRef | null): Promise<void> =>
    attempt('ai.roles.save_failed', async () => {
      if (aiHost) roles = await aiHost.setRole(role, binding)
    })

  onMount(() => {
    void attempt('ai.roles.load_failed', async () => {
      if (aiHost) roles = await aiHost.roles()
    })
    void loadEndpoints()
  })
  $effect(() => {
    void session.epoch
    revealed = null
    password = ''
  })
</script>

{#if aiHost}
  <div class="space-y-6">
    <ProvidersSettings />

    <section aria-labelledby={`${uid}-roles`}>
      <h3 id={`${uid}-roles`} class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {i18n.t('ai.roles')}
      </h3>
      <SettingRow title={i18n.t('ai.role_chat')} description={i18n.t('ai.role_chat_desc')}>
        <div class="w-[260px]">
          <ModelSelect
            value={chatRole?.binding ?? null}
            filter={{ modelType: 'chat' }}
            placeholder={i18n.t('ai.role_none')}
            onchange={(model) => void setRole('chat', model)}
          />
        </div>
      </SettingRow>
      <SettingRow title={i18n.t('ai.role_writing')} description={i18n.t('ai.role_writing_desc')}>
        <div class="flex w-[260px] flex-col items-stretch gap-1">
          <ModelSelect
            value={writingRole?.isFallback ? null : (writingRole?.binding ?? null)}
            filter={{ modelType: 'chat' }}
            placeholder={writingRole?.isFallback && writingRole.binding
              ? i18n.t('ai.role_follow_chat_current', { label: writingRole.binding.label })
              : i18n.t('ai.role_follow_chat')}
            onchange={(model) => void setRole('writing', model)}
          />
          {#if writingRole?.binding && !writingRole.isFallback}
            <Button size="sm" variant="ghost" disabled={busy} onclick={() => void setRole('writing', null)}
              >{i18n.t('ai.role_follow_chat')}</Button
            >
          {/if}
        </div>
      </SettingRow>
    </section>

    <section aria-labelledby={`${uid}-key`}>
      <h3 id={`${uid}-key`} class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
        {i18n.t('ai.key_reveal')}
      </h3>
      <SettingRow title={i18n.t('ai.key_reveal_endpoint')} description={i18n.t('ai.key_reveal_desc')}>
        <div class="flex w-[260px] flex-col gap-2">
          <Select
            aria-label={i18n.t('ai.key_reveal_endpoint')}
            bind:value={endpointId}
            disabled={busy || endpoints.length === 0}
            onfocus={() => void loadEndpoints()}
            onchange={() => (revealed = null)}
          >
            {#each endpoints as endpoint (endpoint.id)}
              <option value={endpoint.id}>{endpoint.label}</option>
            {:else}
              <option value="">{i18n.t('ai.key_reveal_none')}</option>
            {/each}
          </Select>
          {#if aiHost.revealNeedsPassword}
            <TextInput
              type="password"
              bind:value={password}
              aria-label={i18n.t('settings.current_password')}
              placeholder={i18n.t('settings.current_password')}
              autocomplete="current-password"
              disabled={busy}
            />
          {/if}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || !endpointId || (aiHost.revealNeedsPassword && !password)}
            onclick={() =>
              void attempt('ai.key.reveal_failed', async () => {
                revealed = await aiHost.revealKey(endpointId, aiHost.revealNeedsPassword ? password : null)
                password = ''
              })}>{i18n.t('ai.key_reveal_action')}</Button
          >
        </div>
      </SettingRow>
      {#if revealed !== null}
        <div
          class="flex items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-3 py-2"
        >
          <code class="min-w-0 flex-1 font-mono text-[12px] break-all text-[var(--text-primary)]">{revealed}</code>
          <Button size="sm" variant="ghost" onclick={() => void navigator.clipboard.writeText(revealed ?? '')}
            >{i18n.t('common.copy')}</Button
          >
          <Button size="sm" variant="ghost" onclick={() => (revealed = null)}>{i18n.t('ai.api_key_hide')}</Button>
        </div>
      {/if}
    </section>

    {#if errorText}<p role="alert" class="text-[11px] text-[var(--danger)]">{errorText}</p>{/if}
  </div>
{/if}
