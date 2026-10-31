<script lang="ts">
  import { ListTree } from '@lucide/svelte'
  import type { Heading } from '../../markdown/renderer'
  import { getI18n } from '../../root/context'
  interface Props {
    headings: readonly Heading[]
    scroller: HTMLElement
    onSelect(heading: Heading): void
  }
  let { headings, scroller, onSelect }: Props = $props()
  const i18n = getI18n()
  let active = $state('')
  const minimum = $derived(
    Math.min(...headings.map((heading) => heading.level)),
  )
  $effect(() => {
    const root = scroller
    const list = headings
    function update(): void {
      const top = root.getBoundingClientRect().top + 60
      let current = list[0]?.slug ?? ''
      for (const heading of list) {
        const element = root.querySelector<HTMLElement>(
          `[data-preview-content] #${CSS.escape(heading.slug)}`,
        )
        if (element && element.getBoundingClientRect().top <= top)
          current = heading.slug
      }
      active = current
    }
    update()
    root.addEventListener('scroll', update, { passive: true })
    return () => root.removeEventListener('scroll', update)
  })
</script>

{#if headings.length}
  <nav
    class="sticky top-0 max-h-full w-[132px] shrink-0 self-start overflow-y-auto py-5 pr-3 md:w-[168px]"
    aria-label={i18n.t('common.outline')}
  >
    <div
      class="mb-2 flex items-center gap-1.5 px-2 text-[10.5px] font-semibold tracking-[0.06em] text-[var(--text-quaternary)]"
    >
      <ListTree size={11} />{i18n.t('common.outline')}
    </div>
    <ul class="space-y-px">
      {#each headings as heading, index (`${heading.slug}-${index}`)}
        {@const isActive = active === heading.slug}
        <li>
          <button
            type="button"
            aria-current={isActive ? 'location' : undefined}
            title={heading.text || i18n.t('preview.untitled')}
            style:padding-left={`${8 + (heading.level - minimum) * 10}px`}
            onclick={() => onSelect(heading)}
            class={[
              'relative block w-full truncate rounded-[var(--r-sm)] py-1 pr-1.5 text-left text-[11.5px] leading-snug transition-colors duration-[var(--dur-fast)]',
              isActive
                ? 'font-medium text-[var(--accent)]'
                : 'text-[var(--text-quaternary)] hover:text-[var(--text-secondary)]',
            ]}
          >
            {#if isActive}<span
                class="absolute top-1/2 left-0 h-[13px] w-[2px] -translate-y-1/2 rounded-full bg-[var(--accent)]"
              ></span>{/if}
            {heading.text || i18n.t('preview.untitled')}
          </button>
        </li>
      {/each}
    </ul>
  </nav>
{/if}
