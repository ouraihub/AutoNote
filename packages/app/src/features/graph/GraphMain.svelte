<script lang="ts">
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { GraphNode, GraphResponse } from '@shared/types'
  import Button from '../../components/primitives/Button.svelte'
  import Empty from '../../components/primitives/Empty.svelte'

  interface Props {
    error: boolean
    mode: 'global' | 'local'
    activeNoteId: string | null
    graph: GraphResponse | null
    i18n: Pick<I18nState, 't'>
    canvas: HTMLCanvasElement | undefined
    selected: GraphNode | undefined
    reload: () => void
    pointerDown: (event: PointerEvent) => void
    pointerMove: (event: PointerEvent) => void
    pointerUp: (event: PointerEvent) => void
    clearDrag: () => void
  }

  let {
    error,
    mode,
    activeNoteId,
    graph,
    i18n,
    canvas = $bindable(),
    selected,
    reload,
    pointerDown,
    pointerMove,
    pointerUp,
    clearDrag,
  }: Props = $props()
</script>

<main class="relative min-w-0 flex-1">
  {#if error}
    <div role="alert" class="h-full">
      <Empty art="notes" title={i18n.t('graph.could_not_load_graph')}>
        {#snippet action()}
          <Button size="sm" variant="secondary" onclick={reload}>
            {i18n.t('common.retry')}
          </Button>
        {/snippet}
      </Empty>
    </div>
  {:else if mode === 'local' && !activeNoteId}
    <Empty art="notes" title={i18n.t('graph.local_requires_note')} />
  {:else if !graph}
    <div
      role="status"
      aria-live="polite"
      class="flex h-full min-h-[160px] flex-col items-center justify-center gap-2.5 text-[var(--text-quaternary)]"
    >
      <svg
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        class="animate-[ink-spin_.7s_linear_infinite]"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          stroke-width="2.4"
          opacity="0.2"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          stroke-width="2.4"
          stroke-linecap="round"
        />
      </svg>
      <span class="text-[12px]">{i18n.t('graph.building_graph')}</span>
    </div>
  {:else if !graph.nodes.length}
    <Empty
      art="notes"
      title={i18n.t('graph.nothing_to_graph_yet')}
      description={i18n.t(
        'graph.connect_notes_with_wiki_links_and_their_graph_will_appear_here',
      )}
    />
  {:else}
    <canvas
      bind:this={canvas}
      aria-label={i18n.t(
        'graph.graph_canvas_drag_to_pan_and_scroll_to_zoom_keyboard_users_can_open_note',
      )}
      class="size-full touch-none cursor-grab outline-none active:cursor-grabbing"
      onpointerdown={pointerDown}
      onpointermove={pointerMove}
      onpointerup={pointerUp}
      onpointercancel={clearDrag}
    ></canvas>
    {#if graph.meta.truncated}
      <div
        role="status"
        class="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1 text-[11px] text-[var(--text-secondary)] shadow-sm"
      >
        {i18n.t('graph.showing_limit', {
          shown: graph.nodes.length,
          total: graph.meta.totalNodes,
        })}
      </div>
    {/if}
    {#if selected}
      <div
        class="pointer-events-none absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3.5 py-1.5 text-[12px] shadow-[var(--shadow-pop)]"
      >
        <span class="max-w-[50vw] truncate">
          {selected.title || i18n.t('common.untitled_note')}
        </span>
        <span class="ml-2 text-[var(--text-quaternary)]">
          {i18n.t('graph.direction_counts', {
            incoming: selected.inDegree,
            outgoing: selected.outDegree,
          })}
        </span>
      </div>
    {/if}
    <div
      class="pointer-events-none absolute top-3 left-4 hidden text-[11px] text-[var(--text-quaternary)] md:block"
    >
      {i18n.t('graph.interaction_hint')}
    </div>
  {/if}
</main>
