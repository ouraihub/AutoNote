<script lang="ts" module>
  import type { MessageKey } from '@shared/locales/en-US'
  import type { AiModelType } from '../../ipc/ports/ai'

  export const TYPE_LABELS: Record<AiModelType, MessageKey> = {
    chat: 'ai.type_chat',
    image: 'ai.type_image',
    video: 'ai.type_video',
    tts: 'ai.type_tts',
    stt: 'ai.type_stt',
    embedding: 'ai.type_embedding',
    rerank: 'ai.type_rerank',
    unknown: 'ai.type_unknown',
  }
</script>

<script lang="ts">
  import { Minus, Plus } from '@lucide/svelte'
  import Modal from '@app/components/primitives/Modal.svelte'
  import Button from '@app/components/primitives/Button.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Select from '@app/components/primitives/Select.svelte'
  import TextInput from '@app/components/primitives/TextInput.svelte'
  import { getI18n } from '@app/root/context'
  import type { AiModel, AiProbeResult } from '../../ipc/ports/ai'

  let {
    open = $bindable(false),
    models,
    picked,
    pending,
    error,
    onAdd,
    onRemove,
    onRetry,
  }: {
    open: boolean
    models: AiProbeResult['models']
    picked: ReadonlySet<string>
    pending: boolean
    error: string | null
    onAdd: (models: AiModel[]) => void
    onRemove: (ids: string[]) => void
    onRetry: () => void
  } = $props()
  const uid = $props.id()
  const i18n = getI18n()
  const MODEL_TYPES = Object.keys(TYPE_LABELS) as AiModelType[]
  let type = $state<AiModelType | ''>('')
  let query = $state('')
  const shown = $derived(
    models.filter(
      (model) => (!type || model.modelType === type) && model.id.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  )
  const groups = $derived([...Map.groupBy(shown, (model) => model.group ?? 'other')])
  const add = (list: AiProbeResult['models']): void =>
    onAdd(
      list
        .filter((model) => !picked.has(model.id))
        .map(({ id, modelType, typeSource, contextWindow, canVision }) => ({
          id,
          modelType,
          typeSource,
          contextWindow,
          canVision,
        })),
    )
</script>

<!-- Modal (z-250), not the shadcn dialog (z-50): it must stack above the settings dialog (z-210). -->
<Modal {open} onClose={() => (open = false)} width={600} title={`${i18n.t('ai.picker_title')} · ${models.length}`}>
  <div class="space-y-3">
    {#if error}
      <div class="space-y-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-3">
        <p role="alert" class="text-[12px] text-[var(--danger)]">{error}</p>
        <Button size="sm" loading={pending} onclick={onRetry}>{i18n.t('common.retry')}</Button>
      </div>
    {:else}
      <div class="flex gap-2">
        <Select aria-label={i18n.t('ai.model_type_filter')} class="w-[140px]" bind:value={type}>
          <option value="">{i18n.t('ai.type_all')}</option>
          {#each MODEL_TYPES as item (item)}<option value={item}>{i18n.t(TYPE_LABELS[item])}</option>{/each}
        </Select>
        <TextInput
          class="flex-1"
          type="search"
          aria-label={i18n.t('ai.picker_search')}
          placeholder={i18n.t('ai.picker_search')}
          autocomplete="off"
          spellcheck="false"
          bind:value={query}
        />
        <Button size="md" disabled={shown.every((model) => picked.has(model.id))} onclick={() => add(shown)}
          >{i18n.t('ai.model_add_all')}</Button
        >
      </div>
      <div class="max-h-[50vh] space-y-3 overflow-y-auto pr-1" aria-busy={pending || undefined}>
        {#each groups as [group, items] (group)}
          <section aria-labelledby={`${uid}-${group}`}>
            <h4
              id={`${uid}-${group}`}
              class="mb-1 text-[11px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)] uppercase"
            >
              {group} <span class="tabular-nums">{items.length}</span>
            </h4>
            <ul>
              {#each items as model (model.id)}
                {@const added = picked.has(model.id)}
                <li class="flex items-center gap-2 rounded-[var(--r-sm)] py-0.5 pl-1 hover:bg-[var(--bg-hover)]">
                  <span
                    class="min-w-0 flex-1 truncate font-mono text-[12px] text-[var(--text-primary)]"
                    title={model.id}>{model.id}</span
                  >
                  <span class="shrink-0 text-[11px] text-[var(--text-tertiary)]"
                    >{i18n.t(TYPE_LABELS[model.modelType])}</span
                  >
                  {#if model.canVision}<span class="shrink-0 text-[11px] text-[var(--text-tertiary)]"
                      >{i18n.t('ai.vision')}</span
                    >{/if}
                  {#if added}<span class="shrink-0 text-[11px] text-[var(--success)]">{i18n.t('ai.model_added')}</span
                    >{/if}
                  <IconButton
                    size="sm"
                    label={i18n.t(added ? 'ai.model_remove' : 'ai.model_add', { model: model.id })}
                    onclick={() => (added ? onRemove([model.id]) : add([model]))}
                  >
                    {#if added}<Minus size={13} />{:else}<Plus size={13} />{/if}
                  </IconButton>
                </li>
              {/each}
            </ul>
          </section>
        {:else}
          <p class="py-6 text-center text-[12px] text-[var(--text-tertiary)]">
            {i18n.t(pending ? 'ai.picker_loading' : 'ai.picker_empty')}
          </p>
        {/each}
      </div>
    {/if}
  </div>
  {#snippet footer()}
    <Button size="sm" variant="primary" onclick={() => (open = false)}>{i18n.t('ai.picker_done')}</Button>
  {/snippet}
</Modal>
