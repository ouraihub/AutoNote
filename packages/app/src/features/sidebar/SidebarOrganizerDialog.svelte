<script lang="ts">
  import { Check, FolderClosed, X } from '@lucide/svelte'
  import { tick } from 'svelte'
  import { folderPath } from '@app/state/selectors'
  import { LIMITS } from '@shared/constants'
  import {
    ORGANIZER_COLORS,
    ORGANIZER_COLOR_NAMES,
    organizerColorOrNull,
  } from '@shared/organizer-colors'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { Folder, Tag } from '@shared/types'
  import { folderMoveError } from './tree'
  import { getI18n, getNotes } from '@app/root/context'
  import { Button } from '@app/components/ui/button'
  import { Input } from '@app/components/ui/input'
  import * as Dialog from '@app/components/ui/dialog'
  import * as Field from '@app/components/ui/field'
  type Props = {
    open?: boolean
    name?: string
    color?: string
    icon?: string
    parentId?: string
    dialog: 'folder' | 'tag' | null
    editId: string | null
    instanceId: string
    busy: boolean
    feedback: string
    folders: readonly Folder[]
    editingFolder: Folder | undefined
    editingTag: Tag | undefined
    save(): Promise<void>
    removeFolder(strategy: 'move-up' | 'delete'): Promise<void>
    removeTag(): Promise<void>
  }
  let {
    open = $bindable(false),
    name = $bindable(''),
    color = $bindable(''),
    icon = $bindable(''),
    parentId = $bindable(''),
    dialog,
    editId,
    instanceId,
    busy,
    feedback,
    folders,
    editingFolder,
    editingTag,
    save,
    removeFolder,
    removeTag,
  }: Props = $props()
  const i18n = getI18n(),
    notes = getNotes()
  let nameInput = $state<HTMLInputElement | null>(null)
  $effect(() => {
    if (!open || !nameInput) return
    const input = nameInput
    void tick().then(() => {
      if (open && nameInput === input) {
        input.focus()
        input.select()
      }
    })
  })
  const FOLDER_ICONS = [
    '📁',
    '📂',
    '📝',
    '📚',
    '💼',
    '💡',
    '🎯',
    '⭐',
    '🔖',
    '🗂️',
    '🧪',
    '🏠',
    '✈️',
    '🎨',
    '💰',
    '❤️',
  ]
</script>

<Dialog.Root bind:open>
  <Dialog.Content
    ><Dialog.Header
      ><Dialog.Title
        >{dialog === 'folder'
          ? i18n.t(editId ? 'folders.appearance' : 'common.new_folder')
          : i18n.t(editId ? 'tags.rename' : 'tags.new')}</Dialog.Title
      ></Dialog.Header
    >
    <form
      onsubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <Field.Group>
        <Field.Field
          ><Field.Label for={`${instanceId}-organizer-name`}
            >{i18n.t(
              dialog === 'folder'
                ? editId
                  ? 'sidebar.rename'
                  : 'folders.name'
                : 'tags.new_placeholder',
            )}</Field.Label
          ><Input
            id={`${instanceId}-organizer-name`}
            bind:ref={nameInput}
            bind:value={name}
            required
            maxlength={dialog === 'folder'
              ? LIMITS.folderNameMaxLength
              : LIMITS.tagNameMaxLength}
          /></Field.Field
        >
        <Field.Field
          ><Field.Label id={`${instanceId}-organizer-color`}
            >{i18n.t('folders.color')}</Field.Label
          >
          <div
            role="radiogroup"
            aria-labelledby={`${instanceId}-organizer-color`}
            class="grid w-fit grid-cols-6 gap-2"
          >
            <label class="cursor-pointer" title={i18n.t('folders.no_color')}>
              <input
                class="peer sr-only"
                type="radio"
                name={`${instanceId}-folder-color`}
                value=""
                bind:group={color}
                aria-label={i18n.t('folders.no_color')}
              />
              <span
                class={'flex size-7 items-center justify-center ' +
                  'rounded-full border border-dashed ' +
                  'border-[var(--border-strong)] ' +
                  'text-[var(--text-quaternary)] transition-transform ' +
                  'hover:scale-110 peer-checked:ring-2 ' +
                  'peer-checked:ring-[var(--accent)] ' +
                  'peer-checked:ring-offset-2 ' +
                  'peer-checked:ring-offset-[var(--bg-overlay)] ' +
                  'peer-focus-visible:outline-2 ' +
                  'peer-focus-visible:outline-offset-2 ' +
                  'peer-focus-visible:outline-[var(--accent)]'}
                ><X size={12} /></span
              >
            </label>
            {#each ORGANIZER_COLORS as value (value)}
              {@const label = i18n.t(
                `folders.color_${ORGANIZER_COLOR_NAMES[value]}` as MessageKey,
              )}
              <label class="cursor-pointer" title={label}>
                <input
                  class="peer sr-only"
                  type="radio"
                  name={`${instanceId}-folder-color`}
                  {value}
                  bind:group={color}
                  aria-label={label}
                />
                <span
                  class={'flex size-7 items-center justify-center ' +
                    'rounded-full text-white transition-transform ' +
                    'hover:scale-110 peer-checked:ring-2 ' +
                    'peer-checked:ring-[var(--accent)] ' +
                    'peer-checked:ring-offset-2 ' +
                    'peer-checked:ring-offset-[var(--bg-overlay)] ' +
                    'peer-focus-visible:outline-2 ' +
                    'peer-focus-visible:outline-offset-2 ' +
                    'peer-focus-visible:outline-[var(--accent)]'}
                  style:background={value}
                >
                  {#if color === value}<Check size={13} strokeWidth={3} />{/if}
                </span>
              </label>
            {/each}
          </div></Field.Field
        >
        {#if dialog === 'folder'}
          <Field.Field
            ><Field.Label id={`${instanceId}-organizer-icon-label`}
              >{i18n.t('folders.icon')}</Field.Label
            >
            <div
              role="radiogroup"
              aria-labelledby={`${instanceId}-organizer-icon-label`}
              class="grid grid-cols-[repeat(auto-fill,minmax(2rem,1fr))] gap-1"
            >
              <label class="cursor-pointer" title={i18n.t('folders.no_icon')}>
                <input
                  class="peer sr-only"
                  type="radio"
                  name={`${instanceId}-folder-icon`}
                  value=""
                  bind:group={icon}
                  aria-label={i18n.t('folders.no_icon')}
                />
                <span
                  class={'flex h-8 items-center justify-center ' +
                    'rounded-[var(--r-md)] ' +
                    'text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] ' +
                    'peer-checked:bg-[var(--accent-soft)] ' +
                    'peer-checked:ring-1 peer-checked:ring-[var(--accent)] ' +
                    'peer-focus-visible:outline-2 ' +
                    'peer-focus-visible:outline-[var(--accent)]'}
                  style:color={organizerColorOrNull(color) ?? undefined}
                  ><FolderClosed size={15} /></span
                >
              </label>
              {#each FOLDER_ICONS as value (value)}
                <label class="cursor-pointer" title={value}>
                  <input
                    class="peer sr-only"
                    type="radio"
                    name={`${instanceId}-folder-icon`}
                    {value}
                    bind:group={icon}
                    aria-label={value}
                  />
                  <span
                    class={'flex h-8 items-center justify-center ' +
                      'rounded-[var(--r-md)] text-[15px] leading-none ' +
                      'hover:bg-[var(--bg-hover)] ' +
                      'peer-checked:bg-[var(--accent-soft)] ' +
                      'peer-checked:ring-1 peer-checked:ring-[var(--accent)] ' +
                      'peer-focus-visible:outline-2 ' +
                      'peer-focus-visible:outline-[var(--accent)]'}
                    >{value}</span
                  >
                </label>
              {/each}
            </div>
            <Input
              id={`${instanceId}-organizer-icon`}
              aria-labelledby={`${instanceId}-organizer-icon-label`}
              bind:value={icon}
              maxlength={16}
              placeholder={i18n.t('folders.custom_icon')}
            /></Field.Field
          >
          <Field.Field
            ><Field.Label for={`${instanceId}-organizer-parent`}
              >{i18n.t('folders.choose_parent')}</Field.Label
            ><select
              id={`${instanceId}-organizer-parent`}
              class="rounded-md border border-input bg-background p-2"
              bind:value={parentId}
              ><option value="">{i18n.t('folders.top_level')}</option
              >{#each folders as folder (folder.id)}<option
                  value={folder.id}
                  disabled={editId !== null &&
                    folderMoveError(folders, editId, folder.id) !== null}
                  >{folderPath(folders, folder.id)
                    .map((item) => item.name)
                    .join(' / ')}</option
                >{/each}</select
            ></Field.Field
          >
        {/if}
        {#if feedback}<p role="alert" class="text-sm text-destructive">
            {feedback}
          </p>{/if}
        <Dialog.Footer
          ><Button
            type="button"
            variant="outline"
            onclick={() => (open = false)}>{i18n.t('common.cancel')}</Button
          ><Button type="submit" disabled={busy || !name.trim()}
            >{i18n.t('common.save')}</Button
          ></Dialog.Footer
        >
        {#if editingFolder && dialog === 'folder'}
          <Field.Description
            >{i18n.t('folders.delete_contents_move_up', {
              value0: Object.values(notes.summaries).filter(
                (note) => note.folderId === editId,
              ).length,
              value1: folders.filter((folder) => folder.parentId === editId)
                .length,
            })}</Field.Description
          >
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onclick={() => void removeFolder('move-up')}
            >{i18n.t('sidebar.delete_folder')} — {i18n.t(
              'folders.move_contents_up',
            )}</Button
          >
          <Field.Description
            >{i18n.t('folders.delete_subtree_description')}</Field.Description
          >
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onclick={() => void removeFolder('delete')}
            >{i18n.t('folders.delete_subtree')}</Button
          >
        {:else if editingTag && dialog === 'tag'}<Field.Description
            >{i18n.t('tags.delete_confirm_value0', {
              value0: editingTag.name,
            })}</Field.Description
          ><Button
            type="button"
            variant="destructive"
            disabled={busy}
            onclick={() => void removeTag()}>{i18n.t('tags.delete')}</Button
          >{/if}
      </Field.Group>
    </form>
  </Dialog.Content>
</Dialog.Root>
