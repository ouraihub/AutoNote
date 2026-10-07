<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '@app/utils'

  let { children, class: className }: { children: Snippet; class?: string } = $props()
</script>

<div
  class={cn(
    'px-2 pt-1 pb-1 text-[10.5px] font-semibold uppercase tracking-[0.075em] text-[var(--text-quaternary)]',
    className,
  )}
>
  {@render children()}
</div>
