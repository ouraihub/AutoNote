<script lang="ts">
  import { onMount } from 'svelte'
  import { Plus } from '@lucide/svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { cn } from '@app/utils'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Select from '@app/components/primitives/Select.svelte'
  import SettingRow from '@app/components/primitives/SettingRow.svelte'
  import type { Backend } from '@app/backend'
  import { getBackend, getI18n, getNotifier } from '@app/root/context'
  import type { AiModelRef, AiPort, AiProvider, AiRole, AiRoleBinding } from '../../ipc/ports/ai'
  import EndpointCard, { DOT, hasKey, toDraft, toSave, type EndpointDraft } from './EndpointCard.svelte'

  const hasAi = (value: Backend): value is Backend & { ai: AiPort } => 'ai' in value && value.ai !== undefined
  const i18n = getI18n()
  const notifier = getNotifier()
  const backend = getBackend()
  const ai = hasAi(backend) ? backend.ai : undefined
  let providers = $state<AiProvider[]>([])
  let roles = $state<AiRoleBinding[]>([])
  let loaded = $state(false)
  let selectedId = $state<string | null>(null)
  let editing = $state(false)
  let name = $state('')
  let endpoints = $state<EndpointDraft[]>([])
  let expanded = $state<number | null>(null)
  let busy = $state(false)
  let error = $state<'common.action_failed' | 'ai.name_required' | null>(null)
  let nameInput = $state<HTMLInputElement>()
  const uid = $props.id()
  // Draft snapshot taken on select/save; the save payload shape is what "unsaved" compares.
  let baseline = $state('')
  const snapshot = (): string => JSON.stringify([name.trim(), endpoints.map(toSave)])
  const stored = $derived(providers.find((provider) => provider.id === selectedId))
  const unsaved = $derived(editing && (!stored || snapshot() !== baseline))

  const chatModels = $derived(
    providers.flatMap((provider) =>
      provider.endpoints.flatMap((endpoint) =>
        endpoint.models
          .filter((model) => model.modelType === 'chat')
          .map((model) => ({
            value: refValue({ endpointId: endpoint.id, modelId: model.id }),
            label: `${provider.name} · ${endpoint.slug} · ${model.id}`,
          })),
      ),
    ),
  )
  const chatRole = $derived(roles.find((item) => item.role === 'chat'))
  const writingRole = $derived(roles.find((item) => item.role === 'writing'))

  onMount(() => {
    if (!ai) return
    let active = true
    void Promise.all([ai.listProviders(), ai.roles()])
      .then(([list, bindings]) => {
        if (!active) return
        providers = list
        roles = bindings
        loaded = true
        if (list[0]) select(list[0])
      })
      .catch(() => {
        if (active) error = 'common.action_failed'
      })
    return () => {
      active = false
    }
  })

  function refValue(ref: AiModelRef): string {
    return JSON.stringify([ref.endpointId, ref.modelId])
  }
  function parseRef(value: string): AiModelRef | null {
    if (!value) return null
    const [endpointId, modelId] = JSON.parse(value) as [string, string]
    return { endpointId, modelId }
  }
  function select(provider: AiProvider | null): void {
    selectedId = provider?.id ?? null
    editing = true
    error = null
    name = provider?.name ?? ''
    endpoints = provider ? provider.endpoints.map((endpoint) => toDraft(endpoint)) : [toDraft()]
    expanded = endpoints[0]?.key ?? null
    baseline = snapshot()
    if (!provider) queueMicrotask(() => nameInput?.focus())
  }
  function providerStatus(provider: AiProvider): keyof typeof DOT {
    const drafts = provider.endpoints.map((endpoint) => toDraft(endpoint))
    if (drafts.length > 0 && drafts.every((draft) => hasKey(draft) && draft.models.length > 0)) return 'ready'
    return drafts.some(hasKey) ? 'partial' : 'none'
  }
  function addEndpoint(): void {
    const draft = toDraft()
    endpoints.push(draft)
    expanded = draft.key
  }
  async function run(action: (port: AiPort) => Promise<void>): Promise<void> {
    if (busy || !ai) return
    busy = true
    error = null
    try {
      await action(ai)
    } catch {
      error = 'common.action_failed'
    } finally {
      busy = false
    }
  }
  const save = (): Promise<void> =>
    run(async (port) => {
      const trimmed = name.trim()
      if (!trimmed || endpoints.some((endpoint) => !endpoint.slug.trim() || !endpoint.baseUrl.trim())) {
        error = 'ai.name_required'
        return
      }
      const known = new Set(providers.map((provider) => provider.id))
      const list = await port.saveProvider({
        ...(selectedId ? { id: selectedId } : {}),
        name: trimmed,
        endpoints: endpoints.map(toSave),
      })
      providers = list
      select(list.find((provider) => provider.id === selectedId || !known.has(provider.id)) ?? null)
      roles = await port.roles()
    })
  async function remove(): Promise<void> {
    const id = selectedId
    if (
      busy ||
      !id ||
      !(await notifier.confirm({
        titleKey: 'ai.provider_delete_title',
        bodyKey: 'ai.provider_delete_desc',
        params: { name: name.trim() || i18n.t('ai.provider_untitled') },
        danger: true,
      }))
    )
      return
    await run(async (port) => {
      await port.deleteProvider(id)
      providers = providers.filter((provider) => provider.id !== id)
      roles = await port.roles()
      if (providers[0]) select(providers[0])
      else {
        selectedId = null
        editing = false
      }
    })
  }
  const setRole = (role: AiRole, value: string): Promise<void> =>
    run(async (port) => {
      roles = await port.setRole(role, parseRef(value))
    })
</script>

{#if ai}
  <div class="space-y-6">
    {#if loaded}
      <div class="flex flex-col gap-4 md:flex-row">
        <nav
          aria-labelledby={`${uid}-providers`}
          class="md:w-[176px] md:shrink-0 md:border-r md:border-[var(--border-subtle)] md:pr-3"
        >
          <div class="mb-1 flex items-center justify-between">
            <h3
              id={`${uid}-providers`}
              class="text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
            >
              {i18n.t('ai.providers')}
            </h3>
            <IconButton size="sm" label={i18n.t('ai.provider_new')} disabled={busy} onclick={() => select(null)}>
              <Plus size={13} />
            </IconButton>
          </div>
          <ul class="space-y-0.5">
            {#each providers as provider (provider.id)}
              {@const current = editing && selectedId === provider.id}
              <li>
                <button
                  type="button"
                  aria-current={current ? 'true' : undefined}
                  class={[
                    'w-full rounded-[var(--r-md)] px-2 py-1.5 text-left transition-colors',
                    current ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                  ]}
                  disabled={busy}
                  onclick={() => select(provider)}
                >
                  <span class="flex items-center gap-2">
                    <span class={['size-2 shrink-0 rounded-full', DOT[providerStatus(provider)]]} aria-hidden="true"
                    ></span>
                    <span class="truncate text-[12.5px] font-medium text-[var(--text-primary)]">{provider.name}</span>
                  </span>
                  <span class="mt-0.5 block truncate pl-4 text-[11px] text-[var(--text-tertiary)]">
                    {i18n.t('ai.endpoint_count', { count: provider.endpoints.length })}
                  </span>
                </button>
              </li>
            {/each}
            {#if editing && !selectedId}<li class="rounded-[var(--r-md)] bg-[var(--accent-soft)] px-2 py-1.5 pl-6">
                <span class="block truncate text-[12.5px] font-medium text-[var(--text-primary)]"
                  >{name.trim() || i18n.t('ai.provider_new')}</span
                >
                <span class="block text-[11px] text-[var(--text-tertiary)]">{i18n.t('ai.not_saved')}</span>
              </li>{/if}
            {#if providers.length === 0 && !(editing && !selectedId)}<li
                class="px-2 py-1.5 text-[12px] text-[var(--text-tertiary)]"
              >
                {i18n.t('ai.providers_empty')}
              </li>{/if}
          </ul>
        </nav>

        {#if editing}
          <div class="min-w-0 flex-1 space-y-3">
            <div class="flex items-center gap-2 border-b border-[var(--border-subtle)] pb-3">
              <label for={`${uid}-name`} class="shrink-0 text-[12px] text-[var(--text-tertiary)]"
                >{i18n.t('ai.provider_name')}</label
              >
              <TextInput
                id={`${uid}-name`}
                bind:ref={nameInput}
                bind:value={name}
                maxlength={80}
                autocomplete="off"
                placeholder={i18n.t('ai.provider_untitled')}
                disabled={busy}
                class={cn(
                  'flex-1 text-[14px] font-semibold md:h-8',
                  name.trim() && 'border-transparent bg-transparent',
                )}
              />
              <span class="shrink-0 text-[11.5px] text-[var(--text-tertiary)]"
                >{i18n.t('ai.endpoint_count', { count: endpoints.length })}</span
              >
            </div>
            {#each endpoints as endpoint, index (endpoint.key)}
              <EndpointCard
                bind:draft={endpoints[index]!}
                saved={stored?.endpoints.find((item) => item.id === endpoint.id)}
                {ai}
                disabled={busy}
                expanded={expanded === endpoint.key}
                canRemove={endpoints.length > 1}
                onToggle={() => (expanded = expanded === endpoint.key ? null : endpoint.key)}
                onRemove={() => (endpoints = endpoints.filter((item) => item.key !== endpoint.key))}
              />
            {/each}
            <Button size="sm" variant="secondary" disabled={busy} onclick={addEndpoint}
              ><Plus size={13} />{i18n.t('ai.endpoint_add')}</Button
            >
            <div class="flex items-center gap-3 pt-1">
              <Button size="sm" variant="primary" loading={busy} onclick={() => void save()}
                >{i18n.t('common.save')}</Button
              >
              {#if unsaved}<span class="text-[11.5px] text-[var(--warning)]">{i18n.t('ai.unsaved')}</span>{/if}
              {#if selectedId}<Button
                  size="sm"
                  variant="ghost"
                  class="ml-auto text-[var(--text-tertiary)] hover:text-[var(--danger)]"
                  disabled={busy}
                  onclick={() => void remove()}>{i18n.t('ai.provider_delete')}</Button
                >{/if}
            </div>
          </div>
        {/if}
      </div>

      <section aria-labelledby={`${uid}-roles`}>
        <h3 id={`${uid}-roles`} class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
          {i18n.t('ai.roles')}
        </h3>
        {#if chatModels.length === 0}<p class="py-2 text-[12px] text-[var(--text-tertiary)]">
            {i18n.t('ai.roles_empty')}
          </p>{/if}
        <SettingRow title={i18n.t('ai.role_chat')} description={i18n.t('ai.role_chat_desc')}>
          <Select
            class="w-[260px]"
            aria-label={i18n.t('ai.role_chat')}
            disabled={busy || chatModels.length === 0}
            value={chatRole?.binding ? refValue(chatRole.binding) : ''}
            onchange={(event) => void setRole('chat', event.currentTarget.value)}
          >
            <option value="">{i18n.t('ai.role_none')}</option>
            {#each chatModels as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
          </Select>
        </SettingRow>
        <SettingRow title={i18n.t('ai.role_writing')} description={i18n.t('ai.role_writing_desc')}>
          <Select
            class="w-[260px]"
            aria-label={i18n.t('ai.role_writing')}
            disabled={busy || chatModels.length === 0}
            value={writingRole?.binding && !writingRole.isFallback ? refValue(writingRole.binding) : ''}
            onchange={(event) => void setRole('writing', event.currentTarget.value)}
          >
            <option value=""
              >{writingRole?.isFallback && writingRole.binding
                ? i18n.t('ai.role_follow_chat_current', { label: writingRole.binding.label })
                : i18n.t('ai.role_follow_chat')}</option
            >
            {#each chatModels as option (option.value)}<option value={option.value}>{option.label}</option>{/each}
          </Select>
        </SettingRow>
      </section>
    {/if}
    {#if error}<p role="alert" class="text-[11.5px] text-[var(--danger)]">{i18n.t(error)}</p>{/if}
  </div>
{/if}
