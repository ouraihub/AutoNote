<script lang="ts">
  import type { Backend } from '../../backend'
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { NotesState } from '../../state/notes.svelte'
  import type { UiState } from '../../state/ui.svelte'
  import type { GraphNode, GraphQuery, GraphResponse } from '@shared/types'
  import { Dialog as DialogPrimitive } from 'bits-ui'
  import { Filter, Maximize2, Minus, Plus, Search, Settings2, X } from '@lucide/svelte'
  import DialogPortal from '../../components/ui/dialog/dialog-portal.svelte'
  import Button from '../../components/primitives/Button.svelte'
  import Empty from '../../components/primitives/Empty.svelte'
  import IconButton from '../../components/primitives/IconButton.svelte'

  interface Props {
    backend: { search: Pick<Backend['search'], 'graph'> }
    ui: Pick<UiState, 'activeNoteId' | 'activePane' | 'openNote'>
    notes: Pick<NotesState, 'open' | 'readOrganizeSnapshot'> & {
      create(body: { title: string }): Promise<{ id: string }>
    }
    i18n: Pick<I18nState, 't'>
    onClose: () => void
  }

  let { backend, ui, notes, i18n, onClose }: Props = $props()
  let mode = $state<'global' | 'local'>('global')
  let depth = $state(1)
  let query = $state('')
  let folderId = $state('')
  let tag = $state('')
  let includeOrphans = $state(true)
  let includeUnresolved = $state(true)
  let graph = $state<GraphResponse | null>(null)
  let error = $state(false)
  let reload = $state(0)
  let closed = $state(false)
  let settingsOpen = $state(false)
  let selectedId = $state('')
  let canvas = $state<HTMLCanvasElement>()
  let redraw = () => {}
  let fit = () => {}
  let scale = 1
  let offsetX = 0
  let offsetY = 0
  let points: Array<GraphNode & { x: number; y: number; vx: number; vy: number }> = []
  let stopDrawing = () => {}
  let stopRequest = () => {}
  let generation = 0
  const organize = $derived(notes.readOrganizeSnapshot())
  const selected = $derived(graph?.nodes.find((node) => node.id === selectedId))
  const selectClass =
    'h-8 max-w-[160px] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11.5px] outline-none focus:border-[var(--accent)]'
  const toggleClass = 'flex cursor-pointer items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]'

  function close(): void {
    if (closed) return
    stopRequest()
    stopDrawing()
    closed = true
    onClose()
  }

  $effect(() => {
    const center = mode === 'local' ? ui.activeNoteId : null
    const text = query.trim()
    const request: GraphQuery = {
      mode,
      ...(center ? { center } : {}),
      depth,
      ...(text ? { q: text } : {}),
      ...(folderId ? { folderId } : {}),
      ...(tag ? { tag } : {}),
      includeOrphans,
      includeUnresolved,
      limit: 350,
    }
    if (closed) return
    void reload
    const current = ++generation
    graph = null
    error = false
    selectedId = ''
    if (mode === 'local' && !center) return
    const controller = new AbortController()
    stopRequest = () => {
      controller.abort()
      generation++
    }
    void backend.search
      .graph(request, { signal: controller.signal })
      .then((response) => {
        if (current !== generation || controller.signal.aborted) return
        graph = response
      })
      .catch(() => {
        if (current === generation && !controller.signal.aborted) error = true
      })
    return () => {
      stopRequest()
      stopRequest = () => {}
    }
  })

  // ponytail: quadratic repulsion is capped at the backend's 350 nodes; use a spatial index if that ceiling rises.
  $effect(() => {
    if (closed || !canvas || !graph?.nodes.length) return
    const element = canvas
    const ctx = element.getContext('2d')
    if (!ctx) return
    const currentGraph = graph
    const byId: Record<string, GraphNode & { x: number; y: number; vx: number; vy: number }> = {}
    points = currentGraph.nodes.map((node, index) => {
      const angle = index * 2.399963
      const radius = Math.sqrt(index) * 18
      const point = { ...node, x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, vx: 0, vy: 0 }
      byId[node.id] = point
      return point
    })
    const edges = currentGraph.edges.flatMap(({ source, target }) => {
      const a = byId[source],
        b = byId[target]
      return a && b ? [{ a, b }] : []
    })
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let frame = reduced ? 180 : 0
    let raf = 0
    let alive = true
    const draw = () => {
      raf = 0
      if (!alive) return
      if (frame++ < 180) {
        for (let i = 0; i < points.length; i++) {
          const a = points[i]!
          for (let j = i + 1; j < points.length; j++) {
            const b = points[j]!
            const dx = b.x - a.x,
              dy = b.y - a.y
            const d2 = Math.max(1, dx * dx + dy * dy)
            if (d2 > 90000) continue
            const force = 700 / d2 / Math.sqrt(d2)
            a.vx -= dx * force
            a.vy -= dy * force
            b.vx += dx * force
            b.vy += dy * force
          }
          a.vx -= a.x * 0.002
          a.vy -= a.y * 0.002
        }
        for (const { a, b } of edges) {
          const dx = b.x - a.x,
            dy = b.y - a.y
          const length = Math.hypot(dx, dy) || 1
          const force = ((length - 76) * 0.008) / length
          a.vx += dx * force
          a.vy += dy * force
          b.vx -= dx * force
          b.vy -= dy * force
        }
        for (const point of points) {
          point.vx *= 0.86
          point.vy *= 0.86
          point.x += Math.max(-8, Math.min(8, point.vx))
          point.y += Math.max(-8, Math.min(8, point.vy))
        }
      }
      const { width, height } = element.getBoundingClientRect()
      const style = getComputedStyle(document.documentElement)
      const color = (name: string) => style.getPropertyValue(name).trim()
      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.translate(offsetX, offsetY)
      ctx.scale(scale, scale)
      const accent = color('--accent') || '#4f46e5'
      const edgeColor = color('--border-strong') || 'rgba(127,127,127,.35)'
      ctx.lineWidth = 1 / scale
      for (const { a, b } of edges) {
        const related = selectedId === a.id || selectedId === b.id
        ctx.strokeStyle = related ? accent : edgeColor
        ctx.globalAlpha = related ? 0.9 : selectedId ? 0.14 : 0.42
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      ctx.globalAlpha = 1
      for (const point of points) {
        const emphasized = point.id === selectedId || point.id === ui.activeNoteId
        ctx.beginPath()
        ctx.arc(point.x, point.y, 5 + Math.min(8, Math.sqrt(point.degree) * 2), 0, Math.PI * 2)
        ctx.fillStyle = emphasized ? accent : color('--text-tertiary') || '#777'
        ctx.globalAlpha = selectedId && !emphasized ? 0.34 : 1
        if (point.kind === 'unresolved') {
          ctx.strokeStyle = ctx.fillStyle
          ctx.lineWidth = 1.5 / scale
          ctx.stroke()
        } else ctx.fill()
      }
      ctx.font = `${11 / scale}px ${color('--font-ui')}`
      ctx.textAlign = 'center'
      for (const point of points) {
        const emphasized = point.id === selectedId
        ctx.fillStyle = emphasized ? accent : color('--text-secondary') || '#555'
        ctx.globalAlpha = emphasized ? 1 : selectedId ? 0.26 : 0.72
        ctx.fillText(point.title.length > 18 ? `${point.title.slice(0, 18)}…` : point.title, point.x, point.y + 22)
      }
      ctx.globalAlpha = 1
      ctx.restore()
      if (frame < 180) raf = requestAnimationFrame(draw)
    }
    redraw = () => {
      if (alive && !raf) raf = requestAnimationFrame(draw)
    }
    fit = () => {
      const { width, height } = element.getBoundingClientRect()
      const extent = points.reduce((max, point) => Math.max(max, Math.abs(point.x), Math.abs(point.y)), 40)
      scale = Math.max(0.2, Math.min(2.5, Math.min(width, height) / (2 * extent + 80)))
      offsetX = width / 2
      offsetY = height / 2
      redraw()
    }
    const resize = () => {
      const { width, height } = element.getBoundingClientRect()
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      element.width = Math.max(1, Math.round(width * dpr))
      element.height = Math.max(1, Math.round(height * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      fit()
    }
    element.addEventListener('wheel', wheel, { passive: false })
    resize()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(element)
    stopDrawing = () => {
      element.removeEventListener('wheel', wheel)
      alive = false
      cancelAnimationFrame(raf)
      observer?.disconnect()
      redraw = () => {}
      fit = () => {}
    }
    return () => {
      stopDrawing()
      stopDrawing = () => {}
    }
  })

  async function open(node: GraphNode): Promise<void> {
    try {
      const id = node.kind === 'unresolved' ? (await notes.create({ title: node.title })).id : node.id
      if (closed) return
      ui.openNote(id)
      await notes.open(id, ui.activePane)
      if (!closed) close()
    } catch {
      if (!closed) error = true
    }
  }

  function at(clientX: number, clientY: number): (typeof points)[number] | undefined {
    if (!canvas) return undefined
    const rect = canvas.getBoundingClientRect()
    const x = (clientX - rect.left - offsetX) / scale
    const y = (clientY - rect.top - offsetY) / scale
    return points.findLast((node) => Math.hypot(node.x - x, node.y - y) <= 13)
  }

  let dragging: { x: number; y: number; moved: boolean } | null = null
  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    if (event.currentTarget instanceof HTMLCanvasElement) event.currentTarget.setPointerCapture(event.pointerId)
    dragging = { x: event.clientX, y: event.clientY, moved: false }
  }
  function pointerMove(event: PointerEvent): void {
    if (!dragging) return
    const dx = event.clientX - dragging.x,
      dy = event.clientY - dragging.y
    if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true
    if (dragging.moved) {
      offsetX += dx
      offsetY += dy
      redraw()
    }
    dragging.x = event.clientX
    dragging.y = event.clientY
  }
  function pointerUp(event: PointerEvent): void {
    if (dragging && !dragging.moved) {
      const node = at(event.clientX, event.clientY)
      if (node) void open(node)
    }
    dragging = null
  }
  function wheel(event: WheelEvent): void {
    if (!event.deltaY) return
    event.preventDefault()
    const rect = (event.currentTarget as HTMLCanvasElement).getBoundingClientRect()
    const x = event.clientX - rect.left,
      y = event.clientY - rect.top
    const next = Math.max(0.2, Math.min(4, scale * (event.deltaY > 0 ? 0.92 : 1.08)))
    offsetX = x - ((x - offsetX) * next) / scale
    offsetY = y - ((y - offsetY) * next) / scale
    scale = next
    redraw()
  }
</script>

{#if !closed}
  <DialogPrimitive.Root
    open
    onOpenChange={(open) => {
      if (!open) close()
    }}
  >
    <DialogPortal>
      <DialogPrimitive.Content
        class="app-viewport-fixed fixed z-[230] flex flex-col bg-[var(--bg-base)] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-[var(--text-primary)] outline-none md:py-0"
      >
        <header
          class="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-subtle)] px-3 py-2 md:px-4"
        >
          <div class="mr-1 flex min-w-0 items-baseline gap-2.5">
            <DialogPrimitive.Title class="text-[14px] font-semibold tracking-[-0.014em]"
              >{i18n.t('common.graph')}</DialogPrimitive.Title
            >
            {#if graph}<span class="whitespace-nowrap text-[11.5px] text-[var(--text-quaternary)]"
                >{graph.nodes.filter((node) => node.kind === 'note').length}{i18n.t('graph.notes')}{graph.edges
                  .length}{i18n.t('graph.links')}{#if graph.nodes.some((node) => node.kind === 'unresolved')}{` · ${graph.nodes.filter((node) => node.kind === 'unresolved').length}${i18n.t('graph.unresolved_short')}`}{/if}</span
              >{/if}
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
              ]}>{i18n.t('graph.global')}</button
            >
            <button
              type="button"
              aria-pressed={mode === 'local'}
              disabled={!ui.activeNoteId}
              onclick={() => (mode = 'local')}
              class={[
                'h-7 rounded-[var(--r-sm)] px-2.5 text-[11.5px] disabled:opacity-40',
                mode === 'local'
                  ? 'bg-[var(--bg-overlay)] text-[var(--text-primary)] shadow-sm'
                  : 'text-[var(--text-tertiary)]',
              ]}>{i18n.t('graph.local')}</button
            >
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
            {#if query}<button type="button" aria-label={i18n.t('common.clear')} onclick={() => (query = '')}
                ><X size={12} /></button
              >{/if}
          </label>
          {#if graph?.nodes.length}
            <label class="flex h-8 items-center">
              <span class="sr-only">{i18n.t('graph.choose_a_note')}</span>
              <select
                bind:value={selectedId}
                onchange={() => redraw()}
                onkeydown={(event) => {
                  if (event.key === 'Enter') {
                    const node = graph?.nodes.find((item) => item.id === event.currentTarget.value)
                    if (node) {
                      event.preventDefault()
                      void open(node)
                    }
                  }
                }}
                class="h-8 max-w-[200px] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11.5px] outline-none focus:border-[var(--accent)]"
                ><option value="">{i18n.t('graph.choose_a_note')}</option>{#each graph.nodes as node (node.id)}<option
                    value={node.id}
                    >{node.title}{node.kind === 'unresolved'
                      ? ` (${i18n.t('graph.unresolved_short').trim()})`
                      : ''}</option
                  >{/each}</select
              >
            </label>
          {/if}
          <div class="ml-auto flex items-center gap-1">
            {#if selected}<Button size="sm" variant="secondary" onclick={() => void open(selected)}
                >{selected.kind === 'unresolved' ? i18n.t('graph.create_note') : i18n.t('graph.open_note')}</Button
              >{/if}
            <IconButton
              label={i18n.t('common.zoom_out')}
              title={i18n.t('common.zoom_out')}
              size="sm"
              disabled={!graph?.nodes.length}
              onclick={() => {
                scale = Math.max(0.2, scale - 0.2)
                redraw()
              }}><Minus size={14} /></IconButton
            >
            <IconButton
              label={i18n.t('graph.reset')}
              title={i18n.t('graph.fit')}
              size="sm"
              disabled={!graph?.nodes.length}
              onclick={() => fit()}><Maximize2 size={13} /></IconButton
            >
            <IconButton
              label={i18n.t('common.zoom_in')}
              title={i18n.t('common.zoom_in')}
              size="sm"
              disabled={!graph?.nodes.length}
              onclick={() => {
                scale = Math.min(4, scale + 0.2)
                redraw()
              }}><Plus size={14} /></IconButton
            >
            <IconButton
              label={i18n.t('graph.settings')}
              title={i18n.t('graph.settings')}
              size="sm"
              active={settingsOpen}
              onclick={() => (settingsOpen = !settingsOpen)}><Settings2 size={14} /></IconButton
            >
            <IconButton label={i18n.t('common.close')} title={i18n.t('common.close')} size="sm" onclick={close} class="ml-1"
              ><X size={16} /></IconButton
            >
          </div>
        </header>

        <div class="relative flex min-h-0 flex-1 overflow-hidden">
          <main class="relative min-w-0 flex-1">
            {#if error}
              <div role="alert" class="h-full">
                <Empty art="notes" title={i18n.t('graph.could_not_load_graph')}>
                  {#snippet action()}<Button size="sm" variant="secondary" onclick={() => reload++}
                      >{i18n.t('common.retry')}</Button
                    >{/snippet}
                </Empty>
              </div>
            {:else if mode === 'local' && !ui.activeNoteId}
              <Empty art="notes" title={i18n.t('graph.local_requires_note')} />
            {:else if !graph}
              <div
                role="status"
                aria-live="polite"
                class="flex h-full min-h-[160px] flex-col items-center justify-center gap-2.5 text-[var(--text-quaternary)]"
              >
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" class="animate-[ink-spin_.7s_linear_infinite]">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.4" opacity="0.2" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
                </svg>
                <span class="text-[12px]">{i18n.t('graph.building_graph')}</span>
              </div>
            {:else if !graph.nodes.length}
              <Empty
                art="notes"
                title={i18n.t('graph.nothing_to_graph_yet')}
                description={i18n.t('graph.connect_notes_with_wiki_links_and_their_graph_will_appear_here')}
              />
            {:else}
              <canvas
                bind:this={canvas}
                aria-label={i18n.t('graph.graph_canvas_drag_to_pan_and_scroll_to_zoom_keyboard_users_can_open_note')}
                class="size-full touch-none cursor-grab outline-none active:cursor-grabbing"
                onpointerdown={pointerDown}
                onpointermove={pointerMove}
                onpointerup={pointerUp}
                onpointercancel={() => (dragging = null)}
              ></canvas>
              {#if graph.meta.truncated}<div
                  role="status"
                  class="absolute top-3 left-1/2 -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3 py-1 text-[11px] text-[var(--text-secondary)] shadow-sm"
                >
                  {i18n.t('graph.showing_limit', { shown: graph.nodes.length, total: graph.meta.totalNodes })}
                </div>{/if}
              {#if selected}<div
                  class="pointer-events-none absolute bottom-4 left-1/2 max-w-[80vw] -translate-x-1/2 rounded-full border border-[var(--border-default)] bg-[var(--bg-overlay)] px-3.5 py-1.5 text-[12px] shadow-[var(--shadow-pop)]"
                >
                  <span class="max-w-[50vw] truncate">{selected.title || i18n.t('common.untitled_note')}</span>
                  <span class="ml-2 text-[var(--text-quaternary)]"
                    >{i18n.t('graph.direction_counts', { incoming: selected.inDegree, outgoing: selected.outDegree })}</span
                  >
                </div>{/if}
              <div class="pointer-events-none absolute top-3 left-4 hidden text-[11px] text-[var(--text-quaternary)] md:block">
                {i18n.t('graph.interaction_hint')}
              </div>
            {/if}
          </main>

          {#if settingsOpen}<aside
              aria-label={i18n.t('graph.settings')}
              class="absolute inset-y-0 right-0 z-10 w-[min(88vw,300px)] overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 shadow-[-8px_0_24px_rgba(0,0,0,.06)] md:static md:shadow-none"
            >
              <div class="mb-4 flex items-center justify-between">
                <h3 class="text-[13px] font-semibold">{i18n.t('graph.settings')}</h3>
              </div>
              <section class="mb-5">
                <h4
                  class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-quaternary)]"
                >
                  <Filter size={13} />{i18n.t('graph.filters')}
                </h4>
                <div class="space-y-2.5">
                  <label class="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]"
                    ><span>{i18n.t('graph.folder')}</span><select bind:value={folderId} class={selectClass}
                      ><option value="">{i18n.t('graph.all_folders')}</option>{#each organize.folders as folder (folder.id)}<option
                          value={folder.id}>{folder.name}</option
                        >{/each}</select
                    ></label
                  >
                  <label class="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]"
                    ><span>{i18n.t('graph.tag')}</span><select bind:value={tag} class={selectClass}
                      ><option value="">{i18n.t('graph.all_tags')}</option>{#each organize.tags as item (item.id)}<option
                          value={item.name}>{item.name}</option
                        >{/each}</select
                    ></label
                  >
                  <label class={toggleClass}
                    ><span>{i18n.t('graph.show_orphans')}</span><input
                      type="checkbox"
                      bind:checked={includeOrphans}
                      class="size-4 accent-[var(--accent)]"
                    /></label
                  >
                  <label class={toggleClass}
                    ><span>{i18n.t('graph.show_unresolved')}</span><input
                      type="checkbox"
                      bind:checked={includeUnresolved}
                      class="size-4 accent-[var(--accent)]"
                    /></label
                  >
                  {#if mode === 'local'}<label
                      class="flex items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]"
                      ><span>{i18n.t('graph.depth')}</span><select bind:value={depth} class={selectClass}
                        ><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select
                      ></label
                    >{/if}
                </div>
              </section>
            </aside>{/if}
        </div>
      </DialogPrimitive.Content>
    </DialogPortal>
  </DialogPrimitive.Root>
{/if}
