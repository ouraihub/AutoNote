<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '@app/utils'

  let {
    title,
    description,
    children,
    class: className,
  }: { title: string; description?: string | undefined; children: Snippet; class?: string | undefined } = $props()
</script>

<div
  class={cn(
    'setting-row flex flex-col items-stretch justify-between gap-2 border-b border-[var(--border-subtle)] py-3 last:border-b-0 md:flex-row md:items-center md:gap-6',
    className,
  )}
>
  <div class="min-w-0 flex-1">
    <div class="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
    {#if description}<div class="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-tertiary)]">{description}</div>{/if}
  </div>
  <div class="min-w-0 shrink-0">{@render children()}</div>
</div>
