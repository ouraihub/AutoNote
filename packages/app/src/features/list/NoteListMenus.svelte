<script lang="ts">
  import type { I18nState } from '@app/i18n/runtime.svelte'
  import type { UiState } from '@app/state/ui.svelte'
  import type { NotesState } from '@app/state/notes.svelte'
  import type { ViewKind } from '@shared/types'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import { ArrowDownWideNarrow } from '@lucide/svelte'

  interface Props {
    i18n: Pick<I18nState, 't'>
    ui: Pick<UiState, 'filter' | 'sort' | 'order' | 'layout' | 'setSort' | 'setDensity'>
    notes: Pick<NotesState, 'summaries'>
    busy: boolean
    batch: (action: string, ids: readonly string[]) => void
    move: (ids: readonly string[]) => void
  }
  let { i18n, ui, notes, busy, batch, move }: Props = $props()
</script>

{#snippet sortMenu(iconSize: number, triggerClass = '')}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      title={i18n.t('notes.sort_and_display')}
      aria-label={i18n.t('notes.sort_and_display')}
      class={[
        'inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-6',
        triggerClass,
      ]}><ArrowDownWideNarrow size={iconSize} /></DropdownMenu.Trigger>
    <DropdownMenu.Content>
      <DropdownMenu.Group>
        {#if ui.filter.view === 'recent' || ui.filter.view === 'trash'}
          <DropdownMenu.Item disabled>
            {i18n.t(
              ui.filter.view === 'trash'
                ? 'notes.recently_deleted_first'
                : 'notes.recently_edited_first',
            )}
          </DropdownMenu.Item>
        {:else}
          <DropdownMenu.Item onclick={() => ui.setSort('updated')}
            >{i18n.t('notes.modified')}</DropdownMenu.Item
          >
          <DropdownMenu.Item onclick={() => ui.setSort('created')}
            >{i18n.t('notes.created')}</DropdownMenu.Item
          >
          <DropdownMenu.Item onclick={() => ui.setSort('title', 'asc')}
            >{i18n.t('notes.title')}</DropdownMenu.Item
          >
          <DropdownMenu.Item
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
      </DropdownMenu.Group>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/snippet}

{#snippet actions(ids: readonly string[], inTrash: boolean)}
  <DropdownMenu.Group>
    {#if inTrash}
      <DropdownMenu.Item
        disabled={busy}
        onSelect={() => batch('restore', ids)}
        >{i18n.t('common.restore')}</DropdownMenu.Item
      >
      <DropdownMenu.Item
        variant="destructive"
        disabled={busy}
        onSelect={() => batch('purge', ids)}
        >{i18n.t('notes.delete_permanently')}</DropdownMenu.Item
      >
    {:else}
      <DropdownMenu.Item
        disabled={busy}
        onSelect={() =>
          batch(
            ids.every((id) => notes.summaries[id]?.isStarred)
              ? 'unstar'
              : 'star',
            ids,
          )}
        >{i18n.t(
          ids.every((id) => notes.summaries[id]?.isStarred)
            ? 'common.remove_from_favorites'
            : 'navigation.favorites',
        )}</DropdownMenu.Item
      >
      <DropdownMenu.Item
        disabled={busy}
        onSelect={() =>
          batch(
            ids.every((id) => notes.summaries[id]?.isPinned) ? 'unpin' : 'pin',
            ids,
          )}
        >{i18n.t(
          ids.every((id) => notes.summaries[id]?.isPinned)
            ? 'notes.unpin'
            : 'notes.pin',
        )}</DropdownMenu.Item
      >
      <DropdownMenu.Item disabled={busy} onSelect={() => move(ids)}
        >{i18n.t('notes.move_to_folder')}</DropdownMenu.Item
      >
      <DropdownMenu.Item
        disabled={busy}
        onSelect={() =>
          batch(
            ids.every((id) => notes.summaries[id]?.isArchived)
              ? 'unarchive'
              : 'archive',
            ids,
          )}
        >{i18n.t(
          ids.every((id) => notes.summaries[id]?.isArchived)
            ? 'common.unarchive'
            : 'navigation.archive',
        )}</DropdownMenu.Item
      >
      <DropdownMenu.Item disabled={busy} onSelect={() => batch('duplicate', ids)}
        >{i18n.t('notes.create_a_copy')}</DropdownMenu.Item
      >
      <DropdownMenu.Item
        variant="destructive"
        disabled={busy}
        onSelect={() => batch('trash', ids)}
        >{i18n.t('common.move_to_trash')}</DropdownMenu.Item
      >
    {/if}
  </DropdownMenu.Group>
{/snippet}
