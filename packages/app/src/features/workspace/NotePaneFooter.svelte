<script lang="ts">
  import type { NotesState } from '../../state/notes.svelte'
  import type { UiState } from '../../state/ui.svelte'
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { NoteSummary } from '@shared/types'
  import { Hash, FolderClosed } from '@lucide/svelte'
  import { organizerColorOrNull } from '@shared/organizer-colors'
  import { readingMinutes } from '@shared/markdown-utils'
  interface Props {
    noteId: string
    narrow: boolean
    source: string
    note: NoteSummary | undefined
    noteFolder: { id: string; name: string; color: string | null } | undefined
    folderLabel: string
    notes: Pick<NotesState, 'saveState' | 'dirtyById' | 'flush'>
    ui: Pick<UiState, 'openView'>
    i18n: Pick<I18nState, 't'>
  }
  let {
    noteId,
    pane,
    source,
    note,
    noteFolder,
    folderLabel,
    notes,
    ui,
    i18n,
  }: Props = $props()
</script>

<footer
  class="flex h-[var(--statusbar-h)] shrink-0 items-center gap-2 overflow-hidden border-t border-[var(--border-subtle)] px-3 text-[11px] text-[var(--text-quaternary)]"
>
  <span class="tabular">{note?.wordCount ?? 0}{i18n.t('common.words')}</span>
  <span class="tabular hidden sm:inline"
    >{source.length}{i18n.t('workspace.characters')}</span
  >
  <span class="tabular hidden md:inline">
    {i18n.t('common.about')}{readingMinutes(note?.wordCount ?? 0)}
    {i18n.t('common.min')}
  </span>
  {#if noteFolder}
    <button
      type="button"
      title={folderLabel}
      onclick={() => ui.openView('folder', { folderId: noteFolder.id })}
      class="inline-flex max-w-40 min-w-0 items-center gap-1 truncate rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)] md:max-w-48"
    >
      <FolderClosed
        size={11}
        class="shrink-0"
        style={`color: ${organizerColorOrNull(noteFolder.color) ?? 'inherit'}`}
      /><span class="truncate">{folderLabel}</span>
    </button>
  {/if}
  {#if note?.tags.length}
    <span class="flex min-w-0 items-center gap-0.5 overflow-hidden">
      {#each note.tags.slice(0, narrow ? 2 : 4) as tag (tag)}
        <button
          type="button"
          onclick={() => ui.openView('tag', { tag })}
          class="inline-flex min-w-0 items-center gap-0.5 rounded px-1 py-0.5 text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
        >
          <Hash size={9} class="shrink-0" /><span class="truncate">{tag}</span>
        </button>
      {/each}
    </span>
  {/if}
  <span class="flex-1"></span>
  <span
    role="status"
    data-save-state={notes.saveState[noteId] ?? 'idle'}
    class={notes.saveState[noteId] === 'failed'
      ? 'text-[var(--danger)]'
      : undefined}
  >
    {i18n.t(
      notes.saveState[noteId] === 'failed'
        ? 'common.save_failed'
        : notes.saveState[noteId] === 'persisting'
          ? 'shell.saving'
          : notes.saveState[noteId] === 'saved-local'
            ? 'shell.offline_changes_are_saved_locally'
            : notes.dirtyById[noteId]
              ? 'shell.unsaved_changes'
              : 'shell.synced',
    )}
  </span>
  {#if notes.saveState[noteId] === 'failed'}
    <button
      type="button"
      onclick={() => notes.flush(noteId)}
      class="rounded px-1 py-0.5 text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] hover:text-[var(--accent)]"
      >{i18n.t('common.retry')}</button
    >
  {/if}
</footer>
