<script lang="ts">
  import type { I18nState } from '../../i18n/runtime.svelte'
  import type { NotesState } from '../../state/notes.svelte'
  import { Filter } from '@lucide/svelte'

  interface Props {
    i18n: Pick<I18nState, 't'>
    organize: ReturnType<NotesState['readOrganizeSnapshot']>
    mode: 'global' | 'local'
    depth: number
    folderId: string
    tag: string
    includeOrphans: boolean
    includeUnresolved: boolean
  }

  let {
    i18n,
    organize,
    mode = $bindable(),
    depth = $bindable(),
    folderId = $bindable(),
    tag = $bindable(),
    includeOrphans = $bindable(),
    includeUnresolved = $bindable(),
  }: Props = $props()
  const selectClass =
    'h-8 max-w-[160px] rounded-[var(--r-md)] border border-[var(--border-default)] bg-[var(--bg-inset)] px-2 text-[11.5px] outline-none focus:border-[var(--accent)]'
  const toggleClass =
    'flex cursor-pointer items-center justify-between gap-3 text-[12px] text-[var(--text-secondary)]'
</script>

<aside
  aria-label={i18n.t('graph.settings')}
  class="absolute inset-y-0 right-0 z-10 w-[min(88vw,300px)] overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-base)] p-4 shadow-[-8px_0_24px_rgba(0,0,0,.06)] md:static md:shadow-none"
>
  <div class="mb-4 flex items-center justify-between">
    <h3 class="text-[13px] font-semibold">{i18n.t('graph.settings')}</h3>
  </div>
  <section class="mb-5">
    <h4
      class="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-quaternary)]"
    >
      <Filter size={13} />{i18n.t('graph.filters')}
    </h4>
    <div class="space-y-2.5">
      <label class={toggleClass}>
        <span>{i18n.t('graph.folder')}</span>
        <select bind:value={folderId} class={selectClass}>
          <option value="">{i18n.t('graph.all_folders')}</option>
          {#each organize.folders as folder (folder.id)}
            <option value={folder.id}>{folder.name}</option>
          {/each}
        </select>
      </label>
      <label class={toggleClass}>
        <span>{i18n.t('graph.tag')}</span>
        <select bind:value={tag} class={selectClass}>
          <option value="">{i18n.t('graph.all_tags')}</option>
          {#each organize.tags as item (item.id)}
            <option value={item.name}>{item.name}</option>
          {/each}
        </select>
      </label>
      <label class={toggleClass}>
        <span>{i18n.t('graph.show_orphans')}</span>
        <input
          type="checkbox"
          bind:checked={includeOrphans}
          class="size-4 accent-[var(--accent)]"
        />
      </label>
      <label class={toggleClass}>
        <span>{i18n.t('graph.show_unresolved')}</span>
        <input
          type="checkbox"
          bind:checked={includeUnresolved}
          class="size-4 accent-[var(--accent)]"
        />
      </label>
      {#if mode === 'local'}
        <label class={toggleClass}>
          <span>{i18n.t('graph.depth')}</span>
          <select bind:value={depth} class={selectClass}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={3}>3</option>
          </select>
        </label>
      {/if}
    </div>
  </section>
</aside>
