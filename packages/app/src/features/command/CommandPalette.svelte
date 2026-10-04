<script lang="ts">
  import type { Backend } from '@app/backend'
  import type { MessageKey } from '@shared/locales/en-US'
  import type { NoteSummary } from '@shared/types'
  import type { NotesState } from '@app/state/notes.svelte'
  import type { OrganizeActions } from '@app/state/mutations'
  import type { SettingsState } from '@app/state/settings.svelte'
  import type { UiState } from '@app/state/ui.svelte'
  import { fuzzyFilter, splitByRanges, type FuzzyMatch } from '@app/lib/fuzzy'
  import * as Dialog from '@app/components/ui/dialog'
  import { Input } from '@app/components/ui/input'
  import { Button } from '@app/components/ui/button'

  interface I18n {
    t(key: MessageKey, params?: Readonly<Record<string, boolean | number | string | null | undefined>>): string
  }
  interface Item {
    readonly id: string
    readonly label: string
    readonly detail?: string
    readonly group: string
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
        combo: 'mod+n',
        run: () => void createNote(),
      },
      {
        id: 'new-folder',
        label: i18n.t('common.new_folder'),
        group: i18n.t('command.commands'),
        run: () => void organize?.createFolder(),
      },
      {
        id: 'shortcuts',
        label: i18n.t('command.keyboard_shortcuts'),
        group: i18n.t('command.commands'),
        combo: 'shift+?',
        run: () => ui.openPanel('shortcuts'),
      },
      {
        id: 'settings',
        label: i18n.t('common.open_settings'),
        group: i18n.t('command.commands'),
        combo: 'mod+,',
        run: () => ui.openPanel('settings'),
      },
      {
        id: 'graph',
        label: i18n.t('command.open_graph'),
        group: i18n.t('common.interface'),
        run: () => ui.openPanel('graph'),
      },
      {
        id: 'trash',
        label: i18n.t('command.open_trash'),
        group: i18n.t('common.navigation'),
        run: () => ui.openView('trash'),
      },
      {
        id: 'starred',
        label: i18n.t('command.open_favorites'),
        group: i18n.t('common.navigation'),
        run: () => ui.openView('starred'),
      },
      {
        id: 'live',
        label: i18n.t('command.layout_editor_only'),
        group: i18n.t('common.interface'),
        run: () => settings?.update({ preview: { layout: 'live' } }),
      },
      {
        id: 'split',
        label: i18n.t('command.layout_split_view'),
        group: i18n.t('common.interface'),
        run: () => settings?.update({ preview: { layout: 'split' } }),
      },
      {
        id: 'preview',
        label: i18n.t('command.layout_preview_only'),
        group: i18n.t('common.interface'),
        run: () => settings?.update({ preview: { layout: 'preview' } }),
      },
    ]
    if (!text) {
      const recent = ui.recent
        .map((id) => notes.summaries[id])
        .filter((note): note is NoteSummary => Boolean(note && note.deletedAt === null))
        .slice(0, 6)
      return [...recent.map((note) => noteItem(note, i18n.t('command.recently_opened'))), ...commands]
    }
    const result: Item[] = fuzzyFilter(commands, text, (item) => item.label, 10).map(({ item, match }) => ({
      ...item,
      match,
    }))
    result.push(
      ...fuzzyFilter(allNotes, text, (note) => note.title, 15).map(({ item, match }) =>
        noteItem(item, i18n.t('common.note'), match),
      ),
    )
    result.push(
      ...fuzzyFilter(snapshot.tags, text, (tag) => tag.name, 5).map(({ item, match }) => ({
        id: `tag-${item.id}`,
        label: `#${item.name}`,
        detail: `${item.count}`,
        group: i18n.t('navigation.tag'),
        match,
        run: () => ui.openView('tag', { tag: item.name }),
      })),
    )
    result.push(
      ...fuzzyFilter(snapshot.folders, text, (folder) => folder.name, 5).map(({ item, match }) => ({
        id: `folder-${item.id}`,
        label: item.name,
        group: i18n.t('navigation.folder'),
        match,
        run: () => ui.openView('folder', { folderId: item.id }),
      })),
    )
    if (remote.query === text)
      result.push(
        ...remote.results
          .filter((note) => !result.some((item) => item.id === `note-${note.id}`))
          .map((note) => noteItem(note, i18n.t('command.content_match'))),
      )
    if (!result.length)
      result.push({
        id: 'create-title',
        label: i18n.t('command.create_note_value0', { value0: text }),
        group: i18n.t('command.commands'),
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

  function noteItem(note: NoteSummary, group: string, match?: FuzzyMatch): Item {
    return {
      id: `note-${note.id}`,
      label: note.title || i18n.t('common.untitled_note'),
      detail: note.excerpt,
      group,
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
</script>

<Dialog.Root bind:open {onOpenChange}>
  <Dialog.Content class="max-w-2xl gap-0 p-0" showCloseButton={false}>
    <Dialog.Header class="sr-only">
      <Dialog.Title>{i18n.t('common.search_notes_or_run_a_command')}</Dialog.Title>
      <Dialog.Description>{i18n.t('command.use_nearly_every_action_without_touching_the_mouse')}</Dialog.Description>
    </Dialog.Header>
    <div class="border-b p-3">
      <Input
        bind:value={query}
        autofocus
        onkeydown={onKeydown}
        oninput={() => (cursor = 0)}
        role="combobox"
        aria-label={i18n.t('common.search_notes_or_run_a_command')}
        aria-expanded="true"
        placeholder={i18n.t('command.search_notes_or_type_a_command')}
      />
    </div>
    <div class="max-h-[55vh] overflow-y-auto p-2" role="listbox">
      {#if !groups.length}
        <p class="p-8 text-center text-sm text-muted-foreground">{i18n.t('command.no_matching_results')}</p>
      {:else}
        {#each groups as [group, items] (group)}
          <section aria-label={group}>
            <h3 class="px-2 py-1 text-xs font-semibold text-muted-foreground">{group}</h3>
            {#each items as item, index (item.id)}
              {@const indexInList =
                groups
                  .slice(
                    0,
                    groups.findIndex(([name]) => name === group),
                  )
                  .reduce((count, [, values]) => count + values.length, 0) + index}
              {@const active = indexInList === cursor}
              <Button
                variant={active ? 'secondary' : 'ghost'}
                class="w-full justify-start"
                role="option"
                aria-selected={active}
                onclick={() => void item.run()}
                onmouseenter={() => (cursor = indexInList)}
              >
                <span class="min-w-0 flex-1 truncate text-left"
                  >{#each item.match ? splitByRanges(item.label, item.match.ranges) : [{ text: item.label, hit: false }] as part, partIndex (partIndex)}{#if part.hit}<mark
                        >{part.text}</mark
                      >{:else}{part.text}{/if}{/each}</span
                >
                {#if item.combo}<kbd class="text-xs text-muted-foreground">{item.combo}</kbd>{/if}
              </Button>
            {/each}
          </section>
        {/each}
      {/if}
    </div>
  </Dialog.Content>
</Dialog.Root>
