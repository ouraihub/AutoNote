<script lang="ts">
  import { cn } from '@app/utils'

  let {
    value,
    min,
    max,
    step = 1,
    onChange,
    suffix = '',
    label,
    id,
    class: className,
  }: {
    value: number
    min: number
    max: number
    step?: number | undefined
    onChange: (value: number) => void
    suffix?: string | undefined
    label?: string | undefined
    id?: string | undefined
    class?: string | undefined
  } = $props()
  const pct = $derived(
    max - min > 0 && Number.isFinite(value) ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0,
  )
</script>

<div class={cn('flex items-center gap-3', className)}>
  <input
    {id}
    type="range"
    aria-label={label}
    aria-valuetext={`${value}${suffix}`}
    {min}
    {max}
    {step}
    {value}
    oninput={(event) => onChange(Number(event.currentTarget.value))}
    class="ink-slider h-[18px] flex-1 cursor-pointer appearance-none bg-transparent"
    style:--pct={`${pct}%`}
  />
  <span class="tabular w-11 shrink-0 text-right text-[12px] text-[var(--text-tertiary)]">{value}{suffix}</span>
</div>
