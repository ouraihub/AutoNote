<script lang="ts">
  import { cn } from '@app/utils'

  let {
    checked,
    onChange,
    disabled = false,
    label,
    id,
  }: {
    checked: boolean
    onChange: (next: boolean) => void
    disabled?: boolean | undefined
    label?: string | undefined
    id?: string | undefined
  } = $props()
</script>

<button
  {id}
  type="button"
  role="switch"
  aria-checked={checked}
  aria-label={label}
  {disabled}
  onclick={() => onChange(!checked)}
  class={cn(
    'relative h-6 w-11 shrink-0 rounded-full transition-colors duration-[var(--dur-base)] ease-[var(--ease-out)] disabled:opacity-45 md:h-[20px] md:w-[34px]',
    checked ? 'bg-[var(--accent)]' : 'bg-[var(--border-strong)]',
  )}
>
  <span
    aria-hidden="true"
    class={cn(
      'absolute top-[2px] left-[2px] size-5 rounded-full bg-white shadow-sm transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)] md:size-[16px]',
      checked ? 'translate-x-5 md:translate-x-[14px]' : 'translate-x-0',
    )}
  ></span>
</button>
