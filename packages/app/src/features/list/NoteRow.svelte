<script lang="ts">
  import type { NoteSummary } from '@shared/types'
  import type { OrganizeSnapshot } from '@app/state/mutations'
  import { organizerColorOrNull } from '@shared/organizer-colors'
  import { getI18n, getUi } from '@app/root/context'
  import * as DropdownMenu from '@app/components/ui/dropdown-menu'
  import { MoreHorizontal, Pin, Star } from '@lucide/svelte'
  import NoteActionItems from './NoteActionItems.svelte'
  import type { NoteActionControls } from './actions'

  let {
    note,
    id,
    position,
    total,
    focused,
    busy,
    snapshot,
    open,
    select,
    focusList,
    focusNote,
    startDrag,
    batch,
    move,
  }: NoteActionControls & {
    note: NoteSummary
    id: string
    position: number
    total: number
    focused: boolean
    busy: boolean
    snapshot: OrganizeSnapshot
    open: (id: string, secondary?: boolean) => Promise<void>
    select: (id: string, range: boolean, additive: boolean) => void
    focusList: () => void
    focusNote: (id: string) => void
    startDrag: (event: DragEvent, id: string) => void
  } = $props()
  const i18n = getI18n(),
    ui = getUi()
  const active = $derived(ui.activeNoteId === note.id)
  const selected = $derived(ui.selection.includes(note.id))
</script>

<DropdownMenu.Root>
  <!-- Keyboard input belongs to the parent listbox's aria-activedescendant. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    {id}
    role="option"
    tabindex={-1}
    draggable={!busy && note.deletedAt === null}
    ondragstart={(event) => startDrag(event, note.id)}
    aria-selected={selected}
    aria-label={note.title || i18n.t('common.untitled_note')}
    aria-posinset={position}
    aria-setsize={total}
    style:content-visibility="auto"
    style:contain-intrinsic-size={ui.layout.density === 'compact'
      ? 'auto 42px'
      : 'auto 72px'}
    class={[
      'motion-note-row group relative mb-px cursor-default ' +
        'rounded-[var(--r-md)] border border-transparent px-2.5 pr-11 ' +
        'transition-[background-color,border-color,box-shadow,transform] ' +
        'duration-[var(--dur-fast)] md:pr-10',
      ui.layout.density === 'compact' ? 'py-[7px]' : 'py-2.5',
      selected && !active
        ? 'bg-[var(--accent-soft)] ring-1 ring-[var(--accent)]/40'
        : active
          ? 'border-[var(--border-default)] bg-[var(--bg-surface)] ' +
            'shadow-[var(--shadow-sm)]'
          : 'hover:bg-[var(--bg-hover)]',
      focused && 'outline outline-1 -outline-offset-1 outline-[var(--accent)]',
    ]}
    onclick={(event) => {
      select(
        note.id,
        event.shiftKey && !event.altKey,
        event.ctrlKey || event.metaKey,
      )
      if (!event.ctrlKey && !event.metaKey)
        void open(note.id, event.shiftKey || event.altKey)
      focusList()
    }}
    oncontextmenu={(event) => {
      event.preventDefault()
      focusNote(note.id)
      event.currentTarget
        .querySelector<HTMLButtonElement>('[data-note-menu]')
        ?.click()
    }}
  >
    <div class="flex items-start gap-1.5">
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          {#if note.isPinned}<Pin
              size={10}
              class="anim-mark-enter shrink-0 text-[var(--accent)]"
            />{/if}
          <h3
            class={[
              'min-w-0 flex-1 truncate text-[13px] leading-snug',
              active
                ? 'font-semibold text-[var(--accent)]'
                : 'font-medium text-[var(--text-primary)]',
            ]}
          >
            {note.title || i18n.t('common.untitled_note')}
          </h3>
          {#if note.isStarred}<Star
              size={10}
              class={'anim-mark-enter shrink-0 fill-current ' +
                'text-[var(--warning)]'}
            />{/if}
        </div>
        {#if ui.layout.density !== 'compact' && note.excerpt}<p
            class={'truncate-2 mt-1 text-[11.5px] leading-[1.5] ' +
              'text-[var(--text-tertiary)]'}
          >
            {note.excerpt}
          </p>{/if}
        {#if ui.layout.density !== 'compact' && note.tags.length}<div
            class={'mt-1.5 flex min-w-0 items-center gap-1 overflow-hidden ' +
              'text-[10.5px] whitespace-nowrap text-[var(--text-tertiary)]'}
          >
            {#each note.tags as tag (tag)}<span
                class="max-w-[70%] shrink-0 truncate"
                style:color={organizerColorOrNull(
                  snapshot.tags.find((item) => item.name === tag)?.color,
                )}>#{tag}</span
              >{/each}
          </div>{/if}
      </div>
    </div>
    <DropdownMenu.Trigger
      data-note-menu
      tabindex={-1}
      title={i18n.t('common.more_actions')}
      onclick={(event) => event.stopPropagation()}
      class={'absolute top-1.5 right-1.5 inline-flex size-8 items-center ' +
        'justify-center rounded-[var(--r-md)] text-[var(--text-secondary)] ' +
        'opacity-100 transition-opacity hover:bg-[var(--bg-hover)] ' +
        'hover:text-[var(--text-primary)] md:size-6 md:opacity-0 ' +
        'md:group-hover:opacity-100 md:group-focus-within:opacity-100'}
      aria-label={`${i18n.t('common.more_actions')}: ${note.title}`}
      ><MoreHorizontal size={14} /></DropdownMenu.Trigger
    >
  </div>
  <DropdownMenu.Content
    ><DropdownMenu.Group
      ><DropdownMenu.Item onclick={() => void open(note.id)}
        >{i18n.t('common.open')}</DropdownMenu.Item
      ><DropdownMenu.Item onclick={() => void open(note.id, true)}
        >{i18n.t('notes.open_to_side')}</DropdownMenu.Item
      ><DropdownMenu.Item onclick={() => select(note.id, false, true)}
        >{i18n.t(
          selected ? 'notes.deselect' : 'notes.add_to_selection',
        )}</DropdownMenu.Item
      ></DropdownMenu.Group
    ><DropdownMenu.Separator /><NoteActionItems
      ids={[note.id]}
      inTrash={note.deletedAt !== null}
      {busy}
      {batch}
      {move}
    /></DropdownMenu.Content
  >
</DropdownMenu.Root>
