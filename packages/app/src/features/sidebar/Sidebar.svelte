<script lang="ts">
  import { onMount, tick, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import {
    Archive,
    Camera,
    Check,
    ChevronRight,
    Clock,
    FilePlus2,
    FileText,
    FolderClosed,
    FolderPlus,
    Hash,
    Inbox,
    LogOut,
    Moon,
    MoreHorizontal,
    PanelLeft,
    PanelLeftClose,
    Plus,
    Settings,
    Star,
    Sun,
    Trash2,
    Waypoints,
    X,
  } from '@lucide/svelte'
  import type { Component } from 'svelte'
  import { LIMITS } from '@shared/constants'
  import { ORGANIZER_COLORS, ORGANIZER_COLOR_NAMES, organizerColorOrNull } from '@shared/organizer-colors'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { FolderNode } from '@app/state/selectors'
  import type { ViewKind } from '@shared/types'
  import { buildFolderTree, folderPath, selectNavigation } from '@app/state/selectors'
  import {
    getBackend,
    getExtensions,
    getI18n,
    getLogger,
    getNotes,
    getNotifier,
    getOrganize,
    getSession,
    getSettings,
    getUi,
  } from '@app/root/context'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Logo from '@app/components/primitives/Logo.svelte'
  import SectionLabel from '@app/components/primitives/SectionLabel.svelte'
  import SearchButton from '@app/components/primitives/SearchButton.svelte'
  import Avatar from '@app/components/primitives/Avatar.svelte'
  import AvatarPicker from '@app/features/settings/AvatarPicker.svelte'
  import { Button } from '@app/components/ui/button'
  import { Input } from '@app/components/ui/input'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import * as Dialog from '@app/components/ui/dialog'
  import * as Drawer from '@app/components/ui/drawer'
  import * as Field from '@app/components/ui/field'
  import { folderDropTarget, folderMoveError } from './tree'
  import { logFailure } from '@app/log/logger'
  import { AppError, errorMessageKey } from '@app/i18n/errors'
  import { NOTE_DRAG_TYPE, runNoteBatch } from '../list/actions'

  const notes = getNotes(),
    ui = getUi(),
    organize = getOrganize(),
    i18n = getI18n(),
    extensions = getExtensions(),
    notifier = getNotifier(),
    session = getSession(),
    settings = getSettings(),
    logger = getLogger(),
    showBrand = getBackend().kind !== 'desktop'
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
  type ViewEntry = { view: ViewKind; key: MessageKey; icon: Component; count?: keyof typeof navigation.counts }
  const views: ViewEntry[] = [
    { view: 'all', key: 'navigation.all_notes', icon: FileText, count: 'all' },
    { view: 'recent', key: 'navigation.recently_edited', icon: Clock },
    { view: 'starred', key: 'navigation.favorites', icon: Star, count: 'starred' },
    { view: 'unfiled', key: 'navigation.unfiled', icon: Inbox, count: 'unfiled' },
  ]
  const bottomViews: ViewEntry[] = [
    { view: 'archived', key: 'navigation.archive', icon: Archive, count: 'archived' },
    { view: 'trash', key: 'navigation.trash', icon: Trash2, count: 'trash' },
  ]
  const user = $derived(session.user)
  const displayName = $derived(user ? user.name || user.username : '')
  let narrow = $state(false)
  let avatarOpen = $state(false)
  let busy = $state(false)
  let feedback = $state('')
  let dialog = $state<'folder' | 'tag' | null>(null)
  let editId = $state<string | null>(null)
  let parentId = $state('')
  let name = $state('')
  let color = $state('')
  let icon = $state('')
  const FOLDER_ICONS = ['📁', '📂', '📝', '📚', '💼', '💡', '🎯', '⭐', '🔖', '🗂️', '🧪', '🏠', '✈️', '🎨', '💰', '❤️']
  let editorOpen = $state(false)
  let nameInput = $state<HTMLInputElement | null>(null)
  let draggingFolder = $state<string | null>(null)
  let dropTarget = $state<string | null>(null)
  let dropPosition = $state<'before' | 'inside' | 'after'>('inside')
  let anchorElement = $state<HTMLSpanElement>()
  const drawerOpen = $derived(ui.navDrawerOpen)
  const editingFolder = $derived(snapshot.folders.find((folder) => folder.id === editId))
  const editingTag = $derived(snapshot.tags.find((tag) => tag.id === editId))
  const isDark = $derived(
    settings.current.appearance.theme === 'dark' ||
      (settings.current.appearance.theme === 'system' &&
        anchorElement?.closest<HTMLElement>('[data-app-root]')?.dataset.theme === 'dark'),
  )

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
      logFailure(logger, 'organize.action.failed', error)
      feedback = errorText(error)
      return false
    } finally {
      busy = false
    }
  }
  function errorText(error: unknown): string {
    return i18n.t(errorMessageKey(error))
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
            throw new AppError('folders.move_depth')
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
  async function newNote(folderId: string | null): Promise<void> {
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
            if (!note || note.deletedAt !== null) throw new AppError('notes.this_note_no_longer_exists')
            await notes.patch(id, { rev: note.rev, folderId: node?.id ?? null })
          },
          'common.changes_not_saved',
        )
        const failures = results.filter((result) => result.error !== null)
        if (failures.length) logger.warn('notes.batch.partial_failed', { count: results.length, failed: failures.length })
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
    {@const active = ui.filter.view === 'folder' && ui.filter.folderId === node.id}
    {@const expanded = ui.expandedFolders.includes(node.id)}
    {@const folderColor = organizerColorOrNull(node.color)}
    <li
      role="treeitem"
      aria-level={node.depth + 1}
      aria-selected={ui.filter.folderId === node.id}
      aria-expanded={node.children.length ? ui.expandedFolders.includes(node.id) : undefined}
    >
      <div
        role="presentation"
        class={[
          'group relative flex h-10 items-center gap-1 rounded-[var(--r-md)] pr-1 md:h-[30px]',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
          dropTarget === node.id && dropPosition === 'inside' && 'ring-1 ring-[var(--accent)]',
        ]}
        style:padding-left={`${6 + node.depth * 13}px`}
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
        {#if dropTarget === node.id && dropPosition === 'before'}<span
            aria-hidden="true"
            class="pointer-events-none absolute top-0 right-1 left-1 h-px bg-[var(--accent)]"
          ></span>{/if}
        {#if dropTarget === node.id && dropPosition === 'after'}<span
            aria-hidden="true"
            class="pointer-events-none absolute right-1 bottom-0 left-1 h-px bg-[var(--accent)]"
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
            'flex size-8 shrink-0 items-center justify-center rounded text-[var(--text-quaternary)] md:size-4',
            'transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]',
            expanded && 'rotate-90',
            !node.children.length && 'invisible',
          ]}><ChevronRight size={12} /></button
        >
        <span
          class={['shrink-0', !folderColor && (active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]')]}
          style:color={folderColor ?? undefined}
          >{#if node.icon}<span class="text-[13px] leading-none">{node.icon}</span>{:else}<FolderClosed
              size={14}
            />{/if}</span
        >
        <button
          type="button"
          data-folder-navigation={node.id}
          aria-current={active ? 'page' : undefined}
          class="min-w-0 flex-1 truncate py-1 text-left text-[12.5px] font-medium"
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
              const current = buttons.indexOf(event.currentTarget)
              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : current + (event.key === 'ArrowDown' ? 1 : -1)
              buttons[Math.max(0, Math.min(buttons.length - 1, next))]?.focus()
            }
            if (event.key === 'ArrowRight' && node.children.length && !expanded) {
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
          class="tabular shrink-0 text-[11px] text-[var(--text-quaternary)] transition-opacity group-hover:opacity-0"
          >{node.totalNotes > 0 ? node.totalNotes : ''}</span
        >
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            data-folder-menu
            title={i18n.t('common.more_actions')}
            class="absolute right-1 inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] opacity-100 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-6 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
            aria-label={`${i18n.t('common.more_actions')}: ${node.name}`}
            ><MoreHorizontal size={13} /></DropdownMenu.Trigger
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

{#snippet viewItem(item: ViewEntry)}
  {@const active = ui.filter.view === item.view}
  {@const count = item.count ? navigation.counts[item.count] : 0}
  <button
    type="button"
    aria-current={active ? 'page' : undefined}
    ondragover={(event) => {
      if (item.view === 'unfiled' && !draggingFolder) hover(event, null)
    }}
    ondrop={(event) => {
      if (item.view === 'unfiled' && !draggingFolder) void drop(event, null)
    }}
    onclick={() => navigate(item.view)}
    class={[
      'group relative flex h-10 w-full items-center gap-2.5 rounded-[var(--r-md)] px-2 text-left md:h-[30px]',
      'transition-colors duration-[var(--dur-fast)]',
      active
        ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
        : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
    ]}
  >
    <span class={['shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-tertiary)]']}
      ><item.icon size={14} /></span
    >
    <span class="min-w-0 flex-1 truncate text-[12.5px] font-medium">{i18n.t(item.key as MessageKey)}</span>
    {#if count > 0}<span class="tabular shrink-0 text-[11px] text-[var(--text-quaternary)]">{count}</span>{/if}
  </button>
{/snippet}

{#snippet accountMenu(rail: boolean)}
  {#if user}
    <DropdownMenu.Root>
      {#if rail}
        <DropdownMenu.Trigger
          aria-label={i18n.t('sidebar.account_and_settings')}
          title={`${i18n.t('sidebar.account_and_settings')} · ${displayName}`}
          class="rounded-full transition-transform duration-[var(--dur-fast)] hover:scale-105 active:scale-95"
          ><Avatar src={user.avatarUrl} name={displayName} size={28} /></DropdownMenu.Trigger
        >
      {:else}
        <div
          class="group flex h-11 w-full items-center rounded-[var(--r-md)] transition-colors hover:bg-[var(--bg-hover)]"
        >
          <DropdownMenu.Trigger
            aria-label={i18n.t('sidebar.account_and_settings')}
            class="flex h-full min-w-0 flex-1 items-center gap-2.5 rounded-l-[var(--r-md)] pl-2 text-left"
          >
            <Avatar src={user.avatarUrl} name={displayName} size={28} />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[12.5px] font-semibold text-[var(--text-primary)]">{displayName}</span>
              <span class="block truncate text-[10.5px] text-[var(--text-quaternary)]">@{user.username}</span>
            </span>
          </DropdownMenu.Trigger>
          <IconButton
            label={i18n.t('common.settings')}
            title={i18n.t('common.settings')}
            size="sm"
            onclick={() => ui.openPanel('settings')}
            class="mr-1 shrink-0 text-[var(--text-quaternary)] group-hover:text-[var(--text-tertiary)]"
            ><Settings size={14} /></IconButton
          >
        </div>
      {/if}
      <DropdownMenu.Content class="w-[252px]">
        <DropdownMenu.Group>
          <DropdownMenu.Item onclick={() => (avatarOpen = true)}
            ><Camera size={13} />{i18n.t('settings.change_avatar')}</DropdownMenu.Item
          >
          <DropdownMenu.Item onclick={() => ui.openPanel('settings')}
            ><Settings size={13} />{i18n.t('common.settings')}</DropdownMenu.Item
          >
          <DropdownMenu.Item
            onclick={() => {
              ui.toggleNavDrawer(false)
              ui.openPanel('graph')
            }}><Waypoints size={13} />{i18n.t('common.graph')}</DropdownMenu.Item
          >
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Item onclick={() => settings.update({ appearance: { theme: isDark ? 'light' : 'dark' } })}
            >{#if isDark}<Sun size={13} />{:else}<Moon size={13} />{/if}{i18n.t(
              isDark ? 'sidebar.switch_to_light' : 'sidebar.switch_to_dark',
            )}</DropdownMenu.Item
          >
        </DropdownMenu.Group>
        <DropdownMenu.Separator />
        <DropdownMenu.Group>
          <DropdownMenu.Item variant="destructive" onclick={() => void session.logout()}
            ><LogOut size={13} />{i18n.t('sidebar.log_out')}</DropdownMenu.Item
          >
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu.Root>
    {#if avatarOpen}<AvatarPicker onClose={() => (avatarOpen = false)} />{/if}
  {/if}
{/snippet}

{#snippet content()}
  <aside class="flex h-full min-h-0 flex-col bg-[var(--bg-sunken)]" data-testid="sidebar">
    <header
      class={[
        'flex h-11 shrink-0 items-center border-b border-[var(--border-subtle)] px-3',
        showBrand ? 'justify-between' : 'justify-end',
      ]}
    >
      {#if showBrand}<div class="flex min-w-0 items-center gap-[9px] select-none">
          <Logo size={24} />
          <span
            class="min-w-0 truncate font-serif text-[15.5px] font-semibold tracking-[0.02em] text-[var(--text-primary)]"
            >{i18n.t('common.product_name')}</span
          >
        </div>{/if}
      <IconButton
        label={i18n.t(narrow ? 'common.close' : 'sidebar.collapse_navigation')}
        title={i18n.t(narrow ? 'common.close' : 'sidebar.collapse_navigation')}
        size="sm"
        onclick={() => (narrow ? ui.toggleNavDrawer(false) : ui.toggleNav())}
        >{#if narrow}<X size={15} />{:else}<PanelLeftClose size={15} />{/if}</IconButton
      >
    </header>

    <div class="shrink-0 px-2 pt-2"><SearchButton /></div>

    <nav class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4" aria-label={i18n.t('common.navigation')}>
      <div class="flex flex-col gap-px">
        {#each views as item (item.view)}{@render viewItem(item)}{/each}
      </div>

      <section class="mt-4 rounded-[var(--r-md)]" aria-label={i18n.t('navigation.folder')}>
        <div class="group/head flex items-center justify-between pr-1">
          <SectionLabel>{i18n.t('navigation.folder')}</SectionLabel>
          <IconButton
            label={i18n.t('common.new_folder')}
            title={i18n.t('common.new_folder')}
            size="sm"
            disabled={busy}
            onclick={() => void edit('folder')}
            class="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100"
            ><FolderPlus size={13} /></IconButton
          >
        </div>
        {#if tree.length}<ul role="tree" aria-label={i18n.t('navigation.folder')} class="mt-0.5 flex flex-col gap-px">
            {@render folders(tree)}
          </ul>{:else}<button
            type="button"
            disabled={busy}
            onclick={() => void edit('folder')}
            class="mt-0.5 flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-[12px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] disabled:pointer-events-none disabled:opacity-45 md:h-[30px]"
            ><FolderPlus size={13} />{i18n.t('sidebar.create_first_folder')}</button
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
            class="mt-1 flex h-[30px] w-full items-center justify-center rounded-[var(--r-md)] border border-dashed border-[var(--border-default)] text-[11.5px] text-[var(--text-tertiary)]"
            >{i18n.t('folders.drop_top_level')}</button
          >{/if}
      </section>

      <section class="mt-4" aria-label={i18n.t('navigation.tag')}>
        <div class="group/head flex items-center justify-between pr-1">
          <SectionLabel>{i18n.t('navigation.tag')}</SectionLabel>
          <IconButton
            label={i18n.t('tags.new')}
            title={i18n.t('tags.new')}
            size="sm"
            disabled={busy}
            onclick={() => void edit('tag')}
            class="opacity-100 transition-opacity md:opacity-0 md:group-hover/head:opacity-100 md:focus-visible:opacity-100"
            ><Plus size={13} /></IconButton
          >
        </div>
        <div class="mt-0.5 flex flex-col gap-px">
          {#if !snapshot.tags.length}<button
              type="button"
              onclick={() => void edit('tag')}
              class="flex h-10 w-full items-center gap-2 rounded-[var(--r-md)] px-2 text-left text-[11.5px] text-[var(--text-quaternary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] md:h-[30px]"
              ><Plus size={13} />{i18n.t('tags.create_first')}</button
            >{/if}
          {#each snapshot.tags as tag (tag.id)}
            {@const active = ui.filter.view === 'tag' && ui.filter.tag === tag.name}
            <div
              role="presentation"
              class={[
                'group relative flex h-10 items-center gap-2 rounded-[var(--r-md)] px-2 md:h-[30px]',
                'transition-colors duration-[var(--dur-fast)]',
                active
                  ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
              ]}
              oncontextmenu={(event) => {
                event.preventDefault()
                void edit('tag', tag.id)
              }}
            >
              <Hash
                size={13}
                class="shrink-0"
                style={`color: ${organizerColorOrNull(tag.color) ?? (active ? 'var(--accent)' : 'var(--text-quaternary)')}`}
              />
              <button
                type="button"
                aria-current={active ? 'page' : undefined}
                onclick={() => navigate('tag', { tag: tag.name })}
                onkeydown={(event) => {
                  if (event.key === 'F2' || event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault()
                    void edit('tag', tag.id)
                  }
                }}
                class="min-w-0 flex-1 truncate py-1 text-left text-[12.5px] font-medium">{tag.name}</button
              >
              <span
                class="tabular shrink-0 text-[11px] text-[var(--text-quaternary)] transition-opacity group-hover:opacity-0"
                >{tagCounts.get(tag.name) || ''}</span
              >
              <IconButton
                label={`${i18n.t('tags.rename')}: ${tag.name}`}
                size="sm"
                onclick={() => void edit('tag', tag.id)}
                class="absolute right-1 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
                ><MoreHorizontal size={13} /></IconButton
              >
            </div>
          {/each}
        </div>
      </section>
      {#if feedback && !editorOpen}<p
          role="alert"
          class="mt-3 px-2 text-[12px] whitespace-pre-line text-[var(--danger)]"
        >
          {feedback}
        </p>{/if}
    </nav>

    <div class="flex shrink-0 flex-col gap-px border-t border-[var(--border-subtle)] px-2 py-2">
      {#each bottomViews as item (item.view)}{@render viewItem(item)}{/each}
    </div>

    <div class="shrink-0 border-t border-[var(--border-subtle)] p-2">{@render accountMenu(false)}</div>
  </aside>
{/snippet}

{#snippet railButton(label: string, Icon: Component, active: boolean, onclick: () => void, accent = false)}
  <IconButton {label} title={label} {active} {onclick} class={accent ? 'text-[var(--accent)]' : undefined}
    ><Icon size={16} /></IconButton
  >
{/snippet}

<span bind:this={anchorElement} hidden></span>

{#if narrow}
  <Drawer.Root direction="left" open={drawerOpen} onOpenChange={(open) => ui.toggleNavDrawer(open)}
    ><Drawer.Content
      class="p-0 data-[vaul-drawer-direction=left]:w-[272px] data-[vaul-drawer-direction=left]:sm:max-w-[272px]"
      ><Drawer.Title class="sr-only">{i18n.t('common.navigation')}</Drawer.Title>{@render content()}</Drawer.Content
    ></Drawer.Root
  >
{:else if ui.layout.navCollapsed}
  <aside class="flex h-full min-h-0 flex-col items-center bg-[var(--bg-sunken)]" data-testid="sidebar">
    <div class="flex h-11 w-full shrink-0 items-center justify-center border-b border-[var(--border-subtle)]">
      <IconButton
        label={i18n.t('sidebar.expand_navigation')}
        title={i18n.t('sidebar.expand_navigation')}
        onclick={() => ui.toggleNav()}><PanelLeft size={16} /></IconButton
      >
    </div>
    <div class="flex w-full flex-col items-center gap-1 py-2">
      <SearchButton variant="icon" />
      {@render railButton(i18n.t('navigation.all_notes'), FileText, ui.filter.view === 'all', () => navigate('all'))}
      {@render railButton(i18n.t('navigation.favorites'), Star, ui.filter.view === 'starred', () =>
        navigate('starred'),
      )}
      {@render railButton(i18n.t('navigation.trash'), Trash2, ui.filter.view === 'trash', () => navigate('trash'))}
      <div class="my-1 h-px w-6 bg-[var(--border-subtle)]"></div>
      {@render railButton(
        i18n.t('common.new_note'),
        FilePlus2,
        false,
        () => void newNote(ui.filter.view === 'folder' ? ui.filter.folderId : null),
        true,
      )}
    </div>
    <span class="flex-1"></span>
    <div class="flex w-full shrink-0 justify-center border-t border-[var(--border-subtle)] py-2">
      {@render accountMenu(true)}
    </div>
  </aside>
{:else}
  {@render content()}
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
            >{i18n.t(dialog === 'folder' ? (editId ? 'sidebar.rename' : 'folders.name') : 'tags.new_placeholder')}</Field.Label
          ><Input
            id={`${instanceId}-organizer-name`}
            bind:ref={nameInput}
            bind:value={name}
            required
            maxlength={dialog === 'folder' ? LIMITS.folderNameMaxLength : LIMITS.tagNameMaxLength}
          /></Field.Field
        >
        <Field.Field
          ><Field.Label id={`${instanceId}-organizer-color`}>{i18n.t('folders.color')}</Field.Label>
          <div role="radiogroup" aria-labelledby={`${instanceId}-organizer-color`} class="grid w-fit grid-cols-6 gap-2">
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
                class="flex size-7 items-center justify-center rounded-full border border-dashed border-[var(--border-strong)] text-[var(--text-quaternary)] transition-transform hover:scale-110 peer-checked:ring-2 peer-checked:ring-[var(--accent)] peer-checked:ring-offset-2 peer-checked:ring-offset-[var(--bg-overlay)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)]"
                ><X size={12} /></span
              >
            </label>
            {#each ORGANIZER_COLORS as value (value)}
              {@const label = i18n.t(`folders.color_${ORGANIZER_COLOR_NAMES[value]}` as MessageKey)}
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
                  class="flex size-7 items-center justify-center rounded-full text-white transition-transform hover:scale-110 peer-checked:ring-2 peer-checked:ring-[var(--accent)] peer-checked:ring-offset-2 peer-checked:ring-offset-[var(--bg-overlay)] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--accent)]"
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
            ><Field.Label id={`${instanceId}-organizer-icon-label`}>{i18n.t('folders.icon')}</Field.Label>
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
                  class="flex h-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-tertiary)] hover:bg-[var(--bg-hover)] peer-checked:bg-[var(--accent-soft)] peer-checked:ring-1 peer-checked:ring-[var(--accent)] peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--accent)]"
                  style:color={organizerColorOrNull(color) ?? undefined}><FolderClosed size={15} /></span
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
                    class="flex h-8 items-center justify-center rounded-[var(--r-md)] text-[15px] leading-none hover:bg-[var(--bg-hover)] peer-checked:bg-[var(--accent-soft)] peer-checked:ring-1 peer-checked:ring-[var(--accent)] peer-focus-visible:outline-2 peer-focus-visible:outline-[var(--accent)]"
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
