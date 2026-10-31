<script lang="ts">
  import { onDestroy } from 'svelte'
  import { cn } from '@app/utils'

  interface Props {
    label: string
    value: number
    min: number
    max: number
    onChange: (next: number) => void
    onReset?: () => void
    invert?: boolean
    class?: string
  }

  let {
    label,
    value,
    min,
    max,
    onChange,
    onReset,
    invert = false,
    class: className,
  }: Props = $props()
  let dragging = $state(false)
  let start = { x: 0, value: 0 }
  const clamp = (next: number) => Math.min(max, Math.max(min, next))

  function restoreDocument(): void {
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
  onDestroy(restoreDocument)

  function finish(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement
    dragging = false
    if (target.hasPointerCapture(event.pointerId))
      target.releasePointerCapture(event.pointerId)
    restoreDocument()
  }

  function keydown(event: KeyboardEvent): void {
    const next =
      event.key === 'ArrowLeft'
        ? value - 8
        : event.key === 'ArrowRight'
          ? value + 8
          : event.key === 'Home'
            ? min
            : event.key === 'End'
              ? max
              : null
    if (next === null) return
    event.preventDefault()
    onChange(clamp(next))
  }
</script>

<!-- A focusable separator with aria-valuenow is the WAI-ARIA window-splitter pattern, so it is interactive. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
  role="separator"
  aria-label={label}
  aria-orientation="vertical"
  aria-valuenow={Math.round(value)}
  aria-valuemin={Math.round(min)}
  aria-valuemax={Math.round(max)}
  tabindex="0"
  onpointerdown={(event) => {
    if (!event.isPrimary || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    start = { x: event.clientX, value }
    dragging = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }}
  onpointermove={(event) => {
    if (dragging)
      onChange(
        clamp(start.value + (event.clientX - start.x) * (invert ? -1 : 1)),
      )
  }}
  onpointerup={finish}
  onpointercancel={finish}
  onlostpointercapture={finish}
  onkeydown={keydown}
  ondblclick={() => onReset?.()}
  class={cn(
    'group relative z-10 -mx-[4px] w-[9px] shrink-0 cursor-col-resize touch-none outline-none',
    className,
  )}
>
  <span
    class={cn(
      'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2',
      'transition-[background-color,width] duration-[var(--dur-base)] ease-[var(--ease-out)]',
      dragging
        ? 'w-[2px] bg-[var(--accent)]'
        : 'bg-[var(--border-subtle)] group-hover:w-[2px] group-hover:bg-[var(--accent)] group-focus-visible:w-[2px] group-focus-visible:bg-[var(--accent)]',
    )}
  ></span>
</div>
