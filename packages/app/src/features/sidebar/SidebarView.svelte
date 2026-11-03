<script lang="ts">
  import type { Component } from 'svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { ViewKind } from '@shared/types'
  import { getI18n, getUi } from '@app/root/context'

  let {
    item,
    count = 0,
    navigate,
    rootDrop,
  }: {
    item: { view: ViewKind; key: MessageKey; icon: Component }
    count?: number
    navigate: (view: ViewKind) => void
    rootDrop: (event: DragEvent) => Promise<void>
  } = $props()
  const ui = getUi(),
    i18n = getI18n()
  const active = $derived(ui.filter.view === item.view)
</script>

<button
  type="button"
  aria-current={active ? 'page' : undefined}
  ondragover={(event) => {
    if (item.view === 'unfiled') event.preventDefault()
  }}
  ondrop={(event) => {
    if (item.view === 'unfiled') void rootDrop(event)
  }}
  onclick={() => navigate(item.view)}
  class={[
    'group relative flex h-10 w-full items-center gap-2.5 ' +
      'rounded-[var(--r-md)] px-2 text-left md:h-[30px]',
    'transition-colors duration-[var(--dur-fast)]',
    active
      ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
      : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] ' +
        'hover:text-[var(--text-primary)]',
  ]}
>
  <span
    class={[
      'shrink-0',
      active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]',
    ]}><item.icon size={14} /></span
  >
  <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium"
    >{i18n.t(item.key as MessageKey)}</span
  >
  {#if count > 0}<span
      class="tabular shrink-0 text-[11px] text-[var(--text-quaternary)]"
      >{count}</span
    >{/if}
</button>
