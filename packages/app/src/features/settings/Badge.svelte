<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '@app/utils'

  const TONES = {
    neutral: 'bg-[var(--bg-raised)] text-[var(--text-tertiary)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)]',
    success: 'bg-[color-mix(in_oklab,var(--success)_15%,transparent)] text-[var(--success)]',
    warning: 'bg-[color-mix(in_oklab,var(--warning)_16%,transparent)] text-[var(--warning)]',
    danger: 'bg-[color-mix(in_oklab,var(--danger)_15%,transparent)] text-[var(--danger)]',
  }
  let {
    tone = 'neutral',
    class: className,
    children,
  }: { tone?: keyof typeof TONES; class?: string; children: Snippet } = $props()
</script>

<span
  class={cn('inline-flex items-center rounded-full px-[7px] py-[1px] text-[11px] font-medium tabular', TONES[tone], className)}
  >{@render children()}</span
>
