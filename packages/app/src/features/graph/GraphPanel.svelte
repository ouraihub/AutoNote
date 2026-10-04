<script lang="ts">
  import type { Backend } from '../../backend'
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { NotesState } from '../../state/notes.svelte'
  import type { UiState } from '../../state/ui.svelte'
  import type { GraphNode, GraphQuery, GraphResponse } from '@shared/types'
  import * as Dialog from '../../components/ui/dialog'

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
      ctx.strokeStyle = color('--border-strong') || color('--text-tertiary')
      ctx.lineWidth = 1 / scale
      for (const { a, b } of edges) {
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      for (const point of points) {
        ctx.beginPath()
        ctx.arc(point.x, point.y, 5 + Math.min(8, Math.sqrt(point.degree) * 2), 0, Math.PI * 2)
        ctx.fillStyle = point.id === selectedId ? color('--accent') : color('--text-tertiary')
        if (point.kind === 'unresolved') {
          ctx.strokeStyle = ctx.fillStyle
          ctx.stroke()
        } else ctx.fill()
        ctx.fillStyle = color('--text-secondary')
        ctx.font = '11px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText(point.title.slice(0, 25), point.x, point.y + 22)
      }
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
  <Dialog.Root
    open
    onOpenChange={(open) => {
      if (!open) close()
    }}
  >
    <Dialog.Content class="flex h-[min(90vh,850px)] w-[min(95vw,1100px)] max-w-none flex-col" showCloseButton={false}>
      <Dialog.Title>{i18n.t('common.graph')}</Dialog.Title>
      <div class="flex flex-wrap items-center gap-2">
        <div role="group" aria-label={i18n.t('graph.scope')}>
          <button type="button" aria-pressed={mode === 'global'} onclick={() => (mode = 'global')}
            >{i18n.t('graph.global')}</button
          >
          <button
            type="button"
            class="ml-2"
            aria-pressed={mode === 'local'}
            disabled={!ui.activeNoteId}
            onclick={() => (mode = 'local')}>{i18n.t('graph.local')}</button
          >
        </div>
        <label>{i18n.t('graph.search_notes')} <input class="rounded border px-1" bind:value={query} /></label>
        <button type="button" onclick={close}>{i18n.t('common.close')}</button>
      </div>
      <details>
        <summary>{i18n.t('graph.filters')}</summary>
        <div class="flex flex-wrap gap-3 py-2">
          <label
            >{i18n.t('graph.folder')}
            <select bind:value={folderId}
              ><option value="">{i18n.t('graph.all_folders')}</option
              >{#each organize.folders as folder (folder.id)}<option value={folder.id}>{folder.name}</option
                >{/each}</select
            ></label
          >
          <label
            >{i18n.t('graph.tag')}
            <select bind:value={tag}
              ><option value="">{i18n.t('graph.all_tags')}</option>{#each organize.tags as item (item.id)}<option
                  value={item.name}>{item.name}</option
                >{/each}</select
            ></label
          >
          {#if mode === 'local'}<label
              >{i18n.t('graph.depth')}
              <select bind:value={depth}
                ><option value={1}>1</option><option value={2}>2</option><option value={3}>3</option></select
              ></label
            >{/if}
          <label><input type="checkbox" bind:checked={includeOrphans} /> {i18n.t('graph.show_orphans')}</label>
          <label><input type="checkbox" bind:checked={includeUnresolved} /> {i18n.t('graph.show_unresolved')}</label>
        </div>
      </details>
      {#if graph}<p>
          {graph.nodes.filter((node) => node.kind === 'note').length}{i18n.t('graph.notes')}{graph.edges.length}{i18n.t(
            'graph.links',
          )}{#if graph.meta.truncated}
            · <span role="status"
              >{i18n.t('graph.showing_limit', { shown: graph.nodes.length, total: graph.meta.totalNodes })}</span
            >{/if}
        </p>{/if}
      {#if error}<p role="alert">
          {i18n.t('graph.could_not_load_graph')}
          <button type="button" onclick={() => reload++}>{i18n.t('common.retry')}</button>
        </p>
      {:else if mode === 'local' && !ui.activeNoteId}<p>{i18n.t('graph.local_requires_note')}</p>
      {:else if !graph}<p role="status">{i18n.t('graph.building_graph')}</p>
      {:else if !graph.nodes.length}<p>{i18n.t('graph.nothing_to_graph_yet')}</p>
      {:else}
        <div class="min-h-0 flex-1">
          <canvas
            bind:this={canvas}
            class="h-full w-full touch-none cursor-grab"
            onpointerdown={pointerDown}
            onpointermove={pointerMove}
            onpointerup={pointerUp}
            onpointercancel={() => (dragging = null)}
          ></canvas>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <label
            >{i18n.t('graph.choose_a_note')}
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
              ><option value="">{i18n.t('graph.choose_a_note')}</option>{#each graph.nodes as node (node.id)}<option
                  value={node.id}
                  >{node.title}{node.kind === 'unresolved'
                    ? ` (${i18n.t('graph.unresolved_short').trim()})`
                    : ''}</option
                >{/each}</select
            ></label
          >
          <button
            type="button"
            disabled={!selected}
            onclick={() => {
              if (selected) void open(selected)
            }}>{selected?.kind === 'unresolved' ? i18n.t('graph.create_note') : i18n.t('graph.open_note')}</button
          >
          <button type="button" onclick={() => fit()}>{i18n.t('graph.fit')}</button>
          <button
            type="button"
            onclick={() => {
              scale = Math.max(0.2, scale - 0.2)
              redraw()
            }}>{i18n.t('common.zoom_out')}</button
          >
          <button
            type="button"
            onclick={() => {
              scale = Math.min(4, scale + 0.2)
              redraw()
            }}>{i18n.t('common.zoom_in')}</button
          >
        </div>
      {/if}
    </Dialog.Content>
  </Dialog.Root>
{/if}
