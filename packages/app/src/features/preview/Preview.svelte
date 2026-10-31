<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { slugifyHeading } from '@shared/markdown-utils'
  import type { Heading, WikiTarget } from '../../markdown/renderer'
  import {
    getBackend,
    getExtensions,
    getI18n,
    getNotes,
    getNotifier,
    getSettings,
    getUi,
  } from '../../root/context'
  import { createRenderServices } from './services'
  import { rememberLightboxFocus, restoreLightboxFocus } from './article'
  import MarkdownArticle from './MarkdownArticle.svelte'
  import Outline from './Outline.svelte'
  import Lightbox from './Lightbox.svelte'

  interface Props {
    noteId: string
    source: string
    pane: 'primary' | 'secondary'
    onReady?(root: HTMLElement | null): void
  }
  let { noteId, source, pane, onReady }: Props = $props()
  const backend = getBackend()
  const notes = getNotes()
  const ui = getUi()
  const settings = getSettings()
  const notifier = getNotifier()
  const i18n = getI18n()
  const extensions = getExtensions()
  let scroller = $state<HTMLDivElement>()
  let headings = $state<readonly Heading[]>([])
  let pendingTarget: { target: WikiTarget; id: string } | null = null
  let dark = $state(false)
  const services = createRenderServices({
    backend,
    notes,
    ui,
    notifier,
    extensions,
    noteId: () => noteId,
    source: () => source,
    pane: () => pane,
    onNavigate(target, id) {
      pendingTarget = { target, id }
      void tick().then(ready)
    },
  })
  const collapseLines = $derived(
    settings.current.preview.codeBlockCollapse
      ? settings.current.preview.codeBlockCollapseLines
      : 0,
  )
  const width = $derived(
    { narrow: '56ch', normal: '72ch', wide: '90ch', full: '100%' }[
      settings.current.appearance.proseWidth
    ],
  )

  onMount(() => {
    const root =
      scroller?.closest<HTMLElement>('[data-app-root]') ??
      document.documentElement
    const update = () => (dark = root.dataset.theme === 'dark')
    update()
    const observer = new MutationObserver(update)
    observer.observe(root, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => {
      observer.disconnect()
      onReady?.(null)
    }
  })

  function ready(): void {
    if (!scroller) return
    onReady?.(scroller)
    if (pendingTarget?.id !== noteId) return
    const target = pendingTarget.target
    const id = target.blockId
      ? `^${target.blockId}`
      : target.heading
        ? slugifyHeading(target.heading)
        : ''
    if (!id) {
      pendingTarget = null
      return
    }
    const element = scroller.querySelector<HTMLElement>(
      `[data-preview-content] #${CSS.escape(id)}`,
    )
    if (element) {
      element.scrollIntoView({ block: 'center' })
      pendingTarget = null
    }
  }
  function image(image: HTMLImageElement): void {
    rememberLightboxFocus(ui, image)
    image.focus()
    ui.setLightbox({ src: image.src, alt: image.alt })
  }
  function select(heading: Heading): void {
    const element = scroller?.querySelector<HTMLElement>(
      `[data-preview-content] #${CSS.escape(heading.slug)}`,
    )
    element?.scrollIntoView({ block: 'start' })
  }
</script>

<div class="preview-layout">
  <div
    bind:this={scroller}
    class="preview-scroller"
    data-preview-scroller
    data-pane={pane}
    aria-label={i18n.t('workspace.preview_only')}
    style:--prose-size={`${settings.current.appearance.proseSize}px`}
    style:--prose-line={settings.current.appearance.proseLineHeight}
    style:--prose-width={width}
  >
    <div
      class="preview-page"
      class:serif={settings.current.appearance.proseFont === 'serif'}
    >
      <MarkdownArticle
        {noteId}
        {source}
        {services}
        math={settings.current.preview.math}
        mermaid={settings.current.preview.mermaid}
        {dark}
        {collapseLines}
        onHeadings={(value) => (headings = value)}
        onReady={ready}
        onImage={image}
        onTag={(tag) => ui.openView('tag', { tag })}
      />
    </div>
  </div>
  {#if scroller && ui.outlineOpen && ui.activePane === pane}<Outline
      {headings}
      {scroller}
      onSelect={select}
    />{/if}
</div>
{#if pane === 'primary'}<Lightbox
    onCloseFocus={() => restoreLightboxFocus(ui)}
  />{/if}

<style>
  /* Hallmark · component: preview · genre: editorial · theme: inherited tokens */
  .preview-layout {
    display: flex;
    flex: 1;
    width: 100%;
    height: 100%;
    min-height: 0;
    min-width: 0;
  }
  .preview-scroller {
    flex: 1;
    min-width: 0;
    height: 100%;
    overflow: auto;
  }
  .preview-page {
    max-width: var(--prose-width);
    margin-inline: auto;
    padding: 28px 32px 80px;
  }
  .serif :global(.ink-prose) {
    font-family: var(--font-serif);
  }
  @media (max-width: 767px) {
    .preview-page {
      padding: 20px 16px 64px;
    }
  }
</style>
