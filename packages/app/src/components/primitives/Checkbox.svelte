<script lang="ts">
  import { Check } from '@lucide/svelte'
  import { cn } from '@app/utils'

  let {
    checked,
    onChange,
    label,
    disabled = false,
    class: className,
  }: {
    checked: boolean
    onChange: (next: boolean) => void
    label?: string | undefined
    disabled?: boolean | undefined
    class?: string | undefined
  } = $props()
</script>

<button
  type="button"
  role="checkbox"
  aria-checked={checked}
  {disabled}
  onclick={() => onChange(!checked)}
  class={cn('inline-flex min-h-10 items-center gap-2 text-[13px] disabled:opacity-45 md:min-h-0', className)}
>
  <span
    class={cn(
      'inline-flex size-[15px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-[var(--dur-fast)]',
      checked
        ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]'
        : 'border-[var(--border-strong)] bg-[var(--bg-inset)]',
    )}
  >
    {#if checked}<Check size={11} strokeWidth={3} />{/if}
  </span>
  {#if label}<span class="text-[var(--text-secondary)]">{label}</span>{/if}
</button>
