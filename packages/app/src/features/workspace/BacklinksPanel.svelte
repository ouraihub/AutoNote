<script lang="ts">
  import type { Backlink } from '@shared/types'
  import type { Backend } from '../../backend'
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { HostExtensions } from '../../root/types'
  import type { NotesState } from '../../state/notes.svelte'
  import type { UiState } from '../../state/ui.svelte'

  interface Props {
    noteId: string
    backend: { notes: Pick<Backend['notes'], 'backlinks'> }
    notes: Pick<NotesState, 'summaries' | 'cursor' | 'open' | 'loadErrors'>
    ui: Pick<UiState, 'activePane' | 'openNote'>
    i18n: Pick<I18nState, 't'>
    extensions: Pick<HostExtensions, 'onNoteOpened'>
  }

  let { noteId, backend, notes, ui, i18n, extensions }: Props = $props()
  let links = $state<Backlink[] | null>(null)
  let loadError = $state(false)
  let navigationError = $state(false)
  let reload = $state(0)

  $effect(() => {
    const id = noteId
    const rev = notes.summaries[id]?.rev
    const cursor = notes.cursor
    void rev
    void cursor
    void reload
    links = null
    loadError = false
    navigationError = false
    const controller = new AbortController()
    void backend.notes.backlinks(id, { signal: controller.signal }).then(
      (result) => {
        if (!controller.signal.aborted) links = result
      },
      () => {
        if (!controller.signal.aborted) loadError = true
      },
    )
    return () => controller.abort()
  })

  async function open(id: string): Promise<void> {
    navigationError = false
    try {
      ui.openNote(id)
      await notes.open(id, ui.activePane)
      if (notes.loadErrors[id]) throw new Error('Note could not be opened')
      extensions.onNoteOpened?.(id)
    } catch {
      navigationError = true
    }
  }
</script>

<section class="max-h-[36%] shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] bg-[var(--bg-base)]" aria-label={i18n.t('common.backlinks')}>
  <div class="sticky top-0 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-xs font-semibold text-[var(--text-quaternary)]">
    {i18n.t('common.backlinks')}{#if links?.length} · {links.length}{/if}
  </div>
  {#if navigationError}<p role="alert" class="px-3 py-2 text-xs">{i18n.t('common.action_failed')}</p>{/if}
  {#if loadError}
    <div class="flex items-center justify-between gap-3 px-3 py-4 text-xs text-[var(--text-quaternary)]">
      <span role="alert">{i18n.t('workspace.could_not_load_backlinks')}</span>
      <button type="button" onclick={() => reload++}>{i18n.t('common.retry')}</button>
    </div>
  {:else if links === null}
    <p role="status" class="px-3 py-4 text-xs text-[var(--text-quaternary)]">{i18n.t('common.loading')}</p>
  {:else if links.length === 0}
    <p class="px-3 py-4 text-xs leading-relaxed text-[var(--text-quaternary)]">
      {i18n.t('workspace.no_notes_link_here_yet_write')} <code>{i18n.t('workspace.title')}</code> {i18n.t('workspace.will_appear_here')}
    </p>
  {:else}
    <ul class="p-2">
      {#each links as link (link.id)}
        <li>
          <button type="button" onclick={() => void open(link.id)} class="w-full rounded px-2 py-2 text-left hover:bg-[var(--bg-hover)]">
            <span class="block truncate text-sm font-medium text-[var(--text-primary)]">{link.title}</span>
            <span class="mt-0.5 block text-xs text-[var(--text-tertiary)]">{link.context}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
