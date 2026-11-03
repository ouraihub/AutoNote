<script lang="ts">
  import type { PatchNoteBody } from '@shared/types'
  import { logFailure } from '@app/log/logger'
  import { AppError, errorMessageKey } from '@app/i18n/errors'
  import { folderPath } from '@app/state/selectors'
  import {
    getI18n,
    getLogger,
    getNotes,
    getNotifier,
    getUi,
  } from '@app/root/context'
  import { Button } from '@app/components/ui/button'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import * as Field from '@app/components/ui/field'
  import * as Dialog from '@app/components/ui/dialog'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import { MoreHorizontal, X } from '@lucide/svelte'
  import NoteActionItems from './NoteActionItems.svelte'
  import { runNoteBatch, type BatchResult, type NoteAction } from './actions'

  let {
    instanceId,
    selected,
    busy = $bindable(false),
    onError,
    onChange,
    focusList,
  }: {
    instanceId: string
    selected: readonly string[]
    busy: boolean
    onError: (message: string) => void
    onChange: () => void
    focusList: () => void
  } = $props()
  const notes = getNotes(),
    ui = getUi(),
    notifier = getNotifier(),
    i18n = getI18n(),
    logger = getLogger()
  const snapshot = $derived(notes.readOrganizeSnapshot())
  let results = $state.raw<BatchResult[]>([])
  let resultTitles = $state.raw<Record<string, string>>({})
  const failures = $derived(results.filter((result) => result.error !== null))
  let moveOpen = $state(false)
  let moveIds: readonly string[] = []
  let destination = $state('')

  $effect(() => {
    void ui.filter
    results = []
  })
  function errorText(error: unknown): string {
    return i18n.t(errorMessageKey(error))
  }
  export async function batch(
    action: NoteAction,
    ids: readonly string[],
    folderId: string | null = null,
  ): Promise<void> {
    if (busy || !ids.length) return
    busy = true
    results = []
    const titles = Object.fromEntries(
      ids.map((id) => [
        id,
        notes.summaries[id]?.title || i18n.t('common.untitled_note'),
      ]),
    )
    try {
      const outcome = await runNoteBatch(
        ids,
        () =>
          action === 'trash' || action === 'purge'
            ? notifier.confirm({
                titleKey:
                  action === 'trash'
                    ? 'common.move_to_trash'
                    : 'notes.delete_permanently',
                bodyKey:
                  action === 'trash'
                    ? 'notes.restore_it_from_trash_at_any_time'
                    : 'notes.this_operation_cannot_be_undone',
                danger: true,
              })
            : Promise.resolve(true),
        (id) => notes.flush(id),
        async (id) => {
          const note = notes.summaries[id]
          if (!note) throw new AppError('notes.this_note_no_longer_exists')
          if (action === 'trash') {
            await notes.remove(id)
            ui.forgetNote(id)
          } else if (action === 'purge') {
            await notes.purge(id)
            ui.forgetNote(id)
          } else if (action === 'restore') await notes.restore(id)
          else if (action === 'duplicate') await notes.duplicate(id)
          else {
            const patch: PatchNoteBody = { rev: note.rev }
            if (action === 'star' || action === 'unstar')
              patch.isStarred = action === 'star'
            if (action === 'pin' || action === 'unpin')
              patch.isPinned = action === 'pin'
            if (action === 'archive' || action === 'unarchive')
              patch.isArchived = action === 'archive'
            if (action === 'move') patch.folderId = folderId
            await notes.patch(id, patch)
          }
        },
        'common.changes_not_saved',
      )
      if (outcome.length) {
        resultTitles = titles
        results = outcome
        const failures = outcome
          .filter((result) => result.error !== null)
          .map((result) => result.id)
        if (failures.length)
          logger.warn('notes.batch.partial_failed', {
            count: outcome.length,
            failed: failures.length,
          })
        ui.setSelection(failures)
        onChange()
      }
    } catch (error) {
      logFailure(logger, 'notes.batch.failed', error)
      onError(errorText(error))
    } finally {
      busy = false
      focusList()
    }
  }
  export function move(ids: readonly string[]): void {
    moveIds = [...ids]
    destination = ''
    moveOpen = true
  }
</script>

{#if selected.length >= 2}<div
    class={'pointer-events-none absolute inset-x-0 bottom-0 z-20 ' +
      'flex justify-center pb-3'}
  >
    <div
      class={'anim-rise pointer-events-auto flex items-center gap-1 ' +
        'rounded-[var(--r-lg)] border border-[var(--border-default)] ' +
        'bg-[var(--bg-overlay)] p-1 pl-3 shadow-[var(--shadow-pop)]'}
    >
      <span
        class={'mr-1 text-[12px] font-medium ' +
          'text-[var(--text-secondary)] tabular-nums'}
        >{i18n.t('notes.selected')}{selected.length}{i18n.t(
          'notes.notes',
        )}</span
      >
      <DropdownMenu.Root
        ><DropdownMenu.Trigger
          disabled={busy}
          title={i18n.t('common.more_actions')}
          aria-label={i18n.t('common.more_actions')}
          class={'inline-flex size-8 items-center justify-center ' +
            'rounded-[var(--r-md)] text-[var(--text-secondary)] ' +
            'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ' +
            'disabled:opacity-40 md:size-6'}
          ><MoreHorizontal size={13} /></DropdownMenu.Trigger
        ><DropdownMenu.Content
          ><NoteActionItems
            ids={selected}
            inTrash={ui.filter.view === 'trash'}
            {busy}
            {batch}
            {move}
          /></DropdownMenu.Content
        ></DropdownMenu.Root
      >
      <span class="mx-0.5 h-4 w-px bg-[var(--border-subtle)]"></span>
      <IconButton
        label={i18n.t('notes.deselect')}
        title={i18n.t('notes.deselect')}
        size="sm"
        disabled={busy}
        onclick={() =>
          ui.setSelection(ui.activeNoteId ? [ui.activeNoteId] : [])}
        ><X size={13} /></IconButton
      >
    </div>
  </div>{/if}
{#if results.length}<div
    role="status"
    aria-live="polite"
    class={'max-h-32 overflow-auto border-t ' +
      'border-[var(--border-default)] p-2 text-sm'}
  >
    <p>
      {i18n.t('notes.batch_result', {
        success: results.filter((result) => result.error === null).length,
        failed: results.filter((result) => result.error !== null).length,
      })}
    </p>
    {#each failures as result (result.id)}
      <p class="text-destructive">
        {i18n.t('notes.batch_failure', {
          title: resultTitles[result.id] ?? '',
          id: result.id,
          error: errorText(result.error),
        })}
      </p>{/each}
  </div>{/if}

<Dialog.Root bind:open={moveOpen}
  ><Dialog.Content
    ><Dialog.Header
      ><Dialog.Title>{i18n.t('notes.move_to_folder')}</Dialog.Title
      ></Dialog.Header
    ><Field.Field
      ><Field.Label for={`${instanceId}-move-folder`}
        >{i18n.t('navigation.folder')}</Field.Label
      ><select
        id={`${instanceId}-move-folder`}
        class="rounded-md border border-input bg-background p-2"
        bind:value={destination}
        ><option value="">{i18n.t('notes.remove_from_folder')}</option
        >{#each snapshot.folders as folder (folder.id)}<option value={folder.id}
            >{folderPath(snapshot.folders, folder.id)
              .map((item) => item.name)
              .join(' / ')}</option
          >{/each}</select
      ></Field.Field
    ><Dialog.Footer
      ><Button variant="outline" onclick={() => (moveOpen = false)}
        >{i18n.t('common.cancel')}</Button
      ><Button
        disabled={busy}
        onclick={() => {
          moveOpen = false
          void batch('move', moveIds, destination || null)
        }}>{i18n.t('common.save')}</Button
      ></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>
