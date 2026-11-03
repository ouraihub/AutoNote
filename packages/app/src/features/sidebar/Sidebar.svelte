<script lang="ts">
  import type { Component } from 'svelte'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { ViewKind } from '@shared/types'
  import {
    buildFolderTree,
    folderPath,
    selectNavigation,
  } from '@app/state/selectors'
  import { folderMoveError } from './tree'
  import { NOTE_DRAG_TYPE, runNoteBatch } from '../list/actions'
  import { AppError, errorMessageKey } from '@app/i18n/errors'
  import { logFailure } from '@app/log/logger'
  import { onMount, untrack } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import {
    Archive,
    Clock,
    FileText,
    FolderPlus,
    Inbox,
    Star,
    Trash2,
  } from '@lucide/svelte'
  import { LIMITS } from '@shared/constants'
  import { organizerColorOrNull } from '@shared/organizer-colors'
  import SectionLabel from '@app/components/primitives/SectionLabel.svelte'
  import * as Drawer from '@app/components/ui/drawer'
  import SidebarRail from './SidebarRail.svelte'
  import SidebarHeader from './SidebarHeader.svelte'
  import {
    getExtensions,
    getI18n,
    getLogger,
    getNotes,
    getNotifier,
    getOrganize,
    getSettings,
    getUi,
  } from '@app/root/context'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import SearchButton from '@app/components/primitives/SearchButton.svelte'
  import SidebarAccount from './SidebarAccount.svelte'
  import SidebarTree from './SidebarTree.svelte'
  import SidebarTags from './SidebarTags.svelte'
  import SidebarOrganizerDialog from './SidebarOrganizerDialog.svelte'
  import SidebarView from './SidebarView.svelte'

  const notes = getNotes(),
    ui = getUi(),
    organize = getOrganize(),
    i18n = getI18n(),
    extensions = getExtensions(),
    notifier = getNotifier(),
    settings = getSettings(),
    logger = getLogger()
  const instanceId = $props.id()
  const snapshot = $derived(notes.readOrganizeSnapshot())
  const navigation = $derived(selectNavigation(notes.summaries))
  const tree = $derived(
    buildFolderTree(snapshot.folders, navigation.folderCounts),
  )
  const tagCounts = $derived.by(() => {
    const counts = new SvelteMap<string, number>()
    for (const note of Object.values(notes.summaries)) {
      if (note.deletedAt === null && !note.isArchived) {
        for (const tag of note.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
      }
    }
    return counts
  })
  type ViewEntry = {
    view: ViewKind
    key: MessageKey
    icon: Component
    count?: keyof typeof navigation.counts
  }
  const views: ViewEntry[] = [
    { view: 'all', key: 'navigation.all_notes', icon: FileText, count: 'all' },
    { view: 'recent', key: 'navigation.recently_edited', icon: Clock },
    {
      view: 'starred',
      key: 'navigation.favorites',
      icon: Star,
      count: 'starred',
    },
    {
      view: 'unfiled',
      key: 'navigation.unfiled',
      icon: Inbox,
      count: 'unfiled',
    },
  ]
  const bottomViews: ViewEntry[] = [
    {
      view: 'archived',
      key: 'navigation.archive',
      icon: Archive,
      count: 'archived',
    },
    { view: 'trash', key: 'navigation.trash', icon: Trash2, count: 'trash' },
  ]
  let busy = $state(false)
  let feedback = $state('')
  let dialog = $state<'folder' | 'tag' | null>(null)
  let editId = $state<string | null>(null)
  let parentId = $state('')
  let name = $state('')
  let color = $state('')
  let icon = $state('')
  let editorOpen = $state(false)
  let narrow = $state(false)
  let anchorElement = $state<HTMLSpanElement>()
  const drawerOpen = $derived(ui.navDrawerOpen)
  const editingFolder = $derived(
    snapshot.folders.find((folder) => folder.id === editId),
  )
  const editingTag = $derived(snapshot.tags.find((tag) => tag.id === editId))
  const isDark = $derived(
    settings.current.appearance.theme === 'dark' ||
      (settings.current.appearance.theme === 'system' &&
        anchorElement?.closest<HTMLElement>('[data-app-root]')?.dataset
          .theme === 'dark'),
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
  function navigate(
    view: ViewKind,
    target: { folderId?: string; tag?: string } = {},
  ): void {
    ui.openView(view, target)
    if (narrow) ui.toggleNavDrawer(false)
  }
  async function edit(
    kind: 'folder' | 'tag',
    id: string | null = null,
    parent: string | null = null,
  ): Promise<void> {
    dialog = kind
    editId = id
    const item =
      kind === 'folder'
        ? snapshot.folders.find((folder) => folder.id === id)
        : snapshot.tags.find((tag) => tag.id === id)
    name = item?.name ?? ''
    color = organizerColorOrNull(item?.color) ?? ''
    parentId =
      kind === 'folder'
        ? (snapshot.folders.find((folder) => folder.id === id)?.parentId ??
          parent ??
          '')
        : ''
    icon =
      kind === 'folder'
        ? (snapshot.folders.find((folder) => folder.id === id)?.icon ?? '')
        : ''
    feedback = ''
    editorOpen = true
  }
  async function save(): Promise<void> {
    const value = name.trim()
    if (!value) return
    if (
      dialog === 'tag' &&
      (/[\s#]/u.test(value) || value.length > LIMITS.tagNameMaxLength)
    ) {
      feedback = i18n.t('tags.invalid_name')
      return
    }
    if (
      dialog === 'folder' &&
      editId &&
      !validateMove(editId, parentId || null)
    )
      return
    if (
      dialog === 'tag' &&
      editId &&
      snapshot.tags.some((tag) => tag.id !== editId && tag.name === value) &&
      !(await notifier.confirm({
        titleKey: 'tags.merge',
        bodyKey: 'tags.merge_description',
        danger: true,
      }))
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
          if (
            parentId &&
            folderPath(snapshot.folders, parentId).length >=
              LIMITS.folderDepthMax
          )
            throw new AppError('folders.move_depth')
          const created = await organize.createFolder(patch)
          ui.expandFolders(parentId ? [parentId] : [])
          ui.openView('folder', { folderId: created.id })
        }
      } else if (dialog === 'tag') {
        if (editId) {
          const oldName = editingTag?.name
          await organize.patchTag(editId, {
            name: value,
            color: organizerColorOrNull(color),
          })
          if (ui.filter.view === 'tag' && ui.filter.tag === oldName)
            ui.openView('tag', { tag: value })
        } else
          await organize.createTag({
            name: value,
            color: organizerColorOrNull(color),
          })
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
  async function move(
    id: string,
    parent: string | null,
    beforeId: string | null = null,
  ): Promise<void> {
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
      if (ui.filter.view === 'tag' && ui.filter.tag === oldName)
        ui.openView('all')
    }
  }
  async function rootDrop(event: DragEvent): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
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
      const root = anchorElement?.closest('[data-app-root]')
      if (
        !root ||
        ![...root.querySelectorAll('[role="listbox"]')].some(
          (list) => list.id === payload.source,
        )
      )
        return
      const ids = payload.ids
        .filter((id: unknown): id is string => typeof id === 'string')
        .filter((id) => notes.summaries[id]?.deletedAt === null)
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
            await notes.patch(id, { rev: note.rev, folderId: null })
          },
          'common.changes_not_saved',
        )
        const failures = results.filter((result) => result.error !== null)
        ui.setSelection(failures.map((result) => result.id))
        feedback = failures
          .map((result) => {
            const title =
              notes.summaries[result.id]?.title ||
              i18n.t('common.untitled_note')
            return `${title} (${result.id}): ${errorText(result.error)}`
          })
          .join('\n')
      })
    } catch (error) {
      feedback = errorText(error)
    }
  }
</script>

{#snippet content()}
  <aside
    class="flex h-full min-h-0 flex-col bg-[var(--bg-sunken)]"
    data-testid="sidebar"
  >
    <SidebarHeader {narrow} />

    <div class="shrink-0 px-2 pt-2"><SearchButton /></div>

    <nav
      class="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4"
      aria-label={i18n.t('common.navigation')}
    >
      <div class="flex flex-col gap-px">
        {#each views as item (item.view)}
          <SidebarView
            {item}
            count={item.count ? navigation.counts[item.count] : 0}
            {navigate}
            {rootDrop}
          />
        {/each}
      </div>

      <section
        class="mt-4 rounded-[var(--r-md)]"
        aria-label={i18n.t('navigation.folder')}
      >
        <div class="group/head flex items-center justify-between pr-1">
          <SectionLabel>{i18n.t('navigation.folder')}</SectionLabel>
          <IconButton
            label={i18n.t('common.new_folder')}
            title={i18n.t('common.new_folder')}
            size="sm"
            disabled={busy}
            onclick={() => void edit('folder')}
            class={'opacity-100 transition-opacity md:opacity-0 ' +
              'md:group-hover/head:opacity-100 ' +
              'md:focus-visible:opacity-100'}
            ><FolderPlus size={13} /></IconButton
          >
        </div>
        <SidebarTree
          {tree}
          folders={snapshot.folders}
          {busy}
          {navigate}
          {edit}
          {move}
          {validateMove}
          {newNote}
          {run}
          {errorText}
          setFeedback={(value) => (feedback = value)}
        />
      </section>

      <SidebarTags tags={snapshot.tags} {tagCounts} {busy} {edit} {navigate} />
      {#if feedback && !editorOpen}<p
          role="alert"
          class="mt-3 px-2 text-[12px] whitespace-pre-line text-[var(--danger)]"
        >
          {feedback}
        </p>{/if}
    </nav>

    <div
      class={'flex shrink-0 flex-col gap-px border-t ' +
        'border-[var(--border-subtle)] px-2 py-2'}
    >
      {#each bottomViews as item (item.view)}
        <SidebarView
          {item}
          count={item.count ? navigation.counts[item.count] : 0}
          {navigate}
          {rootDrop}
        />
      {/each}
    </div>

    <div class="shrink-0 border-t border-[var(--border-subtle)] p-2">
      <SidebarAccount rail={false} {isDark} />
    </div>
  </aside>
{/snippet}

<span bind:this={anchorElement} hidden></span>

{#if narrow}
  <Drawer.Root
    direction="left"
    open={drawerOpen}
    onOpenChange={(open) => ui.toggleNavDrawer(open)}
    ><Drawer.Content
      class={'p-0 data-[vaul-drawer-direction=left]:w-[272px] ' +
        'data-[vaul-drawer-direction=left]:sm:max-w-[272px]'}
      ><Drawer.Title class="sr-only">{i18n.t('common.navigation')}</Drawer.Title
      >{@render content()}</Drawer.Content
    ></Drawer.Root
  >
{:else if ui.layout.navCollapsed}
  <SidebarRail {isDark} {navigate} {newNote} />
{:else}
  {@render content()}
{/if}

<SidebarOrganizerDialog
  bind:open={editorOpen}
  bind:name
  bind:color
  bind:icon
  bind:parentId
  {dialog}
  {editId}
  {instanceId}
  {busy}
  {feedback}
  folders={snapshot.folders}
  {editingFolder}
  {editingTag}
  {save}
  {removeFolder}
  {removeTag}
/>
