<script lang="ts" generics="T extends string">
  import type { Component } from 'svelte'
  import { cn } from '@app/utils'

  interface Option {
    value: T
    label?: string
    title?: string
    icon?: Component<{ size?: number }>
  }

  let {
    value,
    options,
    onChange,
    label,
    size = 'md',
    class: className,
  }: {
    value: T
    options: Option[]
    onChange: (value: T) => void
    label: string
    size?: 'sm' | 'md' | undefined
    class?: string | undefined
  } = $props()
  let buttons: HTMLButtonElement[] = $state([])

  function keydown(event: KeyboardEvent, index: number): void {
    const last = options.length - 1
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? index === last
          ? 0
          : index + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? index === 0
            ? last
            : index - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    const option = next === null ? undefined : options[next]
    if (!option || next === null) return
    event.preventDefault()
    onChange(option.value)
    buttons[next]?.focus()
  }
</script>

<div
  role="radiogroup"
  aria-label={label}
  class={cn(
    'relative inline-flex items-center gap-0.5 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] p-[3px]',
    className,
  )}
>
  {#each options as option, index (option.value)}
    {@const active = option.value === value}
    <button
      bind:this={buttons[index]}
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={option.title}
      title={option.title}
      tabindex={active ||
      (!options.some((item) => item.value === value) && index === 0)
        ? 0
        : -1}
      onclick={() => onChange(option.value)}
      onkeydown={(event) => keydown(event, index)}
      class={cn(
        'relative z-10 inline-flex items-center justify-center gap-1.5 rounded-[var(--r-sm)] font-medium',
        'transition-[color,background-color] duration-[var(--dur-fast)] ease-[var(--ease-out)]',
        'disabled:pointer-events-none disabled:opacity-45',
        size === 'sm'
          ? 'h-8 px-2.5 text-[11.5px] md:h-[22px] md:px-2'
          : 'h-9 px-3 text-[12.5px] md:h-[26px] md:px-2.5',
        active
          ? 'bg-[var(--bg-surface)] text-[var(--text-primary)] shadow-[0_1px_2px_rgba(0,0,0,.10)]'
          : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]',
      )}
    >
      {#if option.icon}<option.icon size={12.5} />{/if}{option.label ?? ''}
    </button>
  {/each}
</div>
