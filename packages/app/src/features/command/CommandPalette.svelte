<script lang="ts">
  import type { Backend } from '@app/backend'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { NoteSummary } from '@shared/types'
  import type { NotesState } from '@app/state/notes.svelte'
  import type { OrganizeActions } from '@app/state/mutations'
  import type { SettingsState } from '@app/state/settings.svelte'
  import type { UiState } from '@app/state/ui.svelte'
  import { fuzzyFilter, splitByRanges, type FuzzyMatch } from '@app/lib/fuzzy'
  import { Dialog as DialogPrimitive } from 'bits-ui'
  import { Clock, Columns2, Eye, FileText, FolderPlus, Hash, Keyboard, Pencil, Plus, Search, Settings, Star, Trash2, Waypoints, X } from '@lucide/svelte'
  import DialogPortal from '@app/components/ui/dialog/dialog-portal.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import Kbd from '@app/components/primitives/Kbd.svelte'

  interface I18n {
    t(key: MessageKey, params?: Readonly<Record<string, boolean | number | string | null | undefined>>): string
  }
  interface Item {
    readonly id: string
    readonly label: string
    readonly detail?: string
    readonly group: string
    readonly icon: typeof Plus
    readonly combo?: string
    readonly match?: FuzzyMatch
    run: () => void | Promise<void>
  }
  interface Props {
    open?: boolean
    notes: NotesState
    ui: UiState
    backend: Backend
    i18n: I18n
    settings?: SettingsState
    organize?: OrganizeActions
    onOpenChange(open: boolean): void
  }

  let { open = $bindable(true), notes, ui, backend, i18n, settings, organize, onOpenChange }: Props = $props()
  let query = $state('')
  let cursor = $state(0)
  let searchGeneration = 0
  let remote = $state<{ query: string; results: NoteSummary[] }>({ query: '', results: [] })
  const allNotes = $derived(Object.values(notes.summaries).filter((note) => note.deletedAt === null))
  const snapshot = $derived(notes.readOrganizeSnapshot())
  const localItems = $derived.by(() => {
    const text = query.trim()
    const commands: Item[] = [
      {
        id: 'new-note',
        label: i18n.t('common.new_note'),
        group: i18n.t('command.commands'),
        icon: Plus,
        combo: 'mod+n',
        run: () => void createNote(),
      },
      {
        id: 'new-folder',
        label: i18n.t('common.new_folder'),
        group: i18n.t('command.commands'),
        icon: FolderPlus,
        run: () => void organize?.createFolder(),
      },
      {
        id: 'shortcuts',
        label: i18n.t('command.keyboard_shortcuts'),
        group: i18n.t('command.commands'),
        icon: Keyboard,
        combo: 'shift+?',
        run: () => ui.openPanel('shortcuts'),
      },
      {
        id: 'settings',
        label: i18n.t('common.open_settings'),
        group: i18n.t('command.commands'),
        icon: Settings,
        combo: 'mod+,',
        run: () => ui.openPanel('settings'),
      },
      {
        id: 'graph',
        label: i18n.t('command.open_graph'),
        group: i18n.t('common.interface'),
        icon: Waypoints,
        run: () => ui.openPanel('graph'),
      },
      {
        id: 'trash',
        label: i18n.t('command.open_trash'),
        group: i18n.t('common.navigation'),
        icon: Trash2,
        run: () => ui.openView('trash'),
      },
      {
        id: 'starred',
        label: i18n.t('command.open_favorites'),
        group: i18n.t('common.navigation'),
        icon: Star,
        run: () => ui.openView('starred'),
      },
      {
        id: 'live',
        label: i18n.t('command.layout_editor_only'),
        group: i18n.t('common.interface'),
        icon: Pencil,
        run: () => settings?.update({ preview: { layout: 'live' } }),
      },
      {
        id: 'split',
        label: i18n.t('command.layout_split_view'),
        group: i18n.t('common.interface'),
        icon: Columns2,
        run: () => settings?.update({ preview: { layout: 'split' } }),
      },
      {
        id: 'preview',
        label: i18n.t('command.layout_preview_only'),
        group: i18n.t('common.interface'),
        icon: Eye,
        run: () => settings?.update({ preview: { layout: 'preview' } }),
      },
    ]
    if (!text) {
      const recent = ui.recent
        .map((id) => notes.summaries[id])
        .filter((note): note is NoteSummary => Boolean(note && note.deletedAt === null))
        .slice(0, 6)
      return [...recent.map((note) => noteItem(note, i18n.t('command.recently_opened'), Clock)), ...commands]
    }
    const result: Item[] = fuzzyFilter(commands, text, (item) => item.label, 10).map(({ item, match }) => ({
      ...item,
      match,
    }))
    result.push(
      ...fuzzyFilter(allNotes, text, (note) => note.title, 15).map(({ item, match }) =>
        noteItem(item, i18n.t('common.note'), FileText, match),
      ),
    )
    result.push(
      ...fuzzyFilter(snapshot.tags, text, (tag) => tag.name, 5).map(({ item, match }) => ({
        id: `tag-${item.id}`,
        label: `#${item.name}`,
        detail: `${item.count}`,
        group: i18n.t('navigation.tag'),
        icon: Hash,
        match,
        run: () => ui.openView('tag', { tag: item.name }),
      })),
    )
    result.push(
      ...fuzzyFilter(snapshot.folders, text, (folder) => folder.name, 5).map(({ item, match }) => ({
        id: `folder-${item.id}`,
        label: item.name,
        group: i18n.t('navigation.folder'),
        icon: FolderPlus,
        match,
        run: () => ui.openView('folder', { folderId: item.id }),
      })),
    )
    if (remote.query === text)
      result.push(
        ...remote.results
          .filter((note) => !result.some((item) => item.id === `note-${note.id}`))
          .map((note) => noteItem(note, i18n.t('command.content_match'), Search)),
      )
    if (!result.length)
      result.push({
        id: 'create-title',
        label: i18n.t('command.create_note_value0', { value0: text }),
        group: i18n.t('command.commands'),
        icon: Plus,
        run: () => void createNote(text),
      })
    return result.sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0)).slice(0, 40)
  })
  const groups = $derived.by(() => {
    const map: Record<string, Item[]> = {}
    for (const item of localItems) (map[item.group] ??= []).push(item)
    return Object.entries(map)
  })

  $effect(() => {
    const text = query.trim()
    const generation = ++searchGeneration
    const controller = new AbortController()
    const timer = setTimeout(() => {
      if (text.length < 2) {
        remote = { query: text, results: [] }
        return
      }
      void backend.search
        .query(text, 20, { signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted && generation === searchGeneration)
            remote = { query: text, results: response.results.map((hit) => hit.note) }
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted && generation === searchGeneration) remote = { query: text, results: [] }
          if (error instanceof Error && error.name === 'AbortError') return
        })
    }, 120)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  })

  function noteItem(note: NoteSummary, group: string, icon: typeof Plus, match?: FuzzyMatch): Item {
    return {
      id: `note-${note.id}`,
      label: note.title || i18n.t('common.untitled_note'),
      detail: note.excerpt,
      group,
      icon,
      ...(match ? { match } : {}),
      run: () => openNote(note.id),
    }
  }
  async function openNote(id: string): Promise<void> {
    onOpenChange(false)
    ui.openNote(id)
    await notes.open(id, ui.activePane)
  }
  async function createNote(title?: string): Promise<void> {
    onOpenChange(false)
    const note = await notes.create(title ? { title } : {})
    ui.openNote(note.id)
    await notes.open(note.id, ui.activePane)
  }
  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      cursor = Math.min(Math.max(localItems.length - 1, 0), cursor + 1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      cursor = Math.max(0, cursor - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      void localItems[cursor]?.run()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onOpenChange(false)
    }
  }
  const listId = $props.id()
</script>

<DialogPrimitive.Root bind:open {onOpenChange}>
  <DialogPortal>
    <div class="app-viewport-fixed fixed z-[240] flex items-end justify-center md:items-start md:px-4 md:pt-[13vh]">
      <DialogPrimitive.Overlay class="anim-fade absolute inset-0 bg-[var(--scrim)] backdrop-blur-[3px]" />
      <DialogPrimitive.Content
        class="anim-pop relative flex h-[min(82dvh,var(--app-viewport-height,100dvh))] w-full max-w-[660px] flex-col overflow-hidden rounded-t-[var(--r-2xl)] border border-b-0 border-[var(--border-default)] bg-[var(--bg-overlay)] pb-[env(safe-area-inset-bottom)] shadow-[var(--shadow-modal)] outline-none md:h-auto md:rounded-[var(--r-2xl)] md:border-b md:pb-0"
      >
        <DialogPrimitive.Title class="sr-only">{i18n.t('common.search_notes_or_run_a_command')}</DialogPrimitive.Title>
        <DialogPrimitive.Description class="sr-only"
          >{i18n.t('command.use_nearly_every_action_without_touching_the_mouse')}</DialogPrimitive.Description
        >
        <div class="flex items-center gap-2.5 border-b border-[var(--border-subtle)] px-4">
          <Search size={16} class="shrink-0 text-[var(--text-quaternary)]" />
          <input
            bind:value={query}
            onkeydown={onKeydown}
            oninput={() => (cursor = 0)}
            role="combobox"
            aria-label={i18n.t('common.search_notes_or_run_a_command')}
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={localItems[cursor] ? `${listId}-option-${cursor}` : undefined}
            aria-autocomplete="list"
            autocomplete="off"
            placeholder={i18n.t('command.search_notes_or_type_a_command')}
            class="h-[52px] flex-1 bg-transparent text-[15px] text-[var(--text-primary)] placeholder:text-[var(--text-quaternary)] focus:outline-none"
          />
          <span class="hidden md:inline-flex"><Kbd keys={['Esc']} /></span>
          <span class="md:hidden">
            <IconButton label={i18n.t('common.close')} title={i18n.t('common.close')} size="sm" onclick={() => onOpenChange(false)}>
              <X size={16} />
            </IconButton>
          </span>
        </div>
        <div id={listId} role="listbox" class="min-h-0 flex-1 overflow-y-auto p-1.5 md:max-h-[54vh] md:flex-none">
          {#if !groups.length}
            <div class="px-3 py-10 text-center text-[12.5px] text-[var(--text-quaternary)]">
              {i18n.t('command.no_matching_results')}
            </div>
          {:else}
            {#each groups as [group, items] (group)}
              <div role="group" aria-label={group} class="mb-1">
                <div class="px-2.5 pt-2 pb-1 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]">
                  {group}
                </div>
                {#each items as item, index (item.id)}
                  {@const indexInList =
                    groups
                      .slice(
                        0,
                        groups.findIndex(([name]) => name === group),
                      )
                      .reduce((count, [, values]) => count + values.length, 0) + index}
                  {@const active = indexInList === cursor}
                  <button
                    id={`${listId}-option-${indexInList}`}
                    type="button"
                    role="option"
                    aria-selected={active}
                    tabindex={-1}
                    onmousemove={() => (cursor = indexInList)}
                    onclick={() => void item.run()}
                    class={[
                      'flex w-full items-center gap-2.5 rounded-[var(--r-md)] px-2.5 py-2 text-left',
                      'transition-colors duration-[80ms]',
                      active ? 'bg-[var(--accent-soft)]' : 'hover:bg-[var(--bg-hover)]',
                    ]}
                  >
                    <span class={['shrink-0', active ? 'text-[var(--accent)]' : 'text-[var(--text-quaternary)]']}>
                      <item.icon size={14} />
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[13px] text-[var(--text-primary)]"
                        >{#each item.match ? splitByRanges(item.label, item.match.ranges) : [{ text: item.label, hit: false }] as part, partIndex (partIndex)}{#if part.hit}<mark
                              class="ink-hit">{part.text}</mark
                            >{:else}{part.text}{/if}{/each}</span
                      >
                      {#if item.detail}
                        <span class="mt-0.5 block truncate text-[11px] text-[var(--text-quaternary)]">{item.detail}</span>
                      {/if}
                    </span>
                    {#if item.combo}<Kbd combo={item.combo} />{/if}
                  </button>
                {/each}
              </div>
            {/each}
          {/if}
        </div>
        <div
          class="hidden items-center gap-4 border-t border-[var(--border-subtle)] px-4 py-2 text-[10.5px] text-[var(--text-quaternary)] md:flex"
        >
          <span class="flex items-center gap-1.5"><Kbd keys={['↑', '↓']} />{i18n.t('command.select')}</span>
          <span class="flex items-center gap-1.5"><Kbd keys={['↵']} />{i18n.t('common.open')}</span>
          <span class="flex items-center gap-1.5"><Kbd keys={['Esc']} />{i18n.t('common.close')}</span>
        </div>
      </DialogPrimitive.Content>
    </div>
  </DialogPortal>
</DialogPrimitive.Root>
