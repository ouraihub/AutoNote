<script lang="ts">
  import 'katex/dist/katex.min.css'
  import { untrack } from 'svelte'
  import type { RenderServices } from '../../markdown/embeds'
  import { PreviewEnhancer } from '../../markdown/enhance'
  import { renderMarkdown, type Heading } from '../../markdown/renderer'
  import { getI18n, getNotifier } from '../../root/context'
  import { bindArticleInteractions, captureArticleState, prepareArticle, type ArticleState } from './article'

  interface Props {
    noteId: string
    source: string
    services: RenderServices
    math: boolean
    mermaid: boolean
    dark: boolean
    collapseLines: number
    onHeadings(headings: readonly Heading[]): void
    onReady(): void
    onImage(image: HTMLImageElement): void
    onTag(tag: string): void
  }
  let { noteId, source, services, math, mermaid, dark, collapseLines, onHeadings, onReady, onImage, onTag }: Props = $props()
  const i18n = getI18n()
  const notifier = getNotifier()
  const enhancer = new PreviewEnhancer()
  const states = new Map<string, ArticleState>()
  let article = $state<HTMLElement>()
  let generation = 0

  $effect(() => {
    if (!article) return
    const root = article
    const id = noteId
    const committedSource = source
    const options = { math, mermaid, dark, services, collapseLines }
    i18n.locale
    const epoch = ++generation
    const controller = new AbortController()
    const rendered = renderMarkdown(committedSource)
    root.innerHTML = rendered.html
    const prepare = () => prepareArticle(root, { noteId: id, services: options.services, i18n, collapseLines: options.collapseLines, ...(states.has(id) ? { state: states.get(id)! } : {}) })
    untrack(prepare)
    untrack(() => onHeadings(rendered.headings))
    const cleanup = bindArticleInteractions(root, { services: options.services, source: () => source, renderedSource: committedSource, i18n, notifier, onImage, onTag })
    untrack(onReady)
    void enhancer.enhance(root, { services: options.services, math: options.math, mermaid: options.mermaid, dark: options.dark, signal: controller.signal }).then(() => {
      if (epoch !== generation || controller.signal.aborted) return
      const interaction = new Map(states.get(id) ?? [])
      for (const [key, value] of captureArticleState(root)) interaction.set(key, value)
      prepareArticle(root, { noteId: id, services: options.services, i18n, collapseLines: options.collapseLines, state: interaction })
      onReady()
    }).catch(() => {
      if (!controller.signal.aborted) notifier.toast({ key: 'common.action_failed', tone: 'error' })
    })
    return () => {
      states.set(id, captureArticleState(root))
      controller.abort()
      enhancer.invalidate()
      cleanup()
    }
  })
</script>

<article bind:this={article} class="ink-prose" data-preview-content></article>

<style>
  /* Hallmark · component: markdown article · genre: editorial · theme: inherited tokens */
  article { min-width: 0; width: 100%; }
  article :global(img) { max-width: 100%; height: auto; cursor: zoom-in; }
  article :global(pre) { background: var(--bg-inset); font-family: var(--font-mono); padding: 12px; overflow-x: auto; }
  article :global([data-copy]), article :global([data-code-collapse]) { color: var(--text-tertiary); font-size: 12px; padding: 4px 8px; cursor: pointer; border-radius: var(--r-sm); }
  article :global(button:hover) { background: var(--bg-hover); }
  article :global(:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  article :global(.is-code-collapsible:not(.is-code-expanded) pre) { max-height: calc(var(--code-collapse-lines) * 1.65em + 24px); overflow-y: hidden; }
  article :global(.note-embed) { border: 1px solid var(--border-subtle); border-radius: var(--r-md); padding: 12px; margin: 12px 0; }
  article :global(.note-embed-head) { display: block; color: var(--accent); cursor: pointer; font-weight: 600; margin-bottom: 8px; }
  article :global([aria-disabled='true']) { cursor: default; opacity: 0.6; }
  article :global(summary) { cursor: pointer; }
  article :global(svg) { max-width: 100%; height: auto; }
  article :global(.code-line) { display: block; min-height: 1.65em; }
  article :global(.code-line[data-code-number]::before) { content: attr(data-code-number); display: inline-block; min-width: 3ch; margin-right: 12px; color: var(--text-quaternary); user-select: none; }
  article :global(.code-line.is-highlighted) { background: var(--bg-hover); }
  article :global(.code-title) { font: 12px var(--font-mono); color: var(--text-tertiary); margin-right: 8px; }
  article :global(.markdown-example) { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
  article :global(.markdown-example-head) { grid-column: 1 / -1; }
  @media (max-width: 600px) { article :global(.markdown-example) { grid-template-columns: minmax(0, 1fr); } }
</style>
