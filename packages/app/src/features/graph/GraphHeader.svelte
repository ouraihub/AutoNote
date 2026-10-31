<script lang="ts">
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { GraphNode, GraphResponse } from '@shared/types'
  import {
    Maximize2,
    Minus,
    Plus,
    Search,
    Settings2,
    X,
  } from '@lucide/svelte'
  import { Dialog as DialogPrimitive } from 'bits-ui'
  import Button from '../../components/primitives/Button.svelte'
  import IconButton from '../../components/primitives/IconButton.svelte'

  interface Props {
    i18n: Pick<I18nState, 't'>
    graph: GraphResponse | null
    activeNoteId: string | null
    selected: GraphNode | undefined
    mode: 'global' | 'local'
    query: string
    selectedId: string
    settingsOpen: boolean
    scale: number
    onOpen: (node: GraphNode) => void
    onFit: () => void
    onRedraw: () => void
    onClose: () => void
  }

  let {
    i18n,
    graph,
    activeNoteId,
    selected,
    mode = $bindable(),
    query = $bindable(),
    selectedId = $bindable(),
    settingsOpen = $bindable(),
    scale = $bindable(),
    onOpen,
    onFit,
    onRedraw,
    onClose,
  }: Props = $props()
</script>

<header
  class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:px-4"
>
  <div class="mr-1 flex min-w-0 items-baseline gap-2.5">
    <DialogPrimitive.Title class="text-[14px] font-semibold tracking-[-0.014em]">
      {i18n.t('common.graph')}
    </DialogPrimitive.Title>
    {#if graph}
      <span class="whitespace-nowrap text-[11.5px] text-[var(--text-quaternary)]">
        {graph.nodes.filter((node) => node.kind === 'note').length}
        {i18n.t('graph.notes')}{graph.edges.length}{i18n.t('graph.links')}
        {#if graph.nodes.some((node) => node.kind === 'unresolved')}
          {` · ${graph.nodes.filter((node) => node.kind === 'unresolved').length}${i18n.t('graph.unresolved_short')}`}
        {/if}
      </span>
    {/if}
  </div>
  <div
    class="flex h-8 items-center rounded-[var(--r-md)] bg-[var(--bg-inset)] p-0.5"
    role="group"
    aria-label={i18n.t('graph.scope')}
  >
    <button
      type="button"
      aria-pressed={mode === 'global'}
      onclick={() => (mode = 'global')}
      class={[
        'h-7 rounded-[var(--r-sm)] px-2.5 text-[11.5px]',
        mode === 'global'
          ? 'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-sm'
          : 'text-[var(--text-tertiary)]',
      ]}
    >{i18n.t('graph.global')}</button>
    <button
      type="button"
      aria-pressed={mode === 'local'}
      disabled={!activeNoteId}
      onclick={() => (mode = 'local')}
      class={[
        'h-7 rounded-[var(--r-sm)] px-2.5 text-[11.5px] disabled:opacity-40',
        mode === 'local'
          ? 'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-sm'
          : 'text-[var(--text-tertiary)]',
      ]}
    >{i18n.t('graph.local')}</button>
  </div>
  <label
    class="flex h-8 min-w-[150px] flex-1 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2.5 md:max-w-[320px]"
  >
    <Search size={13} class="shrink-0 text-[var(--text-quaternary)]" />
    <span class="sr-only">{i18n.t('graph.search_notes')}</span>
    <input
      bind:value={query}
      placeholder={i18n.t('graph.search_notes')}
      class="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-[var(--text-quaternary)]"
    />
    {#if query}
      <button
        type="button"
        aria-label={i18n.t('common.clear')}
        onclick={() => (query = '')}><X size={12} /></button
      >
    {/if}
  </label>
  {#if graph?.nodes.length}
    <label class="flex h-8 items-center">
      <span class="sr-only">{i18n.t('graph.choose_a_note')}</span>
      <select
        bind:value={selectedId}
        onchange={onRedraw}
        onkeydown={(event) => {
          if (event.key === 'Enter') {
            const node = graph?.nodes.find(
              (item) => item.id === event.currentTarget.value,
            )
            if (node) {
              event.preventDefault()
              onOpen(node)
            }
          }
        }}
        class="h-8 max-w-[200px] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11.5px] outline-none focus:border-[var(--accent)]"
      >
        <option value="">{i18n.t('graph.choose_a_note')}</option>
        {#each graph.nodes as node (node.id)}
          <option value={node.id}>
            {node.title}{node.kind === 'unresolved'
              ? ` (${i18n.t('graph.unresolved_short').trim()})`
              : ''}
          </option>
        {/each}
      </select>
    </label>
  {/if}
  <div class="ml-auto flex items-center gap-1">
    {#if selected}
      <Button size="sm" variant="secondary" onclick={() => onOpen(selected)}>
        {selected.kind === 'unresolved'
          ? i18n.t('graph.create_note')
          : i18n.t('graph.open_note')}
      </Button>
    {/if}
    <IconButton
      label={i18n.t('common.zoom_out')}
      title={i18n.t('common.zoom_out')}
      size="sm"
      disabled={!graph?.nodes.length}
      onclick={() => {
        scale = Math.max(0.2, scale - 0.2)
        onRedraw()
      }}><Minus size={14} /></IconButton
    >
    <IconButton
      label={i18n.t('graph.reset')}
      title={i18n.t('graph.fit')}
      size="sm"
      disabled={!graph?.nodes.length}
      onclick={onFit}><Maximize2 size={13} /></IconButton
    >
    <IconButton
      label={i18n.t('common.zoom_in')}
      title={i18n.t('common.zoom_in')}
      size="sm"
      disabled={!graph?.nodes.length}
      onclick={() => {
        scale = Math.min(4, scale + 0.2)
        onRedraw()
      }}><Plus size={14} /></IconButton
    >
    <IconButton
      label={i18n.t('graph.settings')}
      title={i18n.t('graph.settings')}
      size="sm"
      active={settingsOpen}
      onclick={() => (settingsOpen = !settingsOpen)}
      ><Settings2 size={14} /></IconButton
    >
    <IconButton
      label={i18n.t('common.close')}
      title={i18n.t('common.close')}
      size="sm"
      onclick={onClose}
      class="ml-1"><X size={16} /></IconButton
    >
  </div>
</header>
