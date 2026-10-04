<script lang="ts">
  import type { Heading } from '../../markdown/renderer'
  import { getI18n } from '../../root/context'
  interface Props { headings: readonly Heading[]; scroller: HTMLElement; onSelect(heading: Heading): void }
  let { headings, scroller, onSelect }: Props = $props()
  const i18n = getI18n()
  let active = $state('')
  const minimum = $derived(Math.min(...headings.map((heading) => heading.level)))
  $effect(() => {
    const root = scroller
    const list = headings
    function update(): void {
      const top = root.getBoundingClientRect().top + 60
      let current = list[0]?.slug ?? ''
      for (const heading of list) {
        const element = root.querySelector<HTMLElement>(`[data-preview-content] #${CSS.escape(heading.slug)}`)
        if (element && element.getBoundingClientRect().top <= top) current = heading.slug
      }
      active = current
    }
    update()
    root.addEventListener('scroll', update, { passive: true })
    return () => root.removeEventListener('scroll', update)
  })
</script>

{#if headings.length}
  <nav aria-label={i18n.t('common.outline')}>
    <h2>{i18n.t('common.outline')}</h2>
    <ul>
      {#each headings as heading, index (`${heading.slug}-${index}`)}
        <li><button type="button" aria-current={active === heading.slug ? 'location' : undefined} title={heading.text} style:padding-left={`${8 + (heading.level - minimum) * 10}px`} onclick={() => onSelect(heading)}>{heading.text || i18n.t('preview.untitled')}</button></li>
      {/each}
    </ul>
  </nav>
{/if}

<style>
  /* Hallmark · component: outline · genre: editorial · theme: inherited tokens */
  nav { width: 168px; flex-shrink: 0; overflow-y: auto; padding: 20px 8px; border-left: 1px solid var(--border-subtle); }
  h2 { color: var(--text-tertiary); font-size: 12px; font-weight: 600; margin-bottom: 8px; }
  ul { list-style: none; margin: 0; padding: 0; }
  button { width: 100%; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text-tertiary); font-size: 12px; padding: 4px 6px; border-radius: var(--r-sm); cursor: pointer; }
  button:hover { color: var(--text-primary); background: var(--bg-hover); }
  button[aria-current] { color: var(--accent); font-weight: 600; }
  button:focus-visible { outline: 2px solid var(--accent); }
  @media (max-width: 767px) { nav { width: 132px; } }
</style>
