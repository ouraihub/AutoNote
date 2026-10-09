<script lang="ts" module>
  import type { AiEndpoint, AiEndpointSave, AiModel, AiProtocol } from '../../ipc/ports/ai'

  export interface EndpointDraft {
    key: number
    id: string | undefined
    slug: string
    slugTouched: boolean
    baseUrl: string
    protocol: AiProtocol
    keyMasked: string | null
    keyInput: string
    keyCleared: boolean
    models: AiModel[]
  }

  let seq = 0
  const defaultSlug = (protocol: AiProtocol): string => (protocol === 'anthropic-messages' ? 'anthropic' : 'openai')

  export function toDraft(endpoint?: AiEndpoint): EndpointDraft {
    const protocol = endpoint?.protocol ?? 'openai-chat'
    return {
      key: ++seq,
      id: endpoint?.id,
      slug: endpoint?.slug ?? defaultSlug(protocol),
      slugTouched: endpoint !== undefined,
      baseUrl: endpoint?.baseUrl ?? '',
      protocol,
      keyMasked: endpoint?.keyMasked ?? null,
      keyInput: '',
      keyCleared: false,
      models: endpoint?.models.map((model) => ({ ...model })) ?? [],
    }
  }

  // apiKey tri-state: omitted keeps the stored key, '' clears it, non-empty replaces it.
  export function toSave(draft: EndpointDraft): AiEndpointSave {
    const save: AiEndpointSave = {
      slug: draft.slug.trim(),
      baseUrl: draft.baseUrl.trim(),
      protocol: draft.protocol,
      models: draft.models.map((model) => ({ ...model })),
    }
    if (draft.id) save.id = draft.id
    if (draft.keyInput) save.apiKey = draft.keyInput
    else if (draft.keyCleared) save.apiKey = ''
    return save
  }

  // Draft fields the probe reads from the database; models don't affect it.
  export function connectionDirty(draft: EndpointDraft, saved: AiEndpoint | undefined): boolean {
    return (
      !saved ||
      draft.slug.trim() !== saved.slug ||
      draft.baseUrl.trim() !== saved.baseUrl ||
      draft.protocol !== saved.protocol ||
      draft.keyInput !== '' ||
      draft.keyCleared
    )
  }

  export const hasKey = (draft: EndpointDraft): boolean =>
    draft.keyInput !== '' || (!draft.keyCleared && draft.keyMasked !== null)

  export const DOT = {
    ready: 'bg-[var(--success)]',
    partial: 'bg-[var(--warning)]',
    none: 'bg-[var(--text-quaternary)]',
  } as const
</script>

<script lang="ts">
  import { ChevronDown, Eye, EyeOff, ListPlus, Minus, Trash2 } from '@lucide/svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Select from '@app/components/primitives/Select.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { getI18n } from '@app/root/context'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { AiModelType, AiPort, AiProbeError, AiProbeResult } from '../../ipc/ports/ai'
  import ModelPickerDialog, { TYPE_LABELS } from './ModelPickerDialog.svelte'

  let {
    draft = $bindable(),
    saved,
    ai,
    disabled,
    expanded,
    canRemove,
    onToggle,
    onRemove,
  }: {
    draft: EndpointDraft
    saved: AiEndpoint | undefined
    ai: AiPort
    disabled: boolean
    expanded: boolean
    canRemove: boolean
    onToggle: () => void
    onRemove: () => void
  } = $props()
  const uid = $props.id()
  const i18n = getI18n()
  const protocolLabels: Record<AiProtocol, MessageKey> = {
    'openai-chat': 'ai.protocol_openai_chat',
    'openai-responses': 'ai.protocol_openai_responses',
    'anthropic-messages': 'ai.protocol_anthropic_messages',
  }
  const PROTOCOLS = Object.keys(protocolLabels) as AiProtocol[]
  const MODEL_TYPES = Object.keys(TYPE_LABELS) as AiModelType[]
  const FIELD = 'font-mono text-[12px] md:h-8'
  let probed = $state<AiProbeResult['models']>([])
  let probeError = $state<AiProbeError | null>(null)
  let pickerOpen = $state(false)
  let revealed = $state<string | null>(null)
  let pending = $state(false)
  let failed = $state(false)
  const picked = $derived(new Set(draft.models.map((model) => model.id)))
  const dirty = $derived(connectionDirty(draft, saved))
  const keyed = $derived(hasKey(draft))
  const status = $derived(!keyed ? 'none' : draft.models.length > 0 ? 'ready' : 'partial')
  const keyState = $derived(i18n.t(draft.keyInput ? 'ai.key_changed' : keyed ? 'ai.key_set' : 'ai.key_missing'))
  const summary = $derived(`${draft.baseUrl.trim() || i18n.t('ai.base_url_missing')} · ${keyState}`)

  async function attempt(action: () => Promise<void>): Promise<void> {
    pending = true
    failed = false
    try {
      await action()
    } catch {
      failed = true
    } finally {
      pending = false
    }
  }
  function changeProtocol(protocol: AiProtocol): void {
    draft.protocol = protocol
    if (!draft.slugTouched) draft.slug = defaultSlug(protocol)
  }
  function clearKey(): void {
    draft.keyInput = ''
    draft.keyCleared = draft.keyMasked !== null
    revealed = null
  }
  const toggleReveal = (id: string): Promise<void> =>
    revealed === null
      ? attempt(async () => {
          revealed = await ai.revealKey(id)
        })
      : Promise.resolve(void (revealed = null))
  const probe = (id: string): Promise<void> =>
    attempt(async () => {
      probeError = null
      const result = await ai.probe(id)
      probeError = result.error
      probed = result.models
    })
  function fetchModels(id: string): void {
    pickerOpen = true
    void probe(id)
  }
  function errorText(error: AiProbeError): string {
    const text = i18n.t(PROBE_LABELS[error.kind], { status: error.status ?? '' })
    return error.message ? `${text} ${error.message}` : text
  }
  const PROBE_LABELS: Record<AiProbeError['kind'], MessageKey> = {
    missing_key: 'ai.probe_missing_key',
    unauthorized: 'ai.probe_unauthorized',
    not_found: 'ai.probe_not_found',
    rate_limited: 'ai.probe_rate_limited',
    status: 'ai.probe_status',
    timeout: 'ai.probe_timeout',
    connect: 'ai.probe_connect',
    invalid_body: 'ai.probe_invalid_body',
  }
</script>

<section class="rounded-[var(--r-lg)] border border-[var(--border-subtle)] bg-[var(--bg-base)]">
  <button
    type="button"
    aria-expanded={expanded}
    aria-controls={`${uid}-body`}
    class="flex w-full items-center gap-2 rounded-[var(--r-lg)] px-3 py-2 text-left hover:bg-[var(--bg-hover)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
    onclick={onToggle}
  >
    <span class={['size-2 shrink-0 rounded-full', DOT[status]]} aria-hidden="true"></span>
    <span class="shrink-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]"
      >{draft.slug.trim() || i18n.t('ai.endpoint_new')}</span
    >
    <span class="ml-auto min-w-0 truncate pl-2 text-[11.5px] text-[var(--text-tertiary)]"
      >{expanded ? '' : summary}</span
    >
    <ChevronDown
      size={12}
      aria-hidden="true"
      class={['shrink-0 text-[var(--text-tertiary)] transition-transform', expanded && 'rotate-180']}
    />
  </button>

  {#if expanded}
    <div id={`${uid}-body`} class="space-y-4 border-t border-[var(--border-subtle)] px-3 py-3">
      <section class="space-y-2">
        <h4 class="text-[12px] font-medium text-[var(--text-primary)]">{i18n.t('ai.connection')}</h4>
        <div class="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          <label for={`${uid}-protocol`} class="text-[12px] text-[var(--text-tertiary)]">{i18n.t('ai.protocol')}</label>
          <Select
            id={`${uid}-protocol`}
            class={FIELD}
            {disabled}
            value={draft.protocol}
            onchange={(event) => changeProtocol(event.currentTarget.value as AiProtocol)}
          >
            {#each PROTOCOLS as protocol (protocol)}<option value={protocol}
                >{protocol} — {i18n.t(protocolLabels[protocol])}</option
              >{/each}
          </Select>
          <label for={`${uid}-slug`} class="text-[12px] text-[var(--text-tertiary)]">{i18n.t('ai.slug')}</label>
          <TextInput
            id={`${uid}-slug`}
            class={FIELD}
            maxlength={40}
            autocomplete="off"
            spellcheck="false"
            placeholder={defaultSlug(draft.protocol)}
            {disabled}
            bind:value={draft.slug}
            oninput={() => (draft.slugTouched = true)}
          />
          <p class="col-start-2 text-[11.5px] text-[var(--text-tertiary)]">{i18n.t('ai.slug_hint')}</p>

          <label for={`${uid}-url`} class="text-[12px] text-[var(--text-tertiary)]">{i18n.t('ai.base_url')}</label>
          <TextInput
            id={`${uid}-url`}
            class={FIELD}
            type="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://api.example.com"
            {disabled}
            bind:value={draft.baseUrl}
          />

          <label for={`${uid}-key`} class="text-[12px] text-[var(--text-tertiary)]">{i18n.t('ai.api_key')}</label>
          <div class="flex min-w-0 items-center gap-1">
            <TextInput
              id={`${uid}-key`}
              class={FIELD}
              type="password"
              autocomplete="off"
              spellcheck="false"
              {disabled}
              placeholder={draft.keyCleared
                ? i18n.t('ai.api_key_cleared')
                : draft.keyMasked
                  ? i18n.t('ai.api_key_kept', { masked: draft.keyMasked })
                  : i18n.t('ai.api_key_placeholder')}
              bind:value={draft.keyInput}
            />
            {#if draft.id && draft.keyMasked && !draft.keyCleared}
              {@const id = draft.id}
              <IconButton
                label={revealed === null ? i18n.t('ai.api_key_show') : i18n.t('ai.api_key_hide')}
                active={revealed !== null}
                disabled={disabled || pending}
                onclick={() => void toggleReveal(id)}
              >
                {#if revealed === null}<Eye size={14} />{:else}<EyeOff size={14} />{/if}
              </IconButton>
            {/if}
            {#if (draft.keyMasked || draft.keyInput) && !draft.keyCleared}<Button
                size="sm"
                variant="ghost"
                {disabled}
                onclick={clearKey}>{i18n.t('common.clear')}</Button
              >{/if}
          </div>
          {#if revealed !== null}<code
              class="col-start-2 rounded-[var(--r-sm)] bg-[var(--bg-inset)] px-2 py-1.5 font-mono text-[11.5px] break-all text-[var(--text-secondary)]"
              >{revealed}</code
            >{/if}
          {#if saved?.probeUrl}
            <span
              class="col-start-2 truncate font-mono text-[11.5px] text-[var(--text-tertiary)]"
              title={saved.probeUrl}
            >
              → GET {saved.probeUrl}
              {#if dirty}<span class="font-sans">{i18n.t('ai.probe_url_saved')}</span>{/if}
            </span>
          {/if}
        </div>
      </section>

      <section class="space-y-2">
        <div class="flex items-center gap-2">
          <h4 class="text-[12px] font-medium text-[var(--text-primary)]">{i18n.t('ai.models')}</h4>
          {#if draft.models.length > 0}<span
              class="rounded-[var(--r-sm)] border border-[var(--border-subtle)] px-1.5 text-[11px] text-[var(--success)]"
              >{i18n.t('ai.models_selected', { count: draft.models.length })}</span
            >{/if}
          <span class="flex-1"></span>
          {#if draft.id && !dirty}
            {@const id = draft.id}
            <Button size="sm" {disabled} loading={pending && pickerOpen} onclick={() => fetchModels(id)}
              ><ListPlus size={13} />{i18n.t('ai.fetch_models')}</Button
            >
          {:else}
            <Button size="sm" disabled title={i18n.t('ai.fetch_models_save_first')}
              ><ListPlus size={13} />{i18n.t('ai.fetch_models')}</Button
            >
          {/if}
          {#if canRemove}<IconButton label={i18n.t('ai.endpoint_remove')} {disabled} onclick={onRemove}
              ><Trash2 size={14} /></IconButton
            >{/if}
        </div>
        {#if probeError && !pickerOpen}<p role="alert" class="text-[11.5px] text-[var(--danger)]">
            {errorText(probeError)}
          </p>{/if}
        {#if failed}<p role="alert" class="text-[11.5px] text-[var(--danger)]">{i18n.t('common.action_failed')}</p>{/if}

        <ul class="max-h-40 space-y-0.5 overflow-y-auto pr-1">
          {#each draft.models as model (model.id)}
            <li class="flex items-center gap-2 rounded-[var(--r-sm)] py-0.5 pl-1 hover:bg-[var(--bg-hover)]">
              <span class="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]" title={model.id}
                >{model.id}</span
              >
              <Select
                class="h-7 w-[92px] text-[11px] md:h-7"
                aria-label={i18n.t('ai.model_type', { model: model.id })}
                {disabled}
                value={model.modelType}
                onchange={(event) => {
                  model.modelType = event.currentTarget.value as AiModelType
                  model.typeSource = 'user'
                }}
              >
                {#each MODEL_TYPES as type (type)}<option value={type}>{i18n.t(TYPE_LABELS[type])}</option>{/each}
              </Select>
              {#if model.canVision}<span class="shrink-0 text-[11px] text-[var(--text-tertiary)]"
                  >{i18n.t('ai.vision')}</span
                >{/if}
              <IconButton
                size="sm"
                label={i18n.t('ai.model_remove', { model: model.id })}
                {disabled}
                onclick={() => (draft.models = draft.models.filter((item) => item.id !== model.id))}
              >
                <Minus size={13} />
              </IconButton>
            </li>
          {:else}
            <li class="py-1 text-[12px] text-[var(--text-tertiary)]">{i18n.t('ai.models_empty')}</li>
          {/each}
        </ul>
      </section>
    </div>
  {/if}
</section>

{#if draft.id}
  {@const id = draft.id}
  <ModelPickerDialog
    bind:open={pickerOpen}
    models={probed}
    {picked}
    {pending}
    error={probeError ? errorText(probeError) : null}
    onAdd={(list) => draft.models.push(...list)}
    onRemove={(ids) => (draft.models = draft.models.filter((model) => !ids.includes(model.id)))}
    onRetry={() => void probe(id)}
  />
{/if}
