<script lang="ts">
  import { getI18n, getUi } from '@app/root/context'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Logo from '@app/components/primitives/Logo.svelte'
  import {
    ArrowDownWideNarrow,
    PanelLeft,
    Plus,
    Search,
    X,
  } from '@lucide/svelte'
  import type { NoteSummary } from '@shared/types'
  import type { BatchAction } from './actions'

  let {
    layout,
    instanceId,
    title,
    filter = $bindable(''),
    busy,
    projection,
    create,
    batch,
  }: {
    layout: string
    instanceId: string
    title: string
    filter: string
    busy: boolean
    projection: readonly NoteSummary[]
    create: () => Promise<void>
    batch: BatchAction
  } = $props()
  const i18n = getI18n(),
    ui = getUi()
</script>

{#snippet sortMenu(iconSize: number, triggerClass = '')}
  <DropdownMenu.Root
    ><DropdownMenu.Trigger
      title={i18n.t('notes.sort_and_display')}
      aria-label={i18n.t('notes.sort_and_display')}
      class={[
        'inline-flex size-8 shrink-0 items-center justify-center ' +
          'rounded-[var(--r-md)] text-[var(--text-secondary)] ' +
          'transition-colors hover:bg-[var(--bg-hover)] ' +
          'hover:text-[var(--text-primary)] md:size-6',
        triggerClass,
      ]}><ArrowDownWideNarrow size={iconSize} /></DropdownMenu.Trigger
    ><DropdownMenu.Content
      ><DropdownMenu.Group>
        {#if ui.filter.view === 'recent' || ui.filter.view === 'trash'}
          <DropdownMenu.Item disabled
            >{i18n.t(
              ui.filter.view === 'trash'
                ? 'notes.recently_deleted_first'
                : 'notes.recently_edited_first',
            )}</DropdownMenu.Item
          >{:else}
          <DropdownMenu.Item onclick={() => ui.setSort('updated')}
            >{i18n.t('notes.modified')}</DropdownMenu.Item
          ><DropdownMenu.Item onclick={() => ui.setSort('created')}
            >{i18n.t('notes.created')}</DropdownMenu.Item
          ><DropdownMenu.Item onclick={() => ui.setSort('title', 'asc')}
            >{i18n.t('notes.title')}</DropdownMenu.Item
          ><DropdownMenu.Item
            onclick={() =>
              ui.setSort(ui.sort, ui.order === 'asc' ? 'desc' : 'asc')}
            >{i18n.t(
              ui.order === 'desc'
                ? 'notes.sort_ascending'
                : 'notes.sort_descending',
            )}</DropdownMenu.Item
          >
        {/if}
        <DropdownMenu.Item
          onclick={() =>
            ui.setDensity(
              ui.layout.density === 'compact' ? 'comfortable' : 'compact',
            )}
          >{i18n.t(
            ui.layout.density === 'compact'
              ? 'notes.comfortable_list'
              : 'notes.compact_list',
          )}</DropdownMenu.Item
        >
      </DropdownMenu.Group></DropdownMenu.Content
    ></DropdownMenu.Root
  >
{/snippet}

<header class="shrink-0 px-3 pt-3 pb-2">
  {#if layout === 'mobile'}
    <div class="mobile-library-brand">
      <Logo size={22} /><span>{i18n.t('common.product_name')}</span>
    </div>
  {:else}
    <div class="mb-2.5 flex items-center justify-between gap-2">
      <div class="min-w-0">
        <h2
          class={'truncate text-[14.5px] font-semibold ' +
            'tracking-[-0.016em] text-[var(--text-primary)]'}
        >
          {title}
        </h2>
        {#if ui.filter.view === 'folder'}<p
            class="mt-0.5 truncate text-[10.5px] text-[var(--text-quaternary)]"
          >
            {i18n.t('folders.includes_subfolders')}
          </p>{/if}
      </div>
      <div class="flex shrink-0 items-center gap-0.5">
        {#if layout === 'tablet'}<IconButton
            label={i18n.t('notes.open_navigation')}
            title={i18n.t('notes.open_navigation')}
            size="sm"
            onclick={() => ui.toggleNavDrawer(true)}
            ><PanelLeft size={14} /></IconButton
          >{/if}
        {@render sortMenu(14)}
        {#if ui.filter.view !== 'trash' && ui.filter.view !== 'archived'}
          <IconButton
            label={i18n.t('common.new_note')}
            title={i18n.t('common.new_note')}
            size="sm"
            disabled={busy}
            onclick={() => void create()}><Plus size={15} /></IconButton
          >{/if}
      </div>
    </div>
  {/if}
  {#if layout === 'mobile'}
    <div class="mobile-library-toolbar">
      <div class="mobile-note-search relative">
        <Search
          size={15}
          class={'pointer-events-none absolute top-1/2 left-3 ' +
            '-translate-y-1/2 text-[var(--text-quaternary)]'}
        />
        <input
          id={`${instanceId}-filter`}
          type="search"
          aria-label={i18n.t('notes.filter_in_this_view')}
          bind:value={filter}
          onkeydown={(event) => {
            if (event.key === 'Escape') filter = ''
          }}
          placeholder={i18n.t('notes.filter_in_this_view')}
          class={'h-10 w-full rounded-[var(--r-md)] border ' +
            'border-transparent bg-[var(--bg-inset)] pr-9 pl-8 ' +
            'text-[12.5px] text-[var(--text-primary)] ' +
            'transition-[border-color,box-shadow] ' +
            'duration-[var(--dur-fast)] ' +
            'placeholder:text-[var(--text-quaternary)] ' +
            'focus:border-[var(--accent)] ' +
            'focus:shadow-[0_0_0_3px_var(--accent-ring)] ' +
            'focus:outline-none md:h-[30px] md:pr-7 md:pl-7'}
        />
        {#if filter}<button
            type="button"
            onclick={() => (filter = '')}
            aria-label={i18n.t('notes.clear_filters')}
            class={'absolute top-1/2 right-1 flex size-8 -translate-y-1/2 ' +
              'items-center justify-center rounded ' +
              'text-[var(--text-quaternary)] ' +
              'hover:text-[var(--text-secondary)]'}><X size={12} /></button
          >{/if}
      </div>
      {@render sortMenu(17, 'mobile-library-sort')}
      {#if ui.filter.view !== 'trash' && ui.filter.view !== 'archived'}
        <IconButton
          label={i18n.t('common.new_note')}
          size="sm"
          class="mobile-library-compose"
          disabled={busy}
          onclick={() => void create()}><Plus size={19} /></IconButton
        >{/if}
    </div>
  {/if}
  {#if ui.filter.view === 'trash' && projection.length}<button
      type="button"
      disabled={busy}
      aria-busy={busy}
      onclick={() =>
        void batch(
          'purge',
          projection.map((note) => note.id),
        )}
      class={'mt-2 w-full rounded-[var(--r-md)] border ' +
        'border-[var(--border-subtle)] py-1.5 text-[11.5px] ' +
        'text-[var(--text-tertiary)] transition-colors ' +
        'hover:border-[var(--danger)] hover:text-[var(--danger)] ' +
        'disabled:pointer-events-none disabled:opacity-50'}
      >{i18n.t('common.empty_trash')} ({projection.length})</button
    >{/if}
</header>
