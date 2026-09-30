import { decodeDataValue } from './data-attr'
import { resolveNoteEmbeds, type EmbedOptions, type RenderServices } from './embeds'
import { highlightWithPrism } from './prism'

export interface EnhanceOptions extends EmbedOptions {
  readonly services: RenderServices
  readonly math: boolean
  readonly mermaid: boolean
  readonly dark: boolean
}

export class PreviewEnhancer {
  #generation = 0

  async enhance(root: HTMLElement, options: EnhanceOptions): Promise<void> {
    const generation = ++this.#generation
    await enhancePreview(root, options)
    if (generation !== this.#generation || options.signal.aborted) return
  }

  invalidate(): void {
    this.#generation += 1
  }
}

export async function enhancePreview(root: HTMLElement, options: EnhanceOptions): Promise<void> {
  await highlightCodeBlocks(root, options.signal)
  if (options.signal.aborted) return
  if (options.math) await enhanceMath(root, options.signal)
  else showMathSource(root)
  if (options.signal.aborted) return
  if (options.mermaid) await enhanceMermaid(root, options.dark, options.signal)
  if (options.signal.aborted) return
  await resolveNoteEmbeds(root, options.services, options)
}

async function highlightCodeBlocks(root: HTMLElement, signal: AbortSignal): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('.code-block')]
  await Promise.all(
    blocks.map(async (block) => {
      const code = block.querySelector<HTMLElement>('pre > code')
      if (!code || signal.aborted) return
      const source = code.textContent ?? ''
      const highlighted = await highlightWithPrism(source, block.dataset.lang ?? '')
      if (signal.aborted) return
      if (highlighted) {
        code.innerHTML = highlighted.html
        code.classList.add(`language-${highlighted.language}`)
      } else code.textContent = source
    }),
  )
}

async function enhanceMath(root: HTMLElement, signal: AbortSignal): Promise<void> {
  const pending = [...root.querySelectorAll<HTMLElement>('[data-math]')]
  if (pending.length === 0) return
  try {
    const module = await import('katex')
    if (signal.aborted) return
    const katex = module.default
    for (const node of pending) {
      const source = decodeDataValue(node.dataset.math)
      node.innerHTML = katex.renderToString(source, {
        displayMode: node.classList.contains('math-block'),
        throwOnError: false,
        strict: false,
      })
    }
  } catch {
    showMathSource(root)
  }
}

function showMathSource(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-math]')) {
    const source = decodeDataValue(node.dataset.math)
    node.textContent = node.classList.contains('math-block') ? `$$\n${source}\n$$` : `$${source}$`
    node.classList.add('math-source')
  }
}

async function enhanceMermaid(root: HTMLElement, dark: boolean, signal: AbortSignal): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('.code-block[data-lang="mermaid"]')]
  if (blocks.length === 0) return
  try {
    const module = await import('mermaid')
    if (signal.aborted) return
    const mermaid = module.default
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default' })
    for (const [index, block] of blocks.entries()) {
      const source = block.querySelector('code')?.textContent ?? ''
      const result = await mermaid.render(`autonote-mermaid-${index}`, source)
      if (signal.aborted) return
      block.replaceChildren(htmlFragment(result.svg))
      block.dataset.rendered = 'mermaid'
    }
  } catch {
    // Keep the sanitized code block visible when an optional renderer fails.
  }
}

function htmlFragment(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}
