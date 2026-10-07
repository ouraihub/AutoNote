<script lang="ts">
  import type { Snippet } from 'svelte'
  import { cn } from '@app/utils'

  export type EmptyArt = 'notes' | 'search' | 'trash' | 'starred' | 'archive' | 'folder' | 'select' | 'tag'

  let {
    art = 'notes',
    title,
    description,
    action,
    compact = false,
  }: {
    art?: EmptyArt | undefined
    title: string
    description?: string | undefined
    action?: Snippet | undefined
    compact?: boolean | undefined
  } = $props()
</script>

<div
  class={cn(
    'flex flex-col items-center justify-center px-8 text-center',
    compact ? 'py-10' : 'h-full min-h-[240px] py-16',
  )}
>
  <svg
    width="78"
    height="78"
    viewBox="0 0 64 64"
    fill="none"
    stroke="currentColor"
    stroke-width="1.25"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    class="text-[var(--text-quaternary)] [&>*]:animate-[ink-draw_900ms_var(--ease-out)_forwards] [&>*]:[stroke-dasharray:220] [&>*]:[stroke-dashoffset:220]"
  >
    {#if art === 'search'}
      <circle cx="28" cy="28" r="14" />
      <path d="M38.5 38.5 50 50" />
      <path d="M22 28h12M24 23h8" opacity="0.5" />
    {:else if art === 'trash'}
      <path d="M17 20h30l-2.5 27a4 4 0 0 1-4 3.6H23.5a4 4 0 0 1-4-3.6z" />
      <path d="M13 20h38M26 20v-4a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v4" />
      <path d="M27 29v13M37 29v13" opacity="0.5" />
    {:else if art === 'starred'}
      <path d="M32 13.5l5.6 11.7 12.4 1.8-9 9 2.1 12.7L32 42.7l-11.1 6 2.1-12.7-9-9 12.4-1.8z" />
    {:else if art === 'archive'}
      <rect x="12" y="16" width="40" height="10" rx="2.5" />
      <path d="M16 26v22a3 3 0 0 0 3 3h26a3 3 0 0 0 3-3V26" />
      <path d="M26 34h12" opacity="0.6" />
    {:else if art === 'folder'}
      <path d="M11 22a3 3 0 0 1 3-3h11l4.5 5H50a3 3 0 0 1 3 3v20a3 3 0 0 1-3 3H14a3 3 0 0 1-3-3z" />
      <path d="M11 30h42" opacity="0.5" />
    {:else if art === 'tag'}
      <path d="M31 12H16a4 4 0 0 0-4 4v15l21 21 19-19z" />
      <circle cx="23" cy="23" r="3.5" />
    {:else if art === 'select'}
      <rect x="12" y="13" width="26" height="38" rx="3" />
      <path d="M44 21h8v30a3 3 0 0 1-3 3H26" opacity="0.55" />
      <path d="M19 24h12M19 31h12M19 38h7" opacity="0.7" />
    {:else}
      <path d="M18 11h20l10 10v32a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V14a3 3 0 0 1 3-3z" />
      <path d="M38 11v10h10" />
      <path d="M23 32h18M23 40h13" opacity="0.65" />
    {/if}
  </svg>
  <p class="mt-4 text-[13.5px] font-medium text-[var(--text-secondary)]">{title}</p>
  {#if description}<p class="mt-1.5 max-w-[290px] text-[12px] leading-relaxed text-[var(--text-quaternary)]">
      {description}
    </p>{/if}
  {#if action}<div class="mt-4">{@render action()}</div>{/if}
</div>
