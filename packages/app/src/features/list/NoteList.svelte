<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { ListNotesQuery, NoteSummary, ViewKind } from '@shared/types'
  import { AppError, errorMessageKey } from '@app/i18n/errors'
  import { folderPath, selectVisibleNotes } from '@app/state/selectors'
  import { breakpoint } from '@app/lib/breakpoint.svelte'
  import {
    getBackend,
    getExtensions,
    getI18n,
    getNotes,
    getUi,
  } from '@app/root/context'
  import {
    appendPage,
    NOTE_DRAG_TYPE,
    type NoteAction,
    type NoteActionControls,
  } from './actions'
  import NoteListHeader from './NoteListHeader.svelte'
  import NoteListStatus from './NoteListStatus.svelte'
  import NoteListActions from './NoteListActions.svelte'
  import NoteRow from './NoteRow.svelte'

  const layout = $derived(breakpoint())
  const notes = getNotes(),
    ui = getUi(),
    backend = getBackend(),
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
  let actionControls: NoteActionControls
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
  const displayed = $derived(
    filter.trim() ? filtered.slice(0, filterLimit) : paged,
  )
  const positions = $derived(
    new Map(filtered.map((note, index) => [note.id, index + 1])),
  )
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
      else
        void loadPage(
          currentQuery,
          null,
          requestGeneration,
          signal,
          Math.max(PAGE_SIZE, pages.length),
        )
    })
    return () => requestController.abort()
  })
  $effect(() => {
    void ui.filter
    untrack(() => {
      filter = ''
      filterLimit = PAGE_SIZE
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
        focused = available.includes(ui.activeNoteId ?? '')
          ? ui.activeNoteId
          : (available[0] ?? null)
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
          throw new AppError('notes.sync_pagination_data_is_incomplete')
        accumulated = appendPage(accumulated, page, pageCursor)
        if (pageCursor) usedCursors.add(pageCursor)
        pageCursor = page.nextCursor
      } while (pageCursor && accumulated.length < targetSize)
      pages = accumulated
      nextCursor = pageCursor
    } catch (error) {
      if (!signal.aborted && requestGeneration === generation)
        pageError = errorText(error)
    } finally {
      if (requestGeneration === generation) loading = false
    }
  }
  function errorText(error: unknown): string {
    return i18n.t(errorMessageKey(error))
  }
  async function loadMore(): Promise<void> {
    if (filter.trim()) {
      filterLimit += PAGE_SIZE
      return
    }
    if (!loading && nextCursor && controller)
      await loadPage(query, nextCursor, generation, controller.signal)
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
      !(
        event.target instanceof HTMLElement &&
        event.target.getAttribute('role') === 'option'
      )
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
    if (
      ((event.key === 'F10' && event.shiftKey) ||
        event.key === 'ContextMenu') &&
      focused
    ) {
      event.preventDefault()
      document
        .getElementById(optionId(focused))
        ?.querySelector<HTMLButtonElement>('[data-note-menu]')
        ?.click()
      return
    }
    if (
      !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) ||
      !ids.length
    )
      return
    event.preventDefault()
    const index = ids.indexOf(focused ?? '')
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? ids.length - 1
          : index + (event.key === 'ArrowDown' ? 1 : -1)
    const id = ids[Math.max(0, Math.min(ids.length - 1, next))]
    if (id === undefined) return
    if (event.shiftKey && anchor === null) anchor = focused ?? id
    focused = id
    if (event.shiftKey) select(id, true, false)
    await tick()
    document
      .getElementById(optionId(id))
      ?.scrollIntoView?.({ block: 'nearest' })
  }
  function optionId(id: string): string {
    return `${instanceId}-note-${encodeURIComponent(id)}`
  }
  function group(note: NoteSummary): string {
    if (
      note.isPinned &&
      ui.filter.view !== 'trash' &&
      ui.filter.view !== 'recent'
    )
      return i18n.t('notes.pin')
    if (ui.sort === 'title' && !['recent', 'trash'].includes(ui.filter.view))
      return i18n.t('notes.other')
    const timestamp =
      ui.filter.view === 'trash'
        ? (note.deletedAt ?? note.updatedAt)
        : ui.filter.view === 'recent' || ui.sort === 'updated'
          ? note.updatedAt
          : note.createdAt
    return i18n.formatDate(timestamp, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  }
  function batch(
    action: NoteAction,
    ids: readonly string[],
    folderId: string | null = null,
  ): void {
    void actionControls.batch(action, ids, folderId)
  }
  function move(ids: readonly string[]): void {
    actionControls.move(ids)
  }
  function startDrag(event: DragEvent, id: string): void {
    if (busy || ui.filter.view === 'trash' || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    const ids = selected.includes(id) ? selected : [id]
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(
      NOTE_DRAG_TYPE,
      JSON.stringify({ source: `${instanceId}-listbox`, ids }),
    )
  }
</script>

<section
  class={[
    'relative flex h-full min-h-0 flex-col border-r ' +
      'border-[var(--border-subtle)] bg-[var(--bg-base)]',
    layout === 'mobile' && 'mobile-note-list',
  ]}
  data-testid="note-list"
>
  <NoteListHeader
    {layout}
    {instanceId}
    {title}
    bind:filter
    {busy}
    {projection}
    {create}
    {batch}
  />
  <div
    id={`${instanceId}-listbox`}
    bind:this={listbox}
    role="listbox"
    aria-label={title}
    aria-multiselectable="true"
    aria-busy={loading || busy}
    aria-activedescendant={focused &&
    displayed.some((note) => note.id === focused)
      ? optionId(focused)
      : undefined}
    tabindex={0}
    onkeydown={(event) => void keyboard(event)}
    class={'anim-view-content min-h-0 flex-1 overflow-y-auto px-2 pb-4 ' +
      'outline-none focus-visible:ring-1 ' +
      'focus-visible:ring-[var(--accent)] focus-visible:ring-inset'}
  >
    {#each displayed as note, index (note.id)}
      {@const previous = displayed[index - 1]}
      {#if !previous || group(previous) !== group(note)}<div
          role="presentation"
          class={'px-2 pt-3 pb-1 text-[10.5px] font-semibold ' +
            'tracking-[0.06em] text-[var(--text-quaternary)]'}
        >
          {group(note)}
        </div>{/if}
      <NoteRow
        {note}
        id={optionId(note.id)}
        position={positions.get(note.id) ?? index + 1}
        total={filtered.length}
        focused={focused === note.id}
        {busy}
        {snapshot}
        {open}
        {select}
        focusList={() => listbox?.focus()}
        focusNote={(id) => (focused = id)}
        {startDrag}
        {batch}
        {move}
      />
    {/each}
    <NoteListStatus
      displayedCount={displayed.length}
      filteredCount={filtered.length}
      {filter}
      {loading}
      {busy}
      {pageError}
      {nextCursor}
      {create}
      retry={() => refresh++}
      {loadMore}
    />
  </div>
  <NoteListActions
    bind:this={actionControls}
    bind:busy
    {instanceId}
    {selected}
    onError={(message) => (pageError = message)}
    onChange={() => refresh++}
    focusList={() => listbox?.focus()}
  />
</section>
