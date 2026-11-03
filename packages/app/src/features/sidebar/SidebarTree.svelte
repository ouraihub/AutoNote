<script lang="ts">
  import { ChevronRight, FolderClosed, MoreHorizontal } from '@lucide/svelte'
  import { LIMITS } from '@shared/constants'
  import { organizerColorOrNull } from '@shared/organizer-colors'
  import type { FolderNode } from '@app/state/selectors'
  import { folderPath } from '@app/state/selectors'
  import { getI18n, getLogger, getNotes, getUi } from '@app/root/context'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import { folderDropTarget } from './tree'
  import { NOTE_DRAG_TYPE, runNoteBatch } from '../list/actions'
  import { AppError } from '@app/i18n/errors'
  interface Props {
    tree: readonly FolderNode[]
    folders: Parameters<typeof folderPath>[0]
    busy: boolean
    navigate(view: 'folder', target: { folderId: string }): void
    edit(
      kind: 'folder',
      id?: string | null,
      parent?: string | null,
    ): Promise<void>
    move(
      id: string,
      parent: string | null,
      beforeId?: string | null,
    ): Promise<void>
    validateMove(id: string, parent: string | null): boolean
    newNote(folderId: string | null): Promise<void>
    run(action: () => Promise<unknown>): Promise<boolean>
    errorText(error: unknown): string
    setFeedback(value: string): void
  }
  let {
    tree,
    folders,
    busy,
    navigate,
    edit,
    move,
    validateMove,
    newNote,
    run,
    errorText,
    setFeedback,
  }: Props = $props()
  const ui = getUi(),
    i18n = getI18n(),
    notes = getNotes(),
    logger = getLogger()
  let draggingFolder = $state<string | null>(null)
  let dropTarget = $state<string | null>(null)
  let dropPosition = $state<'before' | 'inside' | 'after'>('inside')
  function startFolderDrag(event: DragEvent, id: string): void {
    if (busy || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    draggingFolder = id
    setFeedback('')
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
  function clearDrag(): void {
    draggingFolder = null
    dropTarget = null
  }
  function hover(event: DragEvent, id: string | null): void {
    if (
      busy ||
      (!draggingFolder && !event.dataTransfer?.types.includes(NOTE_DRAG_TYPE))
    )
      return
    event.preventDefault()
    event.stopPropagation()
    dropTarget = id
    const rect =
      event.currentTarget instanceof HTMLElement
        ? event.currentTarget.getBoundingClientRect()
        : null
    const fraction = rect ? (event.clientY - rect.top) / rect.height : 0.5
    dropPosition =
      draggingFolder && id
        ? fraction < 0.25
          ? 'before'
          : fraction > 0.75
            ? 'after'
            : 'inside'
        : 'inside'
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }
  async function drop(
    event: DragEvent,
    node: FolderNode | null,
    siblings: readonly FolderNode[] = [],
  ): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
    const id = draggingFolder,
      position = dropPosition
    clearDrag()
    if (busy) return
    if (id) {
      if (node?.id === id) {
        if (position === 'inside') validateMove(id, id)
        return
      }
      const target = folderDropTarget(node, siblings, position)
      if (target.beforeId === id) return
      await move(id, target.parentId, target.beforeId)
      return
    }
    const raw = event.dataTransfer?.getData(NOTE_DRAG_TYPE)
    if (!raw) return
    try {
      const payload: unknown = JSON.parse(raw)
      if (
        !payload ||
        typeof payload !== 'object' ||
        !('source' in payload) ||
        typeof payload.source !== 'string' ||
        !('ids' in payload) ||
        !Array.isArray(payload.ids)
      )
        return
      const source = payload.source
      const root =
        event.currentTarget instanceof HTMLElement
          ? event.currentTarget.closest('[data-app-root]')
          : null
      if (
        !root ||
        !Array.from(root.querySelectorAll('[role="listbox"]')).some(
          (list) => list.id === source,
        )
      )
        return
      const ids = payload.ids
        .filter((id: unknown): id is string => typeof id === 'string')
        .filter((id) => {
          const note = notes.summaries[id]
          return note && note.deletedAt === null
        })
      if (!ids.length) return
      await run(async () => {
        const results = await runNoteBatch(
          ids,
          async () => true,
          (id) => notes.flush(id),
          async (id) => {
            const note = notes.summaries[id]
            if (!note || note.deletedAt !== null)
              throw new AppError('notes.this_note_no_longer_exists')
            await notes.patch(id, { rev: note.rev, folderId: node?.id ?? null })
          },
          'common.changes_not_saved',
        )
        const failures = results.filter((result) => result.error !== null)
        if (failures.length)
          logger.warn('notes.batch.partial_failed', {
            count: results.length,
            failed: failures.length,
          })
        ui.setSelection(failures.map((result) => result.id))
        setFeedback(
          failures
            .map((result) => {
              const title =
                notes.summaries[result.id]?.title ||
                i18n.t('common.untitled_note')
              return `${title} (${result.id}): ${errorText(result.error)}`
            })
            .join('\n'),
        )
      })
    } catch (error) {
      setFeedback(errorText(error))
    }
  }
</script>

{#snippet folderNodes(nodes: readonly FolderNode[])}
  {#each nodes as node, index (node.id)}
    {@const previous = nodes[index - 1]}
    {@const active =
      ui.filter.view === 'folder' && ui.filter.folderId === node.id}
    {@const expanded = ui.expandedFolders.includes(node.id)}
    {@const folderColor = organizerColorOrNull(node.color)}
    <li
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={ui.filter.folderId === node.id}
      aria-expanded={node.children.length
        ? ui.expandedFolders.includes(node.id)
        : undefined}
    >
      <div
        role="presentation"
        class={[
          'group relative flex h-10 items-center gap-1 ' +
            'rounded-[var(--r-md)] pr-1 md:h-[30px]',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          dropTarget === node.id &&
            dropPosition === 'inside' &&
            'ring-1 ring-[var(--accent)]',
        ]}
        style:padding-left={`${6 + node.depth * 13}px`}
        draggable={!busy}
        ondragstart={(event) => startFolderDrag(event, node.id)}
        ondragend={clearDrag}
        ondragover={(event) => hover(event, node.id)}
        ondrop={(event) => void drop(event, node, nodes)}
        oncontextmenu={(event) => {
          event.preventDefault()
          event.currentTarget
            .querySelector<HTMLButtonElement>('[data-folder-menu]')
            ?.click()
        }}
      >
        {#if dropTarget === node.id && dropPosition === 'before'}<span
            aria-hidden="true"
            class={'pointer-events-none absolute top-0 right-1 left-1 ' +
              'h-px bg-[var(--accent)]'}
          ></span>{/if}
        {#if dropTarget === node.id && dropPosition === 'after'}<span
            aria-hidden="true"
            class={'pointer-events-none absolute right-1 bottom-0 left-1 ' +
              'h-px bg-[var(--accent)]'}
          ></span>{/if}
        <button
          type="button"
          disabled={!node.children.length}
          aria-hidden={!node.children.length || undefined}
          tabindex={node.children.length ? undefined : -1}
          aria-label={i18n.t(expanded ? 'sidebar.collapse' : 'sidebar.expand')}
          onclick={(event) => {
            event.stopPropagation()
            ui.toggleFolder(node.id)
          }}
          class={[
            'flex size-8 shrink-0 items-center justify-center rounded ' +
              'text-[var(--text-quaternary)] md:size-4',
            'transition-transform duration-[var(--dur-base)] ' +
              'ease-[var(--ease-out)]',
            expanded && 'rotate-90',
            !node.children.length && 'invisible',
          ]}><ChevronRight size={12} /></button
        >
        <span
          class={[
            'shrink-0',
            !folderColor &&
              (active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]'),
          ]}
          style:color={folderColor ?? undefined}
          >{#if node.icon}<span class="text-[13px] leading-none"
              >{node.icon}</span
            >{:else}<FolderClosed size={14} />{/if}</span
        >
        <button
          type="button"
          data-folder-navigation={node.id}
          aria-current={active ? 'page' : undefined}
          class={'min-w-0 flex-1 truncate py-1 text-left ' +
            'text-[12.5px] font-medium'}
          title={folderPath(folders, node.id)
            .map((item) => item.name)
            .join(' / ')}
          onclick={() => navigate('folder', { folderId: node.id })}
          ondblclick={() => void edit('folder', node.id)}
          onkeydown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault()
              void edit('folder', node.id)
            }
            if (
              (event.key === 'F10' && event.shiftKey) ||
              event.key === 'ContextMenu'
            ) {
              event.preventDefault()
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>('[data-folder-menu]')
                ?.click()
            }
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const buttons = [
                ...(event.currentTarget
                  .closest('nav')
                  ?.querySelectorAll<HTMLButtonElement>(
                    '[data-folder-navigation]',
                  ) ?? []),
              ]
              const current = buttons.indexOf(event.currentTarget)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : current + (event.key === 'ArrowDown' ? 1 : -1)
              buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus()
            }
            if (
              event.key === 'ArrowRight' &&
              node.children.length &&
              !expanded
            ) {
              event.preventDefault()
              ui.toggleFolder(node.id)
            }
            if (event.key === 'ArrowLeft' && expanded) {
              event.preventDefault()
              ui.toggleFolder(node.id)
            }
          }}>{node.name || i18n.t('common.new_folder')}</button
        >
        <span
          class={'tabular shrink-0 text-[11px] ' +
            'text-[var(--text-quaternary)] transition-opacity ' +
            'group-hover:opacity-0'}
          >{node.totalNotes > 0 ? node.totalNotes : ''}</span
        >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            data-folder-menu
            title={i18n.t('common.more_actions')}
            class={'absolute right-1 inline-flex size-8 shrink-0 ' +
              'items-center justify-center rounded-[var(--r-md)] ' +
              'text-[var(--text-secondary)] opacity-100 transition-opacity ' +
              'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ' +
              'md:size-6 md:opacity-0 md:group-hover:opacity-100 ' +
              'md:focus-visible:opacity-100'}
            aria-label={`${i18n.t('common.more_actions')}: ${node.name}`}
            ><MoreHorizontal size={13} /></DropdownMenu.Trigger
          >
          <DropdownMenu.Content
            ><DropdownMenu.Group>
              <DropdownMenu.Item onclick={() => void edit('folder', node.id)}
                >{i18n.t('sidebar.rename')} / {i18n.t(
                  'folders.appearance',
                )}</DropdownMenu.Item
              >
              <DropdownMenu.Item onclick={() => void newNote(node.id)}
                >{i18n.t('sidebar.create_new_note_here')}</DropdownMenu.Item
              >
              <DropdownMenu.Item
                disabled={node.depth + 1 >= LIMITS.folderDepthMax}
                onclick={() => void edit('folder', null, node.id)}
                >{i18n.t('sidebar.new_subfolder')}</DropdownMenu.Item
              >
              <DropdownMenu.Item onclick={() => void edit('folder', node.id)}
                >{i18n.t('folders.move_to')}</DropdownMenu.Item
              >
              <DropdownMenu.Item
                disabled={busy || !previous}
                onclick={() => {
                  if (previous) void move(node.id, node.parentId, previous.id)
                }}>{i18n.t('sidebar.move_earlier')}</DropdownMenu.Item
              >
              <DropdownMenu.Item
                disabled={busy || index === nodes.length - 1}
                onclick={() =>
                  void move(
                    node.id,
                    node.parentId,
                    nodes[index + 2]?.id ?? null,
                  )}>{i18n.t('sidebar.move_later')}</DropdownMenu.Item
              >
              <DropdownMenu.Item
                disabled={busy || node.parentId === null}
                onclick={() =>
                  void move(
                    node.id,
                    folders.find((item) => item.id === node.parentId)
                      ?.parentId ?? null,
                  )}>{i18n.t('sidebar.move_out_one_level')}</DropdownMenu.Item
              >
              <DropdownMenu.Item
                variant="destructive"
                onclick={() => void edit('folder', node.id)}
                >{i18n.t('sidebar.delete_folder')}</DropdownMenu.Item
              >
            </DropdownMenu.Group></DropdownMenu.Content
          >
        </DropdownMenu.Root>
      </div>
      {#if ui.expandedFolders.includes(node.id) && node.children.length}<ul
          role="group"
        >
          {@render folderNodes(node.children)}
        </ul>{/if}
    </li>
  {/each}
{/snippet}
{#if tree.length}<ul
    role="tree"
    aria-label={i18n.t('navigation.folder')}
    class="mt-0.5 flex flex-col gap-px"
  >
    {@render folderNodes(tree)}
  </ul>{:else}<button
    type="button"
    disabled={busy}
    onclick={() => void edit('folder')}
    class={'mt-0.5 flex h-10 w-full items-center gap-2 ' +
      'rounded-[var(--r-md)] px-2 text-[12px] ' +
      'text-[var(--text-quaternary)] transition-colors ' +
      'hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] ' +
      'disabled:pointer-events-none disabled:opacity-45 md:h-[30px]'}
    ><FolderClosed size={13} />{i18n.t('sidebar.create_first_folder')}</button
  >{/if}
{#if draggingFolder}<button
    type="button"
    disabled={busy}
    ondragover={(event) => hover(event, null)}
    ondrop={(event) => void drop(event, null)}
    onclick={() => {
      const id = draggingFolder
      clearDrag()
      if (id) void move(id, null)
    }}
    class={'mt-1 flex h-[30px] w-full items-center justify-center ' +
      'rounded-[var(--r-md)] border border-dashed ' +
      'border-[var(--border-default)] text-[11.5px] ' +
      'text-[var(--text-tertiary)]'}>{i18n.t('folders.drop_top_level')}</button
  >{/if}
