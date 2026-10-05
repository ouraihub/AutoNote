<script lang="ts">
  import { tick, untrack } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { ListNotesQuery, NoteSummary, PatchNoteBody, ViewKind } from '@shared/types'
  import { isBackendError } from '@app/backend'
  import { messageKeyForError } from '@app/i18n/errors'
  import { folderPath, selectVisibleNotes } from '@app/state/selectors'
  import { getBackend, getExtensions, getI18n, getNotes, getNotifier, getUi } from '@app/root/context'
  import { Button, buttonVariants } from '@app/components/ui/button'
  import { Input } from '@app/components/ui/input'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import * as Field from '@app/components/ui/field'
  import * as Dialog from '@app/components/ui/dialog'
  import { MoreHorizontal, PanelLeft, Plus } from '@lucide/svelte'
  import { appendPage, NOTE_DRAG_TYPE, runNoteBatch, type BatchResult } from './actions'

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

<section class="flex h-full min-h-0 flex-col bg-[var(--bg-base)]" data-testid="note-list">
  <header class="flex flex-col gap-2 border-b border-[var(--border-default)] p-3">
    <div class="flex items-center gap-2">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={i18n.t('notes.open_navigation')}
        onclick={() => (matchMedia('(max-width: 1179px)').matches ? ui.toggleNavDrawer() : ui.toggleNav())}
        ><PanelLeft /></Button
      >
      <h2 class="min-w-0 flex-1 truncate">{title}</h2>
      <span class="tabular-nums" aria-label={i18n.t('notes.notes')}>{projection.length}</span><Button
        variant="ghost"
        size="icon-sm"
        disabled={busy || ui.filter.view === 'trash'}
        aria-label={i18n.t('common.new_note')}
        onclick={() => void create()}><Plus /></Button
      >
    </div>
    <Field.Field
      ><Field.Label class="sr-only" for={`${instanceId}-filter`}>{i18n.t('notes.filter_in_this_view')}</Field.Label
      ><Input
        id={`${instanceId}-filter`}
        type="search"
        bind:value={filter}
        placeholder={i18n.t('notes.filter_in_this_view')}
      /></Field.Field
    >
    <div class="flex flex-wrap gap-2">
      <DropdownMenu.Root
        ><DropdownMenu.Trigger class={buttonVariants({ variant: 'outline', size: 'sm' })}
          >{i18n.t('notes.sort_and_display')}</DropdownMenu.Trigger
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
            <DropdownMenu.Item
              onclick={() => ui.setDensity(ui.layout.density === 'compact' ? 'comfortable' : 'compact')}
              >{i18n.t(
                ui.layout.density === 'compact' ? 'notes.comfortable_list' : 'notes.compact_list',
              )}</DropdownMenu.Item
            >
          </DropdownMenu.Group></DropdownMenu.Content
        ></DropdownMenu.Root
      >
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !filtered.length}
        onclick={() => ui.setSelection(filtered.map((note) => note.id))}
        >{i18n.t('notes.select_all')} ({filtered.length})</Button
      >
      {#if ui.filter.view === 'trash' && projection.length}<Button
          variant="outline"
          size="sm"
          disabled={busy}
          onclick={() =>
            void batch(
              'purge',
              projection.map((note) => note.id),
            )}>{i18n.t('common.empty_trash')} ({projection.length})</Button
        >{/if}
    </div>
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
    class="min-h-0 flex-1 overflow-auto p-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    {#each displayed as note, index (note.id)}
      {@const previous = displayed[index - 1]}
      {#if !previous || group(previous) !== group(note)}<div
          role="presentation"
          class="px-2 py-1 text-xs text-muted-foreground"
        >
          {group(note)}
        </div>{/if}
      <DropdownMenu.Root>
        <div
          id={optionId(note.id)}
          role="option"
          tabindex={-1}
          draggable={!busy && note.deletedAt === null}
          ondragstart={(event) => startDrag(event, note.id)}
          aria-selected={ui.selection.includes(note.id)}
          aria-label={note.title || i18n.t('common.untitled_note')}
          aria-posinset={positions.get(note.id) ?? index + 1}
          aria-setsize={filtered.length}
          class="note-row flex items-start gap-1 rounded-md"
          class:selected={ui.selection.includes(note.id)}
          class:focused={focused === note.id}
          oncontextmenu={(event) => {
            event.preventDefault()
            focused = note.id
            event.currentTarget.querySelector<HTMLButtonElement>('[data-note-menu]')?.click()
          }}
        >
          <Button
            variant={ui.activeNoteId === note.id ? 'secondary' : 'ghost'}
            class="h-auto min-w-0 flex-1 justify-start py-2"
            tabindex={-1}
            onclick={(event) => {
              select(note.id, event.shiftKey && !event.altKey, event.ctrlKey || event.metaKey)
              if (!event.ctrlKey && !event.metaKey) void open(note.id, event.shiftKey || event.altKey)
              listbox?.focus()
            }}
          >
            <span class="flex min-w-0 flex-1 flex-col items-start gap-1"
              ><span class="w-full truncate"
                >{note.isPinned ? '• ' : ''}{note.title || i18n.t('common.untitled_note')}{note.isStarred
                  ? ' ★'
                  : ''}</span
              >{#if ui.layout.density !== 'compact'}<span class="w-full truncate text-xs text-muted-foreground"
                  >{note.excerpt}</span
                ><span class="text-xs text-muted-foreground">{note.tags.map((tag) => `#${tag}`).join(' ')}</span
                >{/if}</span
            >
          </Button>
          <DropdownMenu.Trigger
            data-note-menu
            class={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
            aria-label={`${i18n.t('common.more_actions')}: ${note.title}`}><MoreHorizontal /></DropdownMenu.Trigger
          >
        </div>
        <DropdownMenu.Content
          ><DropdownMenu.Group
            ><DropdownMenu.Item onclick={() => void open(note.id)}>{i18n.t('common.open')}</DropdownMenu.Item
            ><DropdownMenu.Item onclick={() => void open(note.id, true)}
              >{i18n.t('notes.open_to_side')}</DropdownMenu.Item
            ><DropdownMenu.Item onclick={() => select(note.id, false, true)}
              >{i18n.t(ui.selection.includes(note.id) ? 'notes.deselect' : 'notes.add_to_selection')}</DropdownMenu.Item
            ></DropdownMenu.Group
          ><DropdownMenu.Separator />{@render actions([note.id], note.deletedAt !== null)}</DropdownMenu.Content
        >
      </DropdownMenu.Root>
    {/each}
    {#if !displayed.length && !loading}<p role="status" class="p-4 text-sm text-muted-foreground">
        {i18n.t(
          filter.trim()
            ? 'notes.no_matching_notes'
            : ui.filter.view === 'trash'
              ? 'notes.trash_is_empty'
              : 'notes.no_notes_yet',
        )}
      </p>{/if}
    {#if loading}<p role="status">{i18n.t('common.loading')}</p>{/if}
    {#if pageError}<p role="alert" class="text-sm text-destructive">{pageError}</p>
      <Button variant="outline" onclick={() => refresh++}>{i18n.t('common.retry')}</Button>{/if}
    {#if (filter.trim() && displayed.length < filtered.length) || (!filter.trim() && nextCursor)}<Button
        variant="outline"
        class="w-full"
        disabled={loading}
        onclick={() => void loadMore()}>{i18n.t('notes.load_more')}</Button
      >{/if}
  </div>
  {#if selected.length}<footer class="flex flex-wrap items-center gap-2 border-t border-[var(--border-default)] p-2">
      <span>{i18n.t('notes.selected')}{selected.length}{i18n.t('notes.notes')}</span><DropdownMenu.Root
        ><DropdownMenu.Trigger disabled={busy} class={buttonVariants({ variant: 'outline', size: 'sm' })}
          >{i18n.t('common.more_actions')}</DropdownMenu.Trigger
        ><DropdownMenu.Content>{@render actions(selected, ui.filter.view === 'trash')}</DropdownMenu.Content
        ></DropdownMenu.Root
      ><Button variant="ghost" disabled={busy} onclick={() => ui.setSelection([])}>{i18n.t('notes.deselect')}</Button>
    </footer>{/if}
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

<style>
  .note-row.selected {
    background: var(--accent-soft);
  }
  .note-row.focused {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
</style>
