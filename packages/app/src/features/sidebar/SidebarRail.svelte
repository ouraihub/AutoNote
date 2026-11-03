<script lang="ts">
  import type { Component } from 'svelte'
  import type { ViewKind } from '@shared/types'
  import { FilePlus2, FileText, PanelLeft, Star, Trash2 } from '@lucide/svelte'
  import { getI18n, getUi } from '@app/root/context'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import SearchButton from '@app/components/primitives/SearchButton.svelte'
  import SidebarAccount from './SidebarAccount.svelte'

  let {
    isDark,
    navigate,
    newNote,
  }: {
    isDark: boolean
    navigate: (view: ViewKind) => void
    newNote: (folderId: string | null) => Promise<void>
  } = $props()
  const ui = getUi(),
    i18n = getI18n()
</script>

{#snippet railButton(
  label: string,
  Icon: Component,
  active: boolean,
  onclick: () => void,
  accent = false,
)}
  <IconButton
    {label}
    title={label}
    {active}
    {onclick}
    class={accent ? 'text-[var(--accent)]' : undefined}
    ><Icon size={16} /></IconButton
  >
{/snippet}
<aside
  class="flex h-full min-h-0 flex-col items-center bg-[var(--bg-sunken)]"
  data-testid="sidebar"
>
  <div
    class={'flex h-11 w-full shrink-0 items-center justify-center ' +
      'border-b border-[var(--border-subtle)]'}
  >
    <IconButton
      label={i18n.t('sidebar.expand_navigation')}
      title={i18n.t('sidebar.expand_navigation')}
      onclick={() => ui.toggleNav()}><PanelLeft size={16} /></IconButton
    >
  </div>
  <div class="flex w-full flex-col items-center gap-1 py-2">
    <SearchButton variant="icon" />
    {@render railButton(
      i18n.t('navigation.all_notes'),
      FileText,
      ui.filter.view === 'all',
      () => navigate('all'),
    )}
    {@render railButton(
      i18n.t('navigation.favorites'),
      Star,
      ui.filter.view === 'starred',
      () => navigate('starred'),
    )}
    {@render railButton(
      i18n.t('navigation.trash'),
      Trash2,
      ui.filter.view === 'trash',
      () => navigate('trash'),
    )}
    <div class="my-1 h-px w-6 bg-[var(--border-subtle)]"></div>
    {@render railButton(
      i18n.t('common.new_note'),
      FilePlus2,
      false,
      () =>
        void newNote(ui.filter.view === 'folder' ? ui.filter.folderId : null),
      true,
    )}
  </div>
  <span class="flex-1"></span>
  <div
    class={'flex w-full shrink-0 justify-center border-t ' +
      'border-[var(--border-subtle)] py-2'}
  >
    <SidebarAccount rail {isDark} />
  </div>
</aside>
