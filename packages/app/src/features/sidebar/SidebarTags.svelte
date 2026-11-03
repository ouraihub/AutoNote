<script lang="ts">
  import { Hash, MoreHorizontal, Plus } from '@lucide/svelte'
  import { organizerColorOrNull } from '@shared/organizer-colors'
  import SectionLabel from '@app/components/primitives/SectionLabel.svelte'
  import IconButton from '@app/components/primitives/IconButton.svelte'
  import { getI18n, getUi } from '@app/root/context'
  let {
    tags,
    tagCounts,
    busy,
    edit,
    navigate,
  }: {
    tags: readonly { id: string; name: string; color: string | null }[]
    tagCounts: ReadonlyMap<string, number>
    busy: boolean
    edit(kind: 'tag', id?: string | null): Promise<void>
    navigate(view: 'tag', target: { tag: string }): void
  } = $props()
  const i18n = getI18n(),
    ui = getUi()
</script>

<section class="mt-4" aria-label={i18n.t('navigation.tag')}>
  <div class="group/head flex items-center justify-between pr-1">
    <SectionLabel>{i18n.t('navigation.tag')}</SectionLabel>
    <IconButton
      label={i18n.t('tags.new')}
      title={i18n.t('tags.new')}
      size="sm"
      disabled={busy}
      onclick={() => void edit('tag')}
      class={'opacity-100 transition-opacity md:opacity-0 ' +
        'md:group-hover/head:opacity-100 md:focus-visible:opacity-100'}
      ><Plus size={13} /></IconButton
    >
  </div>
  <div class="mt-0.5 flex flex-col gap-px">
    {#if !tags.length}<button
        type="button"
        onclick={() => void edit('tag')}
        class={'flex h-10 w-full items-center gap-2 ' +
          'rounded-[var(--r-md)] px-2 text-left text-[11.5px] ' +
          'text-[var(--text-quaternary)] transition-colors ' +
          'hover:bg-[var(--bg-hover)] hover:text-[var(--text-secondary)] ' +
          'md:h-[30px]'}><Plus size={13} />{i18n.t('tags.create_first')}</button
      >{/if}
    {#each tags as tag (tag.id)}
      {@const active = ui.filter.view === 'tag' && ui.filter.tag === tag.name}
      {@const tagColor =
        organizerColorOrNull(tag.color) ??
        (active ? 'var(--accent)' : 'var(--text-quaternary)')}
      <div
        role="presentation"
        class={[
          'group relative flex h-10 items-center gap-2 ' +
            'rounded-[var(--r-md)] px-2 md:h-[30px]',
          'transition-colors duration-[var(--dur-fast)]',
          active
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]',
        ]}
        oncontextmenu={(event) => {
          event.preventDefault()
          void edit('tag', tag.id)
        }}
      >
        <Hash size={13} class="shrink-0" style={`color: ${tagColor}`} />
        <button
          type="button"
          aria-current={active ? 'page' : undefined}
          onclick={() => navigate('tag', { tag: tag.name })}
          onkeydown={(event) => {
            if (
              event.key === 'F2' ||
              event.key === 'ContextMenu' ||
              (event.key === 'F10' && event.shiftKey)
            ) {
              event.preventDefault()
              void edit('tag', tag.id)
            }
          }}
          class={'min-w-0 flex-1 truncate py-1 text-left ' +
            'text-[12.5px] font-medium'}>{tag.name}</button
        >
        <span
          class={'tabular shrink-0 text-[11px] ' +
            'text-[var(--text-quaternary)] transition-opacity ' +
            'group-hover:opacity-0'}>{tagCounts.get(tag.name) || ''}</span
        >
        <IconButton
          label={`${i18n.t('tags.rename')}: ${tag.name}`}
          size="sm"
          onclick={() => void edit('tag', tag.id)}
          class={'absolute right-1 opacity-100 transition-opacity ' +
            'md:opacity-0 md:group-hover:opacity-100 ' +
            'md:focus-visible:opacity-100'}
          ><MoreHorizontal size={13} /></IconButton
        >
      </div>
    {/each}
  </div>
</section>
