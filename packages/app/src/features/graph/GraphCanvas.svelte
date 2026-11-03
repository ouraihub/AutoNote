<script lang="ts">
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { GraphNode, GraphResponse } from '@shared/types'

  interface GraphCanvasControls {
    redraw: () => void
    fit: () => void
    zoomOut: () => void
    zoomIn: () => void
  }

  interface Props {
    graph: GraphResponse
    selectedId: string
    activeNoteId: string | null
    i18n: Pick<I18nState, 't'>
    onOpen: (node: GraphNode) => void | Promise<void>
    onControls: (controls: GraphCanvasControls) => void
  }

  let { graph, selectedId, activeNoteId, i18n, onOpen, onControls }: Props =
    $props()
  let canvas = $state<HTMLCanvasElement>()
  let scale = 1
  let offsetX = 0
  let offsetY = 0
  let points: Array<
    GraphNode & { x: number; y: number; vx: number; vy: number }
  > = []
  let stopDrawing = () => {}
  let dragging: { x: number; y: number; moved: boolean } | null = null
  let redraw = () => {}
  let fit = () => {}

  // ponytail: quadratic repulsion is capped at the backend's 350 nodes;
  // use a spatial index if that ceiling rises.
  $effect(() => {
    const element = canvas
    if (!element || !graph.nodes.length) return
    const ctx = element.getContext('2d')
    if (!ctx) return
    const currentGraph = graph
    const byId: Record<
      string,
      GraphNode & { x: number; y: number; vx: number; vy: number }
    > = {}
    points = currentGraph.nodes.map((node, index) => {
      const angle = index * 2.399963
      const radius = Math.sqrt(index) * 18
      const point = {
        ...node,
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
        vx: 0,
        vy: 0,
      }
      byId[node.id] = point
      return point
    })
    const edges = currentGraph.edges.flatMap(({ source, target }) => {
      const a = byId[source],
        b = byId[target]
      return a && b ? [{ a, b }] : []
    })
    const reduced =
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
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
        const emphasized = point.id === selectedId || point.id === activeNoteId
        ctx.beginPath()
        ctx.arc(
          point.x,
          point.y,
          5 + Math.min(8, Math.sqrt(point.degree) * 2),
          0,
          Math.PI * 2,
        )
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
        ctx.fillStyle = emphasized
          ? accent
          : color('--text-secondary') || '#555'
        ctx.globalAlpha = emphasized ? 1 : selectedId ? 0.26 : 0.72
        ctx.fillText(
          point.title.length > 18
            ? `${point.title.slice(0, 18)}…`
            : point.title,
          point.x,
          point.y + 22,
        )
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
      const extent = points.reduce(
        (max, point) => Math.max(max, Math.abs(point.x), Math.abs(point.y)),
        40,
      )
      scale = Math.max(
        0.2,
        Math.min(2.5, Math.min(width, height) / (2 * extent + 80)),
      )
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
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    observer?.observe(element)
    onControls({
      redraw,
      fit,
      zoomOut: () => {
        scale = Math.max(0.2, scale - 0.2)
        redraw()
      },
      zoomIn: () => {
        scale = Math.min(4, scale + 0.2)
        redraw()
      },
    })
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

  function at(
    clientX: number,
    clientY: number,
  ): (typeof points)[number] | undefined {
    if (!canvas) return undefined
    const rect = canvas.getBoundingClientRect()
    const x = (clientX - rect.left - offsetX) / scale
    const y = (clientY - rect.top - offsetY) / scale
    return points.findLast((node) => Math.hypot(node.x - x, node.y - y) <= 13)
  }

  function pointerDown(event: PointerEvent): void {
    if (event.button !== 0) return
    if (event.currentTarget instanceof HTMLCanvasElement)
      event.currentTarget.setPointerCapture(event.pointerId)
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
      if (node) void onOpen(node)
    }
    dragging = null
  }

  function wheel(event: WheelEvent): void {
    if (!event.deltaY) return
    event.preventDefault()
    const rect = (
      event.currentTarget as HTMLCanvasElement
    ).getBoundingClientRect()
    const x = event.clientX - rect.left,
      y = event.clientY - rect.top
    const next = Math.max(
      0.2,
      Math.min(4, scale * (event.deltaY > 0 ? 0.92 : 1.08)),
    )
    offsetX = x - ((x - offsetX) * next) / scale
    offsetY = y - ((y - offsetY) * next) / scale
    scale = next
    redraw()
  }
</script>

<canvas
  bind:this={canvas}
  aria-label={i18n.t(
    'graph.graph_canvas_drag_to_pan_and_scroll_to_zoom_keyboard_\
users_can_open_note',
  )}
  class="size-full touch-none cursor-grab outline-none active:cursor-grabbing"
  onpointerdown={pointerDown}
  onpointermove={pointerMove}
  onpointerup={pointerUp}
  onpointercancel={() => (dragging = null)}
></canvas>
