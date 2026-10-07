<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLInputAttributes } from 'svelte/elements'
  import { cn } from '@app/utils'
  import { FIELD_BASE } from './variants'

  let {
    value = $bindable(),
    ref = $bindable(),
    invalid = false,
    leading,
    trailing,
    class: className,
    ...rest
  }: HTMLInputAttributes & {
    ref?: HTMLInputElement | undefined
    invalid?: boolean
    leading?: Snippet
    trailing?: Snippet
  } = $props()
</script>

{#if leading || trailing}
  <div class="relative flex items-center">
    {#if leading}<span class="pointer-events-none absolute left-2.5 text-[var(--text-quaternary)]"
        >{@render leading()}</span
      >{/if}
    <input
      {...rest}
      bind:this={ref}
      bind:value
      aria-invalid={invalid || rest['aria-invalid'] || undefined}
      class={cn(
        FIELD_BASE,
        'h-11 md:h-[34px]',
        leading && 'pl-8',
        trailing && 'pr-8',
        invalid && 'border-[var(--danger)]',
        className,
      )}
    />
    {#if trailing}<span class="absolute right-2.5 flex items-center">{@render trailing()}</span>{/if}
  </div>
{:else}
  <input
    {...rest}
    bind:this={ref}
    bind:value
    aria-invalid={invalid || rest['aria-invalid'] || undefined}
    class={cn(FIELD_BASE, 'h-11 md:h-[34px]', invalid && 'border-[var(--danger)]', className)}
  />
{/if}
