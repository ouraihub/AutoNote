<script lang="ts">
  import { getI18n, getNotes } from '@app/root/context'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import type { NoteActionControls } from './actions'

  let {
    ids,
    inTrash,
    busy,
    batch,
    move,
  }: NoteActionControls & {
    ids: readonly string[]
    inTrash: boolean
    busy: boolean
  } = $props()
  const i18n = getI18n(),
    notes = getNotes()
</script>

<DropdownMenu.Group>
  {#if inTrash}
    <DropdownMenu.Item
      disabled={busy}
      onSelect={() => void batch('restore', ids)}
      >{i18n.t('common.restore')}</DropdownMenu.Item
    >
    <DropdownMenu.Item
      variant="destructive"
      disabled={busy}
      onSelect={() => void batch('purge', ids)}
      >{i18n.t('notes.delete_permanently')}</DropdownMenu.Item
    >
  {:else}
    <DropdownMenu.Item
      disabled={busy}
      onSelect={() =>
        void batch(
          ids.every((id) => notes.summaries[id]?.isStarred) ? 'unstar' : 'star',
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
        void batch(
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
        void batch(
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
    <DropdownMenu.Item
      disabled={busy}
      onSelect={() => void batch('duplicate', ids)}
      >{i18n.t('notes.create_a_copy')}</DropdownMenu.Item
    >
    <DropdownMenu.Item
      variant="destructive"
      disabled={busy}
      onSelect={() => void batch('trash', ids)}
      >{i18n.t('common.move_to_trash')}</DropdownMenu.Item
    >
  {/if}
</DropdownMenu.Group>
