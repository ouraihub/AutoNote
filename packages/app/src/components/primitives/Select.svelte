<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLSelectAttributes } from 'svelte/elements'
  import { cn } from '@app/utils'
  import { FIELD_BASE } from './variants'

  let {
    value = $bindable(),
    class: className,
    children,
    ...rest
  }: HTMLSelectAttributes & { children: Snippet } = $props()
</script>

<div class="relative">
  <select {...rest} bind:value class={cn(FIELD_BASE, 'h-11 cursor-pointer appearance-none pr-7 md:h-[34px]', className)}>
    {@render children()}
  </select>
  <svg
    viewBox="0 0 12 12"
    width="11"
    height="11"
    aria-hidden="true"
    class="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[var(--text-tertiary)]"
    ><path
      d="M2.5 4.5 6 8l3.5-3.5"
      fill="none"
      stroke="currentColor"
      stroke-width="1.4"
      stroke-linecap="round"
      stroke-linejoin="round"
    /></svg
  >
</div>
