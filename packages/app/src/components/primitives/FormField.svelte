<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '@app/utils'

  let {
    label,
    for: controlId,
    hint,
    required = false,
    children,
    class: className,
  }: {
    label: string
    for: string
    hint?: string | undefined
    required?: boolean | undefined
    children: Snippet
    class?: string | undefined
  } = $props()
</script>

<div class={cn('flex flex-col gap-1.5', className)}>
  <label
    for={controlId}
    class="block text-[12px] font-medium text-[var(--text-secondary)]"
    >{label}{#if required}<span
        aria-hidden="true"
        class="ml-0.5 text-[var(--danger)]">*</span
      >{/if}</label
  >
  <div>{@render children()}</div>
  {#if hint}<p
      id={`${controlId}-hint`}
      class="text-[11.5px] leading-relaxed text-[var(--text-quaternary)]"
    >
      {hint}
    </p>{/if}
</div>
