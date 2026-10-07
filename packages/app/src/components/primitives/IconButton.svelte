<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import { cn } from '@app/utils'
  import { BUTTON_VARIANTS as VARIANTS, type ButtonVariant as Variant } from './variants'

  interface Props extends HTMLButtonAttributes {
    label: string
    size?: 'sm' | 'md' | 'lg'
    variant?: Variant
    active?: boolean
    children: Snippet
  }

  let { label, size = 'md', variant = 'ghost', active, class: className, children, type = 'button', ...rest }: Props =
    $props()
</script>

<button
  {...rest}
  {type}
  aria-label={label}
  aria-pressed={active}
  class={cn(
    'inline-flex shrink-0 items-center justify-center rounded-[var(--r-md)]',
    'transition-[background-color,color,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
    'active:scale-[0.94] disabled:pointer-events-none disabled:opacity-40',
    size === 'sm' ? 'size-8 md:size-6' : size === 'lg' ? 'size-10 md:size-9' : 'size-9 md:size-7',
    active ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : VARIANTS[variant],
    className,
  )}
>
  {@render children()}
</button>
