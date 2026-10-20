<script lang="ts">
  import { onMount } from 'svelte'
  import { ModelSelect, ProvidersSettings } from '@ouraihub/aether-ui/providers'
  import type { ModelRef } from '@ouraihub/aether-ui/ports'
  import Button from '@app/components/primitives/Button.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import type { AiRole, AiRoleBinding } from '@app/backend'
  import { errorMessageKey } from '@app/i18n/errors'
  import { logFailure } from '@app/log/logger'
  import { getBackend, getI18n, getLogger } from '@app/root/context'
  import type { MessageKey } from '@shared/locales/en-US'
  import { PROVIDER_PRESETS } from './presets'

  const aiHost = getBackend().aiHost
  const i18n = getI18n()
  const logger = getLogger()
  const uid = $props.id()
  let roles = $state<AiRoleBinding[]>([])
  let providerRevision = $state(0)
  let busy = $state(false)
  let error = $state<MessageKey | null>(null)
  const errorText = $derived(error ? i18n.t(error) : '')
  const chatRole = $derived(roles.find((role) => role.role === 'chat'))
  const writingRole = $derived(roles.find((role) => role.role === 'writing'))
  const paintingRole = $derived(roles.find((role) => role.role === 'painting'))
  const roleNames: Record<AiRole, MessageKey> = {
    chat: 'ai.role_chat',
    writing: 'ai.role_writing',
    painting: 'ai.role_painting',
  }
  const usedBy = (endpointId: string, modelId: string): string[] =>
    roles
      .filter((role) => role.binding?.endpointId === endpointId && role.binding.modelId === modelId)
      .map((role) => i18n.t(roleNames[role.role]))

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
  const setRole = (role: AiRole, binding: ModelRef | null): Promise<void> =>
    attempt('ai.roles.save_failed', async () => {
      if (aiHost) roles = await aiHost.setRole(role, binding)
    })

  function providersChanged(): void {
    void attempt('ai.roles.load_failed', async () => {
      if (aiHost) roles = await aiHost.roles()
      providerRevision++
    })
  }

  onMount(() => {
    void attempt('ai.roles.load_failed', async () => {
      if (aiHost) roles = await aiHost.roles()
    })
  })
</script>

{#if aiHost}
  <div class="space-y-6">
    <ProvidersSettings onchanged={providersChanged} presets={PROVIDER_PRESETS} {usedBy} />

    {#key providerRevision}
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
        <SettingRow title={i18n.t('ai.role_painting')} description={i18n.t('ai.role_painting_desc')}>
          <div class="flex w-[260px] flex-col items-stretch gap-1">
            <ModelSelect
              value={paintingRole?.binding ?? null}
              filter={{ modelType: 'image' }}
              placeholder={i18n.t('ai.role_none')}
              onchange={(model) => void setRole('painting', model)}
            />
            {#if paintingRole?.binding}
              <Button size="sm" variant="ghost" disabled={busy} onclick={() => void setRole('painting', null)}
                >{i18n.t('ai.role_clear')}</Button
              >
            {/if}
          </div>
        </SettingRow>
      </section>
    {/key}

    {#if errorText}<p role="alert" class="text-[11px] text-[var(--danger)]">{errorText}</p>{/if}
  </div>
{/if}
