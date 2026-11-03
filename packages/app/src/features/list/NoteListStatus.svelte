<script lang="ts">
  import type { MessageKey } from '@shared/locales/en-US'
  import type { ViewKind } from '@shared/types'
  import { getI18n, getUi } from '@app/root/context'
  import Empty, { type EmptyArt } from '@app/components/primitives/Empty.svelte'
  import { Plus } from '@lucide/svelte'
  import { prettyCombo } from '@app/lib/hotkeys'

  let {
    displayedCount,
    filteredCount,
    filter,
    loading,
    busy,
    pageError,
    nextCursor,
    create,
    retry,
    loadMore,
  }: {
    displayedCount: number
    filteredCount: number
    filter: string
    loading: boolean
    busy: boolean
    pageError: string
    nextCursor: string | null
    create: () => Promise<void>
    retry: () => void
    loadMore: () => Promise<void>
  } = $props()
  const i18n = getI18n(),
    ui = getUi()
  const shortcut = (combo: string) => prettyCombo(combo).join('+')
  const emptyStates: Record<
    ViewKind,
    {
      art: EmptyArt
      title: MessageKey
      description: MessageKey
      combo?: string
    }
  > = {
    all: {
      art: 'notes',
      title: 'notes.no_notes_yet',
      description:
        'notes.press_shortcut_or_the_plus_button_to_write_your_first_note',
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
    unfiled: {
      art: 'folder',
      title: 'notes.every_note_is_filed',
      description: 'notes.everything_is_neatly_organized',
    },
    archived: {
      art: 'archive',
      title: 'notes.archive_is_empty',
      description:
        'notes.keep_notes_here_when_you_want_them_out_of_the_way_\
but_not_deleted',
    },
    trash: {
      art: 'trash',
      title: 'notes.trash_is_empty',
      description: 'notes.deleted_notes_remain_until_you_restore_or_clear_them',
    },
    folder: {
      art: 'folder',
      title: 'notes.this_folder_is_still_empty',
      description: 'notes.drag_notes_in_or_create_new_ones_here',
    },
    tag: {
      art: 'tag',
      title: 'notes.there_are_no_notes_with_this_tag',
      description: 'notes.write_tags_in_the_note_to_link_them_automatically',
    },
  }
  const emptyState = $derived(emptyStates[ui.filter.view])
  const hasMore = $derived(
    (filter.trim() && displayedCount < filteredCount) ||
      (!filter.trim() && nextCursor),
  )
</script>

{#if !displayedCount && !loading}
  {#if filter.trim()}<Empty
      art="search"
      title={i18n.t('notes.no_matching_notes')}
      description={i18n.t(
        'notes.try_another_search_or_press_shortcut_to_search_everywhere',
        {
          shortcut: shortcut('mod+k'),
        },
      )}
    />{:else}<Empty
      art={emptyState.art}
      title={i18n.t(emptyState.title as MessageKey)}
      description={i18n.t(
        emptyState.description as MessageKey,
        emptyState.combo ? { shortcut: shortcut(emptyState.combo) } : {},
      )}
    >
      {#snippet action()}
        {#if ui.filter.view !== 'trash' && ui.filter.view !== 'archived'}<button
            type="button"
            disabled={busy}
            onclick={() => void create()}
            class={'inline-flex h-8 items-center gap-1.5 ' +
              'rounded-[var(--r-md)] border border-[var(--border-default)] ' +
              'px-3 text-[12.5px] text-[var(--text-secondary)] ' +
              'transition-colors hover:border-[var(--accent)] ' +
              'hover:text-[var(--accent)]'}
            ><Plus size={13} />{i18n.t('common.new_note')}</button
          >{/if}
      {/snippet}
    </Empty>{/if}
{/if}
{#if loading}<p
    role="status"
    class="px-2 py-3 text-[11.5px] text-[var(--text-quaternary)]"
  >
    {i18n.t('common.loading')}
  </p>{/if}
{#if pageError}<p
    role="alert"
    class="px-2 py-2 text-[11.5px] text-[var(--danger)]"
  >
    {pageError}
  </p>
  <button
    type="button"
    onclick={retry}
    class={'mx-2 rounded-[var(--r-md)] border ' +
      'border-[var(--border-subtle)] px-3 py-1 text-[11.5px] ' +
      'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'}
    >{i18n.t('common.retry')}</button
  >{/if}
{#if hasMore}
  <button
    type="button"
    disabled={loading}
    onclick={() => void loadMore()}
    class={'mt-2 w-full rounded-[var(--r-md)] border ' +
      'border-[var(--border-subtle)] py-1.5 text-[11.5px] ' +
      'text-[var(--text-tertiary)] transition-colors ' +
      'hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] ' +
      'disabled:opacity-50'}>{i18n.t('notes.load_more')}</button
  >{/if}
