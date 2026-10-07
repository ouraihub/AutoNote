<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { ListNotesQuery, NoteSummary, PatchNoteBody, ViewKind } from '@shared/types'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import { folderPath, selectVisibleNotes } from '@app/state/selectors'
  import { organizerColorOrNull } from '@shared/organizer-colors'
  import { breakpoint } from '@app/lib/breakpoint.svelte'
  import { getBackend, getExtensions, getI18n, getNotes, getNotifier, getUi } from '@app/root/context'
  import { Button } from '@app/components/ui/button'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import * as Field from '@app/components/ui/field'
  import * as Dialog from '@app/components/ui/dialog'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Logo from '@app/components/primitives/Logo.svelte'
  import { ArrowDownWideNarrow, MoreHorizontal, PanelLeft, Pin, Plus, Search, Star, X } from '@lucide/svelte'
  import Empty, { type EmptyArt } from '@app/components/primitives/Empty.svelte'
  import { prettyCombo } from '@app/lib/hotkeys'
  import { appendPage, NOTE_DRAG_TYPE, runNoteBatch, type BatchResult } from './actions'

  const layout = $derived(breakpoint())
  const notes = getNotes(),
    ui = getUi(),
    backend = getBackend(),
    notifier = getNotifier(),
    i18n = getI18n(),
    extensions = getExtensions()
  const PAGE_SIZE = 80
  const instanceId = $props.id()
  const labels: Record<ViewKind, MessageKey> = {
    all: 'navigation.all_notes',
    recent: 'navigation.recently_edited',
    starred: 'navigation.favorites',
    unfiled: 'navigation.unfiled',
    archived: 'navigation.archive',
    trash: 'navigation.trash',
    folder: 'navigation.folder',
    tag: 'navigation.tag',
  }
  const shortcut = (combo: string) => prettyCombo(combo).join('+')
  const emptyStates: Record<ViewKind, { art: EmptyArt; title: MessageKey; description: MessageKey; combo?: string }> = {
    all: {
      art: 'notes',
      title: 'notes.no_notes_yet',
      description: 'notes.press_shortcut_or_the_plus_button_to_write_your_first_note',
      combo: 'mod+n',
    },
    recent: {
      art: 'notes',
      title: 'notes.nothing_has_been_edited_recently',
      description: 'notes.write_something_and_it_will_appear_here',
    },
    starred: {
      art: 'starred',
      title: 'notes.no_favorites_yet',
      description: 'notes.right_click_a_note_or_press_shortcut_to_favorite_it',
      combo: 'mod+d',
    },
    unfiled: { art: 'folder', title: 'notes.every_note_is_filed', description: 'notes.everything_is_neatly_organized' },
    archived: {
      art: 'archive',
      title: 'notes.archive_is_empty',
      description: 'notes.keep_notes_here_when_you_want_them_out_of_the_way_but_not_deleted',
    },
    trash: {
      art: 'trash',
      title: 'notes.trash_is_empty',
      description: 'notes.deleted_notes_remain_until_you_restore_or_clear_them',
    },
    folder: { art: 'folder', title: 'notes.this_folder_is_still_empty', description: 'notes.drag_notes_in_or_create_new_ones_here' },
    tag: {
      art: 'tag',
      title: 'notes.there_are_no_notes_with_this_tag',
      description: 'notes.write_tags_in_the_note_to_link_them_automatically',
    },
  }
  const emptyState = $derived(emptyStates[ui.filter.view])
  const snapshot = $derived(notes.readOrganizeSnapshot())
  const projection = $derived(
    selectVisibleNotes(notes.summaries, snapshot.folders, {
      ...ui.filter,
      sort: ui.sort,
      order: ui.order,
      locale: i18n.locale,
    }),
  )
  const title = $derived(
    ui.filter.view === 'folder'
      ? folderPath(snapshot.folders, ui.filter.folderId)
          .map((folder) => folder.name)
          .join(' / ')
      : ui.filter.view === 'tag'
        ? `#${ui.filter.tag}`
        : i18n.t(labels[ui.filter.view]),
  )
  let filter = $state('')
  let filterLimit = $state(PAGE_SIZE)
  let pages = $state.raw<NoteSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let loading = $state(false)
  let pageError = $state('')
  let refresh = $state(0)
  let focused = $state<string | null>(null)
  let anchor: string | null = null
  let listbox = $state<HTMLDivElement>()
  let busy = $state(false)
  let results = $state.raw<BatchResult[]>([])
  let resultTitles = $state.raw<Record<string, string>>({})
  let moveOpen = $state(false)
  let moveIds: readonly string[] = []
  let destination = $state('')
  let generation = 0
  let controller: AbortController | undefined
  let usedCursors = $state.raw(new SvelteSet<string>())
  let previousQuery = ''
  const query = $derived<ListNotesQuery>({
    view: ui.filter.view,
    ...(ui.filter.folderId ? { folderId: ui.filter.folderId } : {}),
    ...(ui.filter.tag ? { tag: ui.filter.tag } : {}),
    sort: ui.sort,
    order: ui.order,
    limit: PAGE_SIZE,
  })
  const filtered = $derived(
    projection.filter((note) =>
      `${note.title} ${note.excerpt} ${note.tags.join(' ')}`
        .toLocaleLowerCase(i18n.locale)
        .includes(filter.trim().toLocaleLowerCase(i18n.locale)),
    ),
  )
  const paged = $derived.by(() => {
    const current: Record<string, NoteSummary> = {}
    for (const pageNote of pages) {
      const note = notes.summaries[pageNote.id]
      if (note) current[note.id] = note
    }
    return selectVisibleNotes(current, snapshot.folders, {
      ...ui.filter,
      sort: ui.sort,
      order: ui.order,
      locale: i18n.locale,
    })
  })
  const displayed = $derived(filter.trim() ? filtered.slice(0, filterLimit) : paged)
  const positions = $derived(new Map(filtered.map((note, index) => [note.id, index + 1])))
  const selected = $derived(ui.selection.filter((id) => positions.has(id)))

  $effect(() => {
    const currentQuery = query
    void refresh
    void notes.cursor
    const localFilter = filter.trim()
    const requestGeneration = ++generation
    controller?.abort()
    const requestController = new AbortController()
    controller = requestController
    const signal = requestController.signal
    untrack(() => {
      nextCursor = null
      pageError = ''
      usedCursors.clear()
      const key = JSON.stringify(currentQuery)
      if (key !== previousQuery) pages = []
      previousQuery = key
      if (localFilter) loading = false
      else void loadPage(currentQuery, null, requestGeneration, signal, Math.max(PAGE_SIZE, pages.length))
    })
    return () => requestController.abort()
  })
  $effect(() => {
    void ui.filter
    untrack(() => {
      filter = ''
      filterLimit = PAGE_SIZE
      results = []
      anchor = null
    })
  })
  $effect(() => {
    void filter
    untrack(() => {
      filterLimit = PAGE_SIZE
    })
  })
  $effect(() => {
    const available = displayed.map((note) => note.id)
    const pending = loading
    untrack(() => {
      if (!pending && !available.includes(focused ?? ''))
        focused = available.includes(ui.activeNoteId ?? '') ? ui.activeNoteId : (available[0] ?? null)
    })
  })
  async function loadPage(
    currentQuery: ListNotesQuery,
    cursor: string | null,
    requestGeneration: number,
    signal: AbortSignal,
    targetSize = PAGE_SIZE,
  ): Promise<void> {
    loading = true
    pageError = ''
    try {
      let accumulated = cursor ? pages : []
      let pageCursor = cursor
      do {
        const page = await backend.notes.list(
          { ...currentQuery, ...(pageCursor ? { cursor: pageCursor } : {}) },
          { signal },
        )
        if (signal.aborted || requestGeneration !== generation) return
        if (page.nextCursor && usedCursors.has(page.nextCursor))
          throw new Error(i18n.t('notes.sync_pagination_data_is_incomplete'))
        accumulated = appendPage(accumulated, page, pageCursor)
        if (pageCursor) usedCursors.add(pageCursor)
        pageCursor = page.nextCursor
      } while (pageCursor && accumulated.length < targetSize)
      pages = accumulated
      nextCursor = pageCursor
    } catch (error) {
      if (!signal.aborted && requestGeneration === generation) pageError = errorText(error)
    } finally {
      if (requestGeneration === generation) loading = false
    }
  }
  function errorText(error: unknown): string {
    return isBackendError(error)
      ? i18n.t(messageKeyForError(error.code))
      : error instanceof Error
        ? error.message
        : i18n.t('common.action_failed')
  }
  async function loadMore(): Promise<void> {
    if (filter.trim()) {
      filterLimit += PAGE_SIZE
      return
    }
    if (!loading && nextCursor && controller) await loadPage(query, nextCursor, generation, controller.signal)
  }
  async function open(id: string, secondary = false): Promise<void> {
    try {
      ui.openNote(id, secondary ? { pane: 'secondary' } : {})
      extensions.onNoteOpened?.(id)
      await notes.open(id, ui.activePane)
    } catch (error) {
      pageError = errorText(error)
    }
  }
  async function create(): Promise<void> {
    if (busy) return
    busy = true
    try {
      const note = await notes.create({
        folderId: ui.filter.view === 'folder' ? ui.filter.folderId : null,
        ...(ui.filter.view === 'tag' ? { content: `#${ui.filter.tag}\n` } : {}),
      })
      refresh++
      await open(note.id)
    } catch (error) {
      pageError = errorText(error)
    } finally {
      busy = false
    }
  }
  function select(id: string, range: boolean, additive: boolean): void {
    focused = id
    if (range) {
      const ids = filtered.map((note) => note.id),
        to = ids.indexOf(id)
      if (to < 0) return
      const anchorIndex = ids.indexOf(anchor ?? ui.selection[0] ?? id),
        from = anchorIndex < 0 ? to : anchorIndex
      ui.setSelection(ids.slice(Math.min(from, to), Math.max(from, to) + 1))
    } else {
      anchor = id
      ui.toggleSelected(id, additive)
    }
  }
  async function keyboard(event: KeyboardEvent): Promise<void> {
    if (
      event.target !== listbox &&
      !(event.target instanceof HTMLElement && event.target.getAttribute('role') === 'option')
    )
      return
    const ids = displayed.map((note) => note.id)
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      ui.setSelection(filtered.map((note) => note.id))
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      ui.setSelection([])
      return
    }
    if (event.key === 'Enter' && focused) {
      event.preventDefault()
      await open(focused, event.altKey)
      return
    }
    if (event.key === ' ' && focused) {
      event.preventDefault()
      select(focused, event.shiftKey, true)
      return
    }
    if (((event.key === 'F10' && event.shiftKey) || event.key === 'ContextMenu') && focused) {
      event.preventDefault()
      document.getElementById(optionId(focused))?.querySelector<HTMLButtonElement>('[data-note-menu]')?.click()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !ids.length) return
    event.preventDefault()
    const index = ids.indexOf(focused ?? '')
    const next =
      event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1)
    const id = ids[Math.max(0, Math.min(ids.length - 1, next))]
    if (id === undefined) return
    if (event.shiftKey && anchor === null) anchor = focused ?? id
    focused = id
    if (event.shiftKey) select(id, true, false)
    await tick()
    document.getElementById(optionId(id))?.scrollIntoView?.({ block: 'nearest' })
  }
  function optionId(id: string): string {
    return `${instanceId}-note-${encodeURIComponent(id)}`
  }
  function group(note: NoteSummary): string {
    if (note.isPinned && ui.filter.view !== 'trash' && ui.filter.view !== 'recent') return i18n.t('notes.pin')
    if (ui.sort === 'title' && !['recent', 'trash'].includes(ui.filter.view)) return i18n.t('notes.other')
    const timestamp =
      ui.filter.view === 'trash'
        ? (note.deletedAt ?? note.updatedAt)
        : ui.filter.view === 'recent' || ui.sort === 'updated'
          ? note.updatedAt
          : note.createdAt
    return i18n.formatDate(timestamp, { year: 'numeric', month: 'short', day: 'numeric' })
  }
  type Action =
    'star' | 'unstar' | 'pin' | 'unpin' | 'archive' | 'unarchive' | 'trash' | 'restore' | 'purge' | 'move' | 'duplicate'
  async function batch(action: Action, ids: readonly string[], folderId: string | null = null): Promise<void> {
    if (busy || !ids.length) return
    busy = true
    results = []
    const titles = Object.fromEntries(
      ids.map((id) => [id, notes.summaries[id]?.title || i18n.t('common.untitled_note')]),
    )
    try {
      const outcome = await runNoteBatch(
        ids,
        () =>
          action === 'trash' || action === 'purge'
            ? notifier.confirm({
                titleKey: action === 'trash' ? 'common.move_to_trash' : 'notes.delete_permanently',
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
          if (!note) throw new Error(i18n.t('notes.this_note_no_longer_exists'))
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
            if (action === 'star' || action === 'unstar') patch.isStarred = action === 'star'
            if (action === 'pin' || action === 'unpin') patch.isPinned = action === 'pin'
            if (action === 'archive' || action === 'unarchive') patch.isArchived = action === 'archive'
            if (action === 'move') patch.folderId = folderId
            await notes.patch(id, patch)
          }
        },
        i18n.t('common.changes_not_saved'),
      )
      if (outcome.length) {
        resultTitles = titles
        results = outcome
        const failures = outcome.filter((result) => result.error !== null).map((result) => result.id)
        ui.setSelection(failures)
        refresh++
      }
    } catch (error) {
      pageError = errorText(error)
    } finally {
      busy = false
      listbox?.focus()
    }
  }
  function move(ids: readonly string[]): void {
    moveIds = [...ids]
    destination = ''
    moveOpen = true
  }
  function startDrag(event: DragEvent, id: string): void {
    if (busy || ui.filter.view === 'trash' || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    const ids = selected.includes(id) ? selected : [id]
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(NOTE_DRAG_TYPE, JSON.stringify({ source: `${instanceId}-listbox`, ids }))
  }
</script>

{#snippet sortMenu(iconSize: number, triggerClass = '')}
  <DropdownMenu.Root
    ><DropdownMenu.Trigger
      title={i18n.t('notes.sort_and_display')}
      aria-label={i18n.t('notes.sort_and_display')}
      class={[
        'inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-6',
        triggerClass,
      ]}><ArrowDownWideNarrow size={iconSize} /></DropdownMenu.Trigger
    ><DropdownMenu.Content
      ><DropdownMenu.Group>
        {#if ui.filter.view === 'recent' || ui.filter.view === 'trash'}<DropdownMenu.Item disabled
            >{i18n.t(
              ui.filter.view === 'trash' ? 'notes.recently_deleted_first' : 'notes.recently_edited_first',
            )}</DropdownMenu.Item
          >{:else}
          <DropdownMenu.Item onclick={() => ui.setSort('updated')}>{i18n.t('notes.modified')}</DropdownMenu.Item
          ><DropdownMenu.Item onclick={() => ui.setSort('created')}>{i18n.t('notes.created')}</DropdownMenu.Item
          ><DropdownMenu.Item onclick={() => ui.setSort('title', 'asc')}>{i18n.t('notes.title')}</DropdownMenu.Item
          ><DropdownMenu.Item onclick={() => ui.setSort(ui.sort, ui.order === 'asc' ? 'desc' : 'asc')}
            >{i18n.t(ui.order === 'desc' ? 'notes.sort_ascending' : 'notes.sort_descending')}</DropdownMenu.Item
          >
        {/if}
        <DropdownMenu.Item onclick={() => ui.setDensity(ui.layout.density === 'compact' ? 'comfortable' : 'compact')}
          >{i18n.t(ui.layout.density === 'compact' ? 'notes.comfortable_list' : 'notes.compact_list')}</DropdownMenu.Item
        >
      </DropdownMenu.Group></DropdownMenu.Content
    ></DropdownMenu.Root
  >
{/snippet}

{#snippet actions(ids: readonly string[], inTrash: boolean)}
  <DropdownMenu.Group>
    {#if inTrash}
      <DropdownMenu.Item disabled={busy} onclick={() => void batch('restore', ids)}
        >{i18n.t('common.restore')}</DropdownMenu.Item
      >
      <DropdownMenu.Item variant="destructive" disabled={busy} onclick={() => void batch('purge', ids)}
        >{i18n.t('notes.delete_permanently')}</DropdownMenu.Item
      >
    {:else}
      <DropdownMenu.Item
        disabled={busy}
        onclick={() => void batch(ids.every((id) => notes.summaries[id]?.isStarred) ? 'unstar' : 'star', ids)}
        >{i18n.t(
          ids.every((id) => notes.summaries[id]?.isStarred) ? 'common.remove_from_favorites' : 'navigation.favorites',
        )}</DropdownMenu.Item
      >
      <DropdownMenu.Item
        disabled={busy}
        onclick={() => void batch(ids.every((id) => notes.summaries[id]?.isPinned) ? 'unpin' : 'pin', ids)}
        >{i18n.t(ids.every((id) => notes.summaries[id]?.isPinned) ? 'notes.unpin' : 'notes.pin')}</DropdownMenu.Item
      >
      <DropdownMenu.Item disabled={busy} onclick={() => move(ids)}>{i18n.t('notes.move_to_folder')}</DropdownMenu.Item>
      <DropdownMenu.Item
        disabled={busy}
        onclick={() => void batch(ids.every((id) => notes.summaries[id]?.isArchived) ? 'unarchive' : 'archive', ids)}
        >{i18n.t(
          ids.every((id) => notes.summaries[id]?.isArchived) ? 'common.unarchive' : 'navigation.archive',
        )}</DropdownMenu.Item
      >
      <DropdownMenu.Item disabled={busy} onclick={() => void batch('duplicate', ids)}
        >{i18n.t('notes.create_a_copy')}</DropdownMenu.Item
      >
      <DropdownMenu.Item variant="destructive" disabled={busy} onclick={() => void batch('trash', ids)}
        >{i18n.t('common.move_to_trash')}</DropdownMenu.Item
      >
    {/if}
  </DropdownMenu.Group>
{/snippet}

<section
  class={[
    'relative flex h-full min-h-0 flex-col border-r border-[var(--border-subtle)] bg-[var(--bg-base)]',
    layout === 'mobile' && 'mobile-note-list',
  ]}
  data-testid="note-list"
>
  <header class="shrink-0 px-3 pt-3 pb-2">
    {#if layout === 'mobile'}
      <div class="mobile-library-brand"><Logo size={22} /><span>{i18n.t('common.product_name')}</span></div>
    {:else}
      <div class="mb-2.5 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <h2 class="truncate text-[14.5px] font-semibold tracking-[-0.016em] text-[var(--text-primary)]">{title}</h2>
          {#if ui.filter.view === 'folder'}<p class="mt-0.5 truncate text-[10.5px] text-[var(--text-quaternary)]">
              {i18n.t('folders.includes_subfolders')}
            </p>{/if}
        </div>
        <div class="flex shrink-0 items-center gap-0.5">
          {#if layout === 'tablet'}<IconButton
              label={i18n.t('notes.open_navigation')}
              title={i18n.t('notes.open_navigation')}
              size="sm"
              onclick={() => ui.toggleNavDrawer(true)}><PanelLeft size={14} /></IconButton
            >{/if}
          {@render sortMenu(14)}
          {#if ui.filter.view !== 'trash' && ui.filter.view !== 'archived'}<IconButton
              label={i18n.t('common.new_note')}
              title={i18n.t('common.new_note')}
              size="sm"
              disabled={busy}
              onclick={() => void create()}><Plus size={15} /></IconButton
            >{/if}
        </div>
      </div>
    {/if}
    {#if layout === 'mobile'}
      <div class="mobile-library-toolbar">
        <div class="mobile-note-search relative">
          <Search
            size={15}
            class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-[var(--text-quaternary)]"
          />
          <input
            id={`${instanceId}-filter`}
            type="search"
            aria-label={i18n.t('notes.filter_in_this_view')}
            bind:value={filter}
            onkeydown={(event) => {
              if (event.key === 'Escape') filter = ''
            }}
            placeholder={i18n.t('notes.filter_in_this_view')}
            class="h-10 w-full rounded-[var(--r-md)] border border-transparent bg-[var(--bg-inset)] pr-9 pl-8 text-[12.5px] text-[var(--text-primary)] transition-[border-color,box-shadow] duration-[var(--dur-fast)] placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent)] focus:shadow-[0_0_0_3px_var(--accent-ring)] focus:outline-none md:h-[30px] md:pr-7 md:pl-7"
          />
          {#if filter}<button
              type="button"
              onclick={() => (filter = '')}
              aria-label={i18n.t('notes.clear_filters')}
              class="absolute top-1/2 right-1 flex size-8 -translate-y-1/2 items-center justify-center rounded text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]"
              ><X size={12} /></button
            >{/if}
        </div>
        {@render sortMenu(17, 'mobile-library-sort')}
        {#if ui.filter.view !== 'trash' && ui.filter.view !== 'archived'}<IconButton
            label={i18n.t('common.new_note')}
            size="sm"
            class="mobile-library-compose"
            disabled={busy}
            onclick={() => void create()}><Plus size={19} /></IconButton
          >{/if}
      </div>
    {/if}
    {#if ui.filter.view === 'trash' && projection.length}<button
        type="button"
        disabled={busy}
        aria-busy={busy}
        onclick={() =>
          void batch(
            'purge',
            projection.map((note) => note.id),
          )}
        class="mt-2 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] py-1.5 text-[11.5px] text-[var(--text-tertiary)] transition-colors hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:pointer-events-none disabled:opacity-50"
        >{i18n.t('common.empty_trash')} ({projection.length})</button
      >{/if}
  </header>
  <div
    id={`${instanceId}-listbox`}
    bind:this={listbox}
    role="listbox"
    aria-label={title}
    aria-multiselectable="true"
    aria-busy={loading || busy}
    aria-activedescendant={focused && displayed.some((note) => note.id === focused) ? optionId(focused) : undefined}
    tabindex={0}
    onkeydown={(event) => void keyboard(event)}
    class="anim-view-content min-h-0 flex-1 overflow-y-auto px-2 pb-4 outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] focus-visible:ring-inset"
  >
    {#each displayed as note, index (note.id)}
      {@const previous = displayed[index - 1]}
      {@const active = ui.activeNoteId === note.id}
      {@const selected = ui.selection.includes(note.id)}
      {#if !previous || group(previous) !== group(note)}<div
          role="presentation"
          class="px-2 pt-3 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
        >
          {group(note)}
        </div>{/if}
      <DropdownMenu.Root>
        <!-- Keyboard input is owned by the parent listbox (aria-activedescendant), like AutoNote. -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div
          id={optionId(note.id)}
          role="option"
          tabindex={-1}
          draggable={!busy && note.deletedAt === null}
          ondragstart={(event) => startDrag(event, note.id)}
          aria-selected={selected}
          aria-label={note.title || i18n.t('common.untitled_note')}
          aria-posinset={positions.get(note.id) ?? index + 1}
          aria-setsize={filtered.length}
          style:content-visibility="auto"
          style:contain-intrinsic-size={ui.layout.density === 'compact' ? 'auto 42px' : 'auto 72px'}
          class={[
            'motion-note-row group relative mb-px cursor-default rounded-[var(--r-md)] border border-transparent px-2.5 pr-11 transition-[background-color,border-color,box-shadow,transform] duration-[var(--dur-fast)] md:pr-10',
            ui.layout.density === 'compact' ? 'py-[7px]' : 'py-2.5',
            selected && !active
              ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
              : active
                ? 'border-[var(--border-default)] bg-[var(--bg-surface)] shadow-[var(--shadow-sm)]'
                : 'hover:bg-[var(--bg-hover)]',
            focused === note.id && 'outline outline-1 -outline-offset-1 outline-[var(--accent)]',
          ]}
          onclick={(event) => {
            select(note.id, event.shiftKey && !event.altKey, event.ctrlKey || event.metaKey)
            if (!event.ctrlKey && !event.metaKey) void open(note.id, event.shiftKey || event.altKey)
            listbox?.focus()
          }}
          oncontextmenu={(event) => {
            event.preventDefault()
            focused = note.id
            event.currentTarget.querySelector<HTMLButtonElement>('[data-note-menu]')?.click()
          }}
        >
          <div class="flex items-start gap-1.5">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                {#if note.isPinned}<Pin size={10} class="anim-mark-enter shrink-0 text-[var(--accent)]" />{/if}
                <h3
                  class={[
                    'min-w-0 flex-1 truncate text-[13px] leading-snug',
                    active ? 'font-semibold text-[var(--accent)]' : 'font-medium text-[var(--text-primary)]',
                  ]}
                >
                  {note.title || i18n.t('common.untitled_note')}
                </h3>
                {#if note.isStarred}<Star
                    size={10}
                    class="anim-mark-enter shrink-0 fill-current text-[var(--warning)]"
                  />{/if}
              </div>
              {#if ui.layout.density !== 'compact' && note.excerpt}<p
                  class="truncate-2 mt-1 text-[11.5px] leading-[1.5] text-[var(--text-tertiary)]"
                >
                  {note.excerpt}
                </p>{/if}
              {#if ui.layout.density !== 'compact' && note.tags.length}<div
                  class="mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden text-[10.5px] whitespace-nowrap text-[var(--text-tertiary)]"
                >
                  {#each note.tags as tag (tag)}<span
                      class="max-w-[70%] shrink-0 truncate"
                      style:color={organizerColorOrNull(snapshot.tags.find((item) => item.name === tag)?.color)}
                      >#{tag}</span
                    >{/each}
                </div>{/if}
            </div>
          </div>
          <DropdownMenu.Trigger
            data-note-menu
            tabindex={-1}
            title={i18n.t('common.more_actions')}
            onclick={(event) => event.stopPropagation()}
            class="absolute top-1.5 right-1.5 inline-flex size-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] opacity-100 transition-opacity hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] md:size-6 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
            aria-label={`${i18n.t('common.more_actions')}: ${note.title}`}><MoreHorizontal size={14} /></DropdownMenu.Trigger
          >
        </div>
        <DropdownMenu.Content
          ><DropdownMenu.Group
            ><DropdownMenu.Item onclick={() => void open(note.id)}>{i18n.t('common.open')}</DropdownMenu.Item
            ><DropdownMenu.Item onclick={() => void open(note.id, true)}
              >{i18n.t('notes.open_to_side')}</DropdownMenu.Item
            ><DropdownMenu.Item onclick={() => select(note.id, false, true)}
              >{i18n.t(selected ? 'notes.deselect' : 'notes.add_to_selection')}</DropdownMenu.Item
            ></DropdownMenu.Group
          ><DropdownMenu.Separator />{@render actions([note.id], note.deletedAt !== null)}</DropdownMenu.Content
        >
      </DropdownMenu.Root>
    {/each}
    {#if !displayed.length && !loading}
      {#if filter.trim()}<Empty
          art="search"
          title={i18n.t('notes.no_matching_notes')}
          description={i18n.t('notes.try_another_search_or_press_shortcut_to_search_everywhere', {
            shortcut: shortcut('mod+k'),
          })}
        />{:else}<Empty
          art={emptyState.art}
          title={i18n.t(emptyState.title as MessageKey)}
          description={i18n.t(emptyState.description as MessageKey, emptyState.combo ? { shortcut: shortcut(emptyState.combo) } : {})}
        >
          {#snippet action()}
            {#if ui.filter.view !== 'trash' && ui.filter.view !== 'archived'}<button
                type="button"
                disabled={busy}
                onclick={() => void create()}
                class="inline-flex h-8 items-center gap-1.5 rounded-[var(--r-md)] border border-[var(--border-default)] px-3 text-[12.5px] text-[var(--text-secondary)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                ><Plus size={13} />{i18n.t('common.new_note')}</button
              >{/if}
          {/snippet}
        </Empty>{/if}
    {/if}
    {#if loading}<p role="status" class="px-2 py-3 text-[11.5px] text-[var(--text-quaternary)]">
        {i18n.t('common.loading')}
      </p>{/if}
    {#if pageError}<p role="alert" class="px-2 py-2 text-[11.5px] text-[var(--danger)]">{pageError}</p>
      <button
        type="button"
        onclick={() => refresh++}
        class="mx-2 rounded-[var(--r-md)] border border-[var(--border-subtle)] px-3 py-1 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
        >{i18n.t('common.retry')}</button
      >{/if}
    {#if (filter.trim() && displayed.length < filtered.length) || (!filter.trim() && nextCursor)}<button
        type="button"
        disabled={loading}
        onclick={() => void loadMore()}
        class="mt-2 w-full rounded-[var(--r-md)] border border-[var(--border-subtle)] py-1.5 text-[11.5px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >{i18n.t('notes.load_more')}</button
      >{/if}
  </div>
  {#if selected.length >= 2}<div class="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-center pb-3">
      <div
        class="anim-rise pointer-events-auto flex items-center gap-1 rounded-[var(--r-lg)] border border-[var(--border-default)] bg-[var(--bg-overlay)] p-1 pl-3 shadow-[var(--shadow-pop)]"
      >
        <span class="mr-1 text-[12px] font-medium text-[var(--text-secondary)] tabular-nums"
          >{i18n.t('notes.selected')}{selected.length}{i18n.t('notes.notes')}</span
        >
        <DropdownMenu.Root
          ><DropdownMenu.Trigger
            disabled={busy}
            title={i18n.t('common.more_actions')}
            aria-label={i18n.t('common.more_actions')}
            class="inline-flex size-8 items-center justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] disabled:opacity-40 md:size-6"
            ><MoreHorizontal size={13} /></DropdownMenu.Trigger
          ><DropdownMenu.Content>{@render actions(selected, ui.filter.view === 'trash')}</DropdownMenu.Content
          ></DropdownMenu.Root
        >
        <span class="mx-0.5 h-4 w-px bg-[var(--border-subtle)]"></span>
        <IconButton
          label={i18n.t('notes.deselect')}
          title={i18n.t('notes.deselect')}
          size="sm"
          disabled={busy}
          onclick={() => ui.setSelection(ui.activeNoteId ? [ui.activeNoteId] : [])}><X size={13} /></IconButton
        >
      </div>
    </div>{/if}
  {#if results.length}<div
      role="status"
      aria-live="polite"
      class="max-h-32 overflow-auto border-t border-[var(--border-default)] p-2 text-sm"
    >
      <p>
        {i18n.t('notes.batch_result', {
          success: results.filter((result) => result.error === null).length,
          failed: results.filter((result) => result.error !== null).length,
        })}
      </p>
      {#each results.filter((result) => result.error !== null) as result (result.id)}<p class="text-destructive">
          {resultTitles[result.id]} ({result.id}): {errorText(result.error)}
        </p>{/each}
    </div>{/if}
</section>

<Dialog.Root bind:open={moveOpen}
  ><Dialog.Content
    ><Dialog.Header><Dialog.Title>{i18n.t('notes.move_to_folder')}</Dialog.Title></Dialog.Header><Field.Field
      ><Field.Label for={`${instanceId}-move-folder`}>{i18n.t('navigation.folder')}</Field.Label><select
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
      ><Button variant="outline" onclick={() => (moveOpen = false)}>{i18n.t('common.cancel')}</Button><Button
        disabled={busy}
        onclick={() => {
          moveOpen = false
          void batch('move', moveIds, destination || null)
        }}>{i18n.t('common.save')}</Button
      ></Dialog.Footer
    ></Dialog.Content
  ></Dialog.Root
>
