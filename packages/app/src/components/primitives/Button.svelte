<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import { cn } from '@app/utils'
  import { BUTTON_VARIANTS, type ButtonVariant } from './variants'

  const SIZES = {
    sm: 'h-9 px-3 text-[12px] gap-1.5 rounded-[var(--r-sm)] md:h-7 md:px-2.5',
    md: 'h-10 px-3.5 text-[13px] gap-1.5 rounded-[var(--r-md)] md:h-8 md:px-3',
    lg: 'h-11 px-4 text-[14px] gap-2 rounded-[var(--r-md)] md:h-10',
  }

  interface Props extends HTMLButtonAttributes {
    variant?: ButtonVariant
    size?: keyof typeof SIZES
    loading?: boolean
    block?: boolean
    children?: Snippet
  }

  let {
    variant = 'secondary',
    size = 'md',
    loading = false,
    block = false,
    disabled,
    class: className,
    type = 'button',
    children,
    ...rest
  }: Props = $props()
</script>

<button
  {...rest}
  {type}
  disabled={disabled || loading}
  aria-busy={loading || undefined}
  class={cn(
    'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap select-none',
    'transition-[background-color,border-color,color,box-shadow,transform] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
    'active:translate-y-px disabled:pointer-events-none disabled:opacity-45',
    BUTTON_VARIANTS[variant],
    SIZES[size],
    block && 'w-full',
    className,
  )}
>
  {#if loading}<svg
      width={size === 'lg' ? 15 : 13}
      height={size === 'lg' ? 15 : 13}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      class="shrink-0 animate-[ink-spin_0.7s_linear_infinite]"
      ><circle
        cx="12"
        cy="12"
        r="9"
        stroke="currentColor"
        stroke-width="2.5"
        opacity="0.2"
      /><path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      /></svg
    >{/if}
  {@render children?.()}
</button>
