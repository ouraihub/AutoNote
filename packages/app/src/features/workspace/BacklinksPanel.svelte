<script lang="ts">
  import type { Backlink } from '@shared/types'
  import { ArrowUpRight, Link2 } from '@lucide/svelte'
  import Button from '../../components/primitives/Button.svelte'
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

<section
  class="max-h-[36%] shrink-0 overflow-y-auto border-t border-[var(--border-subtle)] bg-[var(--bg-base)]"
  aria-label={i18n.t('common.backlinks')}
>
  <div
    class="sticky top-0 z-10 flex items-center gap-1.5 border-b border-[var(--border-subtle)] bg-[var(--bg-base)] px-3 py-2 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
  >
    <Link2 size={11} />{i18n.t('common.backlinks')}{#if links?.length}<span
        class="tabular">· {links.length}</span
      >{/if}
  </div>
  {#if navigationError}<p
      role="alert"
      class="px-3 py-2 text-[12px] text-[var(--danger)]"
    >
      {i18n.t('common.action_failed')}
    </p>{/if}
  {#if loadError}
    <div
      class="flex items-center justify-between gap-3 px-3 py-4 text-[12px] text-[var(--text-quaternary)]"
    >
      <span role="alert">{i18n.t('workspace.could_not_load_backlinks')}</span>
      <Button size="sm" variant="ghost" onclick={() => reload++}
        >{i18n.t('common.retry')}</Button
      >
    </div>
  {:else if links === null}
    <div
      role="status"
      class="px-3 py-4 text-[12px] text-[var(--text-quaternary)]"
    >
      {i18n.t('common.loading')}
    </div>
  {:else if links.length === 0}
    <div
      class="px-3 py-4 text-[12px] leading-relaxed text-[var(--text-quaternary)]"
    >
      {i18n.t('workspace.no_notes_link_here_yet_write')}
      <code
        class="rounded bg-[var(--bg-inset)] px-1 py-0.5 font-mono text-[11px]"
        >{i18n.t('workspace.title')}</code
      >
      {i18n.t('workspace.will_appear_here')}
    </div>
  {:else}
    <ul class="p-2">
      {#each links as link (link.id)}
        <li>
          <button
            type="button"
            onclick={() => void open(link.id)}
            class="group w-full rounded-[var(--r-md)] px-2 py-2 text-left transition-colors hover:bg-[var(--bg-hover)]"
          >
            <span class="flex items-center gap-1.5">
              <span
                class="min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]"
                >{link.title}</span
              >
              <ArrowUpRight
                size={11}
                class="shrink-0 text-[var(--text-quaternary)] opacity-0 transition-opacity group-hover:opacity-100"
              />
            </span>
            <span
              class="truncate-2 mt-0.5 block text-[11.5px] leading-relaxed text-[var(--text-tertiary)]"
              >{link.context}</span
            >
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>
