<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { ChevronRight, Folder, Hash, MoreHorizontal, PanelLeft, Plus, X } from '@lucide/svelte'
  import { LIMITS } from '@shared/constants'
  import { ORGANIZER_COLORS, organizerColorOrNull } from '@shared/organizer-colors'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { FolderNode } from '@app/state/selectors'
  import type { ViewKind } from '@shared/types'
  import { buildFolderTree, folderPath, selectNavigation } from '@app/state/selectors'
  import { getExtensions, getI18n, getNotes, getNotifier, getOrganize, getUi } from '@app/root/context'
  import { Button, buttonVariants } from '@app/components/ui/button'
  import { Input } from '@app/components/ui/input'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import * as Dialog from '@app/components/ui/dialog'
  import * as Drawer from '@app/components/ui/drawer'
  import * as Field from '@app/components/ui/field'
  import { folderDropTarget, folderMoveError } from './tree'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import { NOTE_DRAG_TYPE, runNoteBatch } from '../list/actions'

  const notes = getNotes(),
    ui = getUi(),
    organize = getOrganize(),
    i18n = getI18n(),
    extensions = getExtensions(),
    notifier = getNotifier()
  const instanceId = $props.id()
  const snapshot = $derived(notes.readOrganizeSnapshot())
  const navigation = $derived(selectNavigation(notes.summaries))
  const tree = $derived(buildFolderTree(snapshot.folders, navigation.folderCounts))
  const tagCounts = $derived.by(() => {
    const counts = new SvelteMap<string, number>()
    for (const note of Object.values(notes.summaries))
      if (note.deletedAt === null && !note.isArchived)
        for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return counts
  })
  const views: { view: ViewKind; key: MessageKey; count?: keyof typeof navigation.counts }[] = [
    { view: 'all', key: 'navigation.all_notes', count: 'all' },
    { view: 'recent', key: 'navigation.recently_edited' },
    { view: 'starred', key: 'navigation.favorites', count: 'starred' },
    { view: 'unfiled', key: 'navigation.unfiled', count: 'unfiled' },
    { view: 'archived', key: 'navigation.archive', count: 'archived' },
    { view: 'trash', key: 'navigation.trash', count: 'trash' },
  ]
  let narrow = $state(false)
  let busy = $state(false)
  let feedback = $state('')
  let dialog = $state<'folder' | 'tag' | null>(null)
  let editId = $state<string | null>(null)
  let parentId = $state('')
  let name = $state('')
  let color = $state('')
  let icon = $state('')
  let editorOpen = $state(false)
  let nameInput = $state<HTMLInputElement | null>(null)
  let draggingFolder = $state<string | null>(null)
  let dropTarget = $state<string | null>(null)
  let dropPosition = $state<'before' | 'inside' | 'after'>('inside')
  let anchorElement = $state<HTMLSpanElement>()
  const drawerOpen = $derived(ui.navDrawerOpen)
  const editingFolder = $derived(snapshot.folders.find((folder) => folder.id === editId))
  const editingTag = $derived(snapshot.tags.find((tag) => tag.id === editId))

  onMount(() => {
    const media = matchMedia('(max-width: 1179px)')
    const update = () => {
      narrow = media.matches
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  })
  $effect(() => {
    const ids = new Set(snapshot.folders.map((folder) => folder.id))
    untrack(() => ui.reconcileFolders(ids))
  })
  async function run(action: () => Promise<unknown>): Promise<boolean> {
    if (busy) return false
    busy = true
    feedback = ''
    try {
      await action()
      return true
    } catch (error) {
      feedback = errorText(error)
      return false
    } finally {
      busy = false
    }
  }
  function errorText(error: unknown): string {
    return isBackendError(error)
      ? i18n.t(messageKeyForError(error.code))
      : error instanceof Error
        ? error.message
        : i18n.t('common.action_failed')
  }
  function navigate(view: ViewKind, target: { folderId?: string; tag?: string } = {}): void {
    ui.openView(view, target)
    if (narrow) ui.toggleNavDrawer(false)
  }
  async function edit(kind: 'folder' | 'tag', id: string | null = null, parent: string | null = null): Promise<void> {
    dialog = kind
    editId = id
    const item =
      kind === 'folder'
        ? snapshot.folders.find((folder) => folder.id === id)
        : snapshot.tags.find((tag) => tag.id === id)
    name = item?.name ?? ''
    color = organizerColorOrNull(item?.color) ?? ''
    parentId = kind === 'folder' ? (snapshot.folders.find((folder) => folder.id === id)?.parentId ?? parent ?? '') : ''
    icon = kind === 'folder' ? (snapshot.folders.find((folder) => folder.id === id)?.icon ?? '') : ''
    feedback = ''
    editorOpen = true
    await tick()
    nameInput?.focus()
    nameInput?.select()
  }
  async function save(): Promise<void> {
    const value = name.trim()
    if (!value) return
    if (dialog === 'tag' && (/[\s#]/u.test(value) || value.length > LIMITS.tagNameMaxLength)) {
      feedback = i18n.t('tags.invalid_name')
      return
    }
    if (dialog === 'folder' && editId && !validateMove(editId, parentId || null)) return
    if (
      dialog === 'tag' &&
      editId &&
      snapshot.tags.some((tag) => tag.id !== editId && tag.name === value) &&
      !(await notifier.confirm({ titleKey: 'tags.merge', bodyKey: 'tags.merge_description', danger: true }))
    )
      return
    const ok = await run(async () => {
      if (dialog === 'folder') {
        const patch = {
          name: value,
          parentId: parentId || null,
          color: organizerColorOrNull(color),
          icon: icon.trim() || null,
        }
        if (editId) {
          await organize.patchFolder(editId, patch)
          if (parentId) ui.expandFolders([parentId])
        } else {
          if (parentId && folderPath(snapshot.folders, parentId).length >= LIMITS.folderDepthMax)
            throw new Error(i18n.t('folders.move_depth'))
          const created = await organize.createFolder(patch)
          ui.expandFolders(parentId ? [parentId] : [])
          ui.openView('folder', { folderId: created.id })
        }
      } else if (dialog === 'tag') {
        if (editId) {
          const oldName = editingTag?.name
          await organize.patchTag(editId, { name: value, color: organizerColorOrNull(color) })
          if (ui.filter.view === 'tag' && ui.filter.tag === oldName) ui.openView('tag', { tag: value })
        } else await organize.createTag({ name: value, color: organizerColorOrNull(color) })
      }
    })
    if (ok) editorOpen = false
  }
  function validateMove(id: string, parent: string | null): boolean {
    const error = folderMoveError(snapshot.folders, id, parent)
    feedback =
      error === 'cycle'
        ? i18n.t('folders.move_cycle')
        : error === 'depth'
          ? i18n.t('folders.move_depth')
          : error === 'missing'
            ? i18n.t('api.error.not_found')
            : ''
    return error === null
  }
  async function move(id: string, parent: string | null, beforeId: string | null = null): Promise<void> {
    if (!validateMove(id, parent)) return
    await run(async () => {
      await organize.patchFolder(id, { parentId: parent, beforeId })
      if (parent) ui.expandFolders([parent])
    })
  }
  async function newNote(folderId: string): Promise<void> {
    await run(async () => {
      const note = await notes.create({ folderId })
      ui.openNote(note.id)
      extensions.onNoteOpened?.(note.id)
      await notes.open(note.id, ui.activePane)
      ui.toggleNavDrawer(false)
    })
  }
  async function removeFolder(strategy: 'move-up' | 'delete'): Promise<void> {
    const id = editId
    if (!id) return
    let removed = false
    if (
      (await run(async () => {
        removed = await organize.removeFolder(id, strategy)
      })) &&
      removed
    )
      editorOpen = false
  }
  async function removeTag(): Promise<void> {
    const id = editId
    if (!id) return
    const oldName = editingTag?.name
    let removed = false
    if (
      (await run(async () => {
        removed = await organize.removeTag(id)
      })) &&
      removed
    ) {
      editorOpen = false
      if (ui.filter.view === 'tag' && ui.filter.tag === oldName) ui.openView('all')
    }
  }
  function startFolderDrag(event: DragEvent, id: string): void {
    if (busy || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    draggingFolder = id
    feedback = ''
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
  function clearDrag(): void {
    draggingFolder = null
    dropTarget = null
  }
  function hover(event: DragEvent, id: string | null): void {
    if (busy || (!draggingFolder && !event.dataTransfer?.types.includes(NOTE_DRAG_TYPE))) return
    event.preventDefault()
    event.stopPropagation()
    dropTarget = id
    const rect = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null
    const fraction = rect ? (event.clientY - rect.top) / rect.height : 0.5
    dropPosition = draggingFolder && id ? (fraction < 0.25 ? 'before' : fraction > 0.75 ? 'after' : 'inside') : 'inside'
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  }
  async function drop(event: DragEvent, node: FolderNode | null, siblings: readonly FolderNode[] = []): Promise<void> {
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
      const root = anchorElement?.closest('[data-app-root]')
      if (!root || ![...root.querySelectorAll('[role="listbox"]')].some((list) => list.id === source)) return
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
            if (!note || note.deletedAt !== null) throw new Error(i18n.t('notes.this_note_no_longer_exists'))
            await notes.patch(id, { rev: note.rev, folderId: node?.id ?? null })
          },
          i18n.t('common.changes_not_saved'),
        )
        const failures = results.filter((result) => result.error !== null)
        ui.setSelection(failures.map((result) => result.id))
        feedback = failures
          .map(
            (result) =>
              `${notes.summaries[result.id]?.title || i18n.t('common.untitled_note')} (${result.id}): ${errorText(result.error)}`,
          )
          .join('\n')
      })
    } catch (error) {
      feedback = errorText(error)
    }
  }
</script>

{#snippet folders(nodes: readonly FolderNode[])}
  {#each nodes as node, index (node.id)}
    {@const previous = nodes[index - 1]}
    <li
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={ui.filter.folderId === node.id}
      aria-expanded={node.children.length ? ui.expandedFolders.includes(node.id) : undefined}
    >
      <div
        role="presentation"
        class="folder-row flex items-center gap-1"
        class:drop-before={dropTarget === node.id && dropPosition === 'before'}
        class:drop-inside={dropTarget === node.id && dropPosition === 'inside'}
        class:drop-after={dropTarget === node.id && dropPosition === 'after'}
        style:padding-left={`${node.depth * 12}px`}
        draggable={!busy}
        ondragstart={(event) => startFolderDrag(event, node.id)}
        ondragend={clearDrag}
        ondragover={(event) => hover(event, node.id)}
        ondrop={(event) => void drop(event, node, nodes)}
        oncontextmenu={(event) => {
          event.preventDefault()
          event.currentTarget.querySelector<HTMLButtonElement>('[data-folder-menu]')?.click()
        }}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!node.children.length}
          aria-label={i18n.t(ui.expandedFolders.includes(node.id) ? 'sidebar.collapse' : 'sidebar.expand')}
          onclick={() => ui.toggleFolder(node.id)}
          ><ChevronRight
            style={ui.expandedFolders.includes(node.id) ? 'transform: rotate(90deg)' : undefined}
          /></Button
        >
        <Button
          data-folder-navigation={node.id}
          variant={ui.filter.folderId === node.id ? 'secondary' : 'ghost'}
          class="min-w-0 flex-1 justify-start"
          title={folderPath(snapshot.folders, node.id)
            .map((item) => item.name)
            .join(' / ')}
          onclick={() => navigate('folder', { folderId: node.id })}
          ondblclick={() => void edit('folder', node.id)}
          onkeydown={(event) => {
            if (event.key === 'F2') {
              event.preventDefault()
              void edit('folder', node.id)
            }
            if ((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') {
              event.preventDefault()
              event.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-folder-menu]')?.click()
            }
            if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
              event.preventDefault()
              const buttons = [
                ...(event.currentTarget
                  .closest('nav')
                  ?.querySelectorAll<HTMLButtonElement>('[data-folder-navigation]') ?? []),
              ]
              const current = buttons.indexOf(event.currentTarget as HTMLButtonElement)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : current + (event.key === 'ArrowDown' ? 1 : -1)
              buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus()
            }
            if (event.key === 'ArrowRight' && node.children.length && !ui.expandedFolders.includes(node.id)) {
              event.preventDefault()
              ui.toggleFolder(node.id)
            }
            if (event.key === 'ArrowLeft' && ui.expandedFolders.includes(node.id)) {
              event.preventDefault()
              ui.toggleFolder(node.id)
            }
          }}
        >
          <span style:color={organizerColorOrNull(node.color) ?? undefined}
            >{#if node.icon}{node.icon}{:else}<Folder />{/if}</span
          ><span class="truncate">{node.name || i18n.t('common.new_folder')}</span><span class="ml-auto tabular-nums"
            >{node.totalNotes}</span
          >
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            data-folder-menu
            class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
            aria-label={`${i18n.t('common.more_actions')}: ${node.name}`}><MoreHorizontal /></DropdownMenu.Trigger
          >
          <DropdownMenu.Content
            ><DropdownMenu.Group>
              <DropdownMenu.Item onclick={() => void edit('folder', node.id)}
                >{i18n.t('sidebar.rename')} / {i18n.t('folders.appearance')}</DropdownMenu.Item
              >
              <DropdownMenu.Item onclick={() => void newNote(node.id)}
                >{i18n.t('sidebar.create_new_note_here')}</DropdownMenu.Item
              >
              <DropdownMenu.Item
                disabled={node.depth + 1 >= LIMITS.folderDepthMax}
                onclick={() => void edit('folder', null, node.id)}>{i18n.t('sidebar.new_subfolder')}</DropdownMenu.Item
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
                onclick={() => void move(node.id, node.parentId, nodes[index + 2]?.id ?? null)}
                >{i18n.t('sidebar.move_later')}</DropdownMenu.Item
              >
              <DropdownMenu.Item
                disabled={busy || node.parentId === null}
                onclick={() =>
                  void move(node.id, snapshot.folders.find((item) => item.id === node.parentId)?.parentId ?? null)}
                >{i18n.t('sidebar.move_out_one_level')}</DropdownMenu.Item
              >
              <DropdownMenu.Item variant="destructive" onclick={() => void edit('folder', node.id)}
                >{i18n.t('sidebar.delete_folder')}</DropdownMenu.Item
              >
            </DropdownMenu.Group></DropdownMenu.Content
          >
        </DropdownMenu.Root>
      </div>
      {#if ui.expandedFolders.includes(node.id) && node.children.length}<ul role="group">
          {@render folders(node.children)}
        </ul>{/if}
    </li>
  {/each}
{/snippet}

{#snippet content()}
  <nav
    class="flex h-full min-h-0 flex-col gap-2 overflow-auto bg-[var(--bg-sunken)] p-2"
    aria-label={i18n.t('common.navigation')}
    data-testid="sidebar"
  >
    <div class="flex items-center justify-between">
      <strong>{i18n.t('common.product_name')}</strong><Button
        variant="ghost"
        size="icon-sm"
        aria-label={i18n.t(narrow ? 'common.close' : 'sidebar.collapse_navigation')}
        onclick={() => (narrow ? ui.toggleNavDrawer(false) : ui.toggleNav())}
        >{#if narrow}<X />{:else}<PanelLeft />{/if}</Button
      >
    </div>
    {#each views as item (item.view)}<Button
        class="w-full justify-between"
        variant={ui.filter.view === item.view ? 'secondary' : 'ghost'}
        aria-current={ui.filter.view === item.view ? 'page' : undefined}
        ondragover={(event) => {
          if (item.view === 'unfiled' && !draggingFolder) hover(event, null)
        }}
        ondrop={(event) => {
          if (item.view === 'unfiled' && !draggingFolder) void drop(event, null)
        }}
        onclick={() => navigate(item.view)}
        >{i18n.t(item.key)}{#if item.count}<span class="tabular-nums">{navigation.counts[item.count]}</span
          >{/if}</Button
      >{/each}
    <section aria-label={i18n.t('navigation.folder')}>
      <div class="flex items-center justify-between">
        <h2 class="text-sm">{i18n.t('navigation.folder')}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          aria-label={i18n.t('common.new_folder')}
          onclick={() => void edit('folder')}><Plus /></Button
        >
      </div>
      {#if tree.length}<ul role="tree" aria-label={i18n.t('navigation.folder')}>
          {@render folders(tree)}
        </ul>{:else}<Button variant="ghost" onclick={() => void edit('folder')}
          >{i18n.t('sidebar.create_first_folder')}</Button
        >{/if}
      {#if draggingFolder}<Button
          variant="outline"
          class="w-full"
          disabled={busy}
          ondragover={(event) => hover(event, null)}
          ondrop={(event) => void drop(event, null)}
          onclick={() => {
            const id = draggingFolder
            clearDrag()
            if (id) void move(id, null)
          }}>{i18n.t('folders.drop_top_level')}</Button
        >{/if}
    </section>
    <section aria-label={i18n.t('navigation.tag')}>
      <div class="flex items-center justify-between">
        <h2 class="text-sm">{i18n.t('navigation.tag')}</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={busy}
          aria-label={i18n.t('tags.new')}
          onclick={() => void edit('tag')}><Plus /></Button
        >
      </div>
      {#each snapshot.tags as tag (tag.id)}
        <div
          role="presentation"
          class="flex items-center gap-1"
          oncontextmenu={(event) => {
            event.preventDefault()
            void edit('tag', tag.id)
          }}
        >
          <Button
            class="min-w-0 flex-1 justify-start"
            variant={ui.filter.tag === tag.name ? 'secondary' : 'ghost'}
            onclick={() => navigate('tag', { tag: tag.name })}
            onkeydown={(event) => {
              if (event.key === 'F2' || event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                event.preventDefault()
                void edit('tag', tag.id)
              }
            }}
            ><Hash
              data-icon="inline-start"
              style={tag.color ? `color: ${organizerColorOrNull(tag.color) ?? 'inherit'}` : undefined}
            /><span class="truncate">{tag.name}</span><span class="ml-auto tabular-nums"
              >{tagCounts.get(tag.name) ?? 0}</span
            ></Button
          ><Button
            variant="ghost"
            size="icon-sm"
            aria-label={`${i18n.t('tags.rename')}: ${tag.name}`}
            onclick={() => void edit('tag', tag.id)}><MoreHorizontal /></Button
          >
        </div>
      {/each}
    </section>
    <Button
      variant="ghost"
      onclick={() => {
        ui.toggleNavDrawer(false)
        ui.openPanel('graph')
      }}>{i18n.t('common.graph')}</Button
    >
    <Button
      variant="ghost"
      onclick={() => {
        ui.toggleNavDrawer(false)
        ui.openPanel('settings')
      }}>{i18n.t('common.settings')}</Button
    >
    {#if feedback && !editorOpen}<p role="alert" class="whitespace-pre-line text-sm text-destructive">
        {feedback}
      </p>{/if}
  </nav>
{/snippet}
<span bind:this={anchorElement} hidden></span>

{#if narrow}
  <Drawer.Root direction="left" open={drawerOpen} onOpenChange={(open) => ui.toggleNavDrawer(open)}
    ><Drawer.Content
      ><Drawer.Header><Drawer.Title>{i18n.t('common.navigation')}</Drawer.Title></Drawer.Header
      >{@render content()}</Drawer.Content
    ></Drawer.Root
  >
{:else if ui.layout.navCollapsed}
  <Button variant="ghost" size="icon-sm" aria-label={i18n.t('sidebar.expand_navigation')} onclick={() => ui.toggleNav()}
    ><PanelLeft /></Button
  >
{:else}
  <aside
    class="h-full min-h-0 shrink-0 border-r border-[var(--border-default)]"
    style:width={`${ui.layout.navWidth}px`}
  >
    {@render content()}
  </aside>
{/if}

<Dialog.Root bind:open={editorOpen}>
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
            >{i18n.t(dialog === 'folder' ? 'sidebar.rename' : 'tags.new_placeholder')}</Field.Label
          ><Input
            id={`${instanceId}-organizer-name`}
            bind:ref={nameInput}
            bind:value={name}
            required
            maxlength={dialog === 'folder' ? LIMITS.folderNameMaxLength : LIMITS.tagNameMaxLength}
          /></Field.Field
        >
        <Field.Field
          ><Field.Label for={`${instanceId}-organizer-color`}>{i18n.t('folders.color')}</Field.Label><select
            id={`${instanceId}-organizer-color`}
            class="rounded-md border border-input bg-background p-2"
            bind:value={color}
            ><option value="">{i18n.t('folders.no_color')}</option>{#each ORGANIZER_COLORS as value (value)}<option
                {value}>{value}</option
              >{/each}</select
          ></Field.Field
        >
        {#if dialog === 'folder'}
          <Field.Field
            ><Field.Label for={`${instanceId}-organizer-icon`}>{i18n.t('folders.icon')}</Field.Label><Input
              id={`${instanceId}-organizer-icon`}
              bind:value={icon}
              maxlength={16}
              placeholder={i18n.t('folders.no_icon')}
            /></Field.Field
          >
          <Field.Field
            ><Field.Label for={`${instanceId}-organizer-parent`}>{i18n.t('folders.choose_parent')}</Field.Label><select
              id={`${instanceId}-organizer-parent`}
              class="rounded-md border border-input bg-background p-2"
              bind:value={parentId}
              ><option value="">{i18n.t('folders.top_level')}</option
              >{#each snapshot.folders as folder (folder.id)}<option
                  value={folder.id}
                  disabled={editId !== null && folderMoveError(snapshot.folders, editId, folder.id) !== null}
                  >{folderPath(snapshot.folders, folder.id)
                    .map((item) => item.name)
                    .join(' / ')}</option
                >{/each}</select
            ></Field.Field
          >
        {/if}
        {#if feedback}<p role="alert" class="text-sm text-destructive">{feedback}</p>{/if}
        <Dialog.Footer
          ><Button type="button" variant="outline" onclick={() => (editorOpen = false)}
            >{i18n.t('common.cancel')}</Button
          ><Button type="submit" disabled={busy || !name.trim()}>{i18n.t('common.save')}</Button></Dialog.Footer
        >
        {#if editingFolder && dialog === 'folder'}
          <Field.Description
            >{i18n.t('folders.delete_contents_move_up', {
              value0: Object.values(notes.summaries).filter((note) => note.folderId === editId).length,
              value1: snapshot.folders.filter((folder) => folder.parentId === editId).length,
            })}</Field.Description
          >
          <Button type="button" variant="outline" disabled={busy} onclick={() => void removeFolder('move-up')}
            >{i18n.t('sidebar.delete_folder')} — {i18n.t('folders.move_contents_up')}</Button
          >
          <Field.Description>{i18n.t('folders.delete_subtree_description')}</Field.Description>
          <Button type="button" variant="destructive" disabled={busy} onclick={() => void removeFolder('delete')}
            >{i18n.t('folders.delete_subtree')}</Button
          >
        {:else if editingTag && dialog === 'tag'}<Field.Description
            >{i18n.t('tags.delete_confirm_value0', { value0: editingTag.name })}</Field.Description
          ><Button type="button" variant="destructive" disabled={busy} onclick={() => void removeTag()}
            >{i18n.t('tags.delete')}</Button
          >{/if}
      </Field.Group>
    </form>
  </Dialog.Content>
</Dialog.Root>

<style>
  .folder-row.drop-before {
    box-shadow: 0 -2px var(--accent);
  }
  .folder-row.drop-after {
    box-shadow: 0 2px var(--accent);
  }
  .folder-row.drop-inside {
    background: var(--accent-soft);
  }
</style>
