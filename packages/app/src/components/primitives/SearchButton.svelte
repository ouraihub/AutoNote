<script lang="ts">
  import { Search } from '@lucide/svelte'
  import { getI18n, getUi } from '@app/root/context'
  import IconButton from './IconButton.svelte'
  import Kbd from './Kbd.svelte'

  let { variant = 'row' }: { variant?: 'row' | 'icon' | 'mobile' } = $props()
  const ui = getUi(),
    i18n = getI18n()
  const label = $derived(i18n.t('common.search_notes_or_run_a_command'))
  const open = () => ui.openPanel('command')
</script>

{#if variant === 'icon'}
  <IconButton {label} title={label} onclick={open}><Search size={16} /></IconButton>
{:else if variant === 'mobile'}
  <button
    type="button"
    aria-label={label}
    onclick={open}
    class="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-[var(--text-quaternary)] transition-colors active:bg-[var(--bg-active)]"
  >
    <Search size={19} />
    <span>{i18n.t('shell.search')}</span>
  </button>
{:else}
  <button
    type="button"
    aria-label={label}
    onclick={open}
    class="flex h-9 w-full min-w-0 shrink-0 items-center gap-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] bg-[var(--bg-inset)] px-2.5 text-[12px] text-[var(--text-tertiary)] transition-colors hover:border-[var(--border-default)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
  >
    <Search size={14} class="shrink-0" />
    <span class="min-w-0 flex-1 truncate text-left">{i18n.t('shell.search')}</span>
    <Kbd combo="mod+k" />
  </button>
{/if}
