import createDOMPurify from 'dompurify'
import { decodeDataValue } from './data-attr'
import { resolveNoteEmbeds, type EmbedOptions, type RenderServices } from './embeds'
import { highlightWithPrism } from './prism'

const purifier = createDOMPurify(window)
let diagramSequence = 0

export interface EnhanceOptions extends EmbedOptions {
  readonly services: RenderServices
  readonly math: boolean
  readonly mermaid: boolean
  readonly dark: boolean
  readonly mermaidRetryLabel?: string
  readonly onMermaidRetry?: () => void
}

export class PreviewEnhancer {
  #generation = 0
  #controller: AbortController | null = null

  async enhance(root: HTMLElement, options: EnhanceOptions): Promise<void> {
    this.invalidate()
    const generation = this.#generation
    const controller = new AbortController()
    this.#controller = controller
    const abort = () => controller.abort()
    options.signal.addEventListener('abort', abort, { once: true })
    if (options.signal.aborted) controller.abort()
    try {
      await enhancePreview(root, { ...options, signal: controller.signal })
      if (generation !== this.#generation || controller.signal.aborted) return
    } finally {
      options.signal.removeEventListener('abort', abort)
      if (this.#controller === controller) this.#controller = null
    }
  }

  invalidate(): void {
    this.#generation += 1
    this.#controller?.abort()
    this.#controller = null
  }
}

export async function enhancePreview(root: HTMLElement, options: EnhanceOptions): Promise<void> {
  await resolveNoteEmbeds(root, options.services, options)
  if (options.signal.aborted) return
  await highlightCodeBlocks(root, options.signal)
  if (options.signal.aborted) return
  if (options.math) await enhanceMath(root, options.signal)
  else showMathSource(root)
  if (options.signal.aborted) return
  if (options.mermaid) await enhanceMermaid(root, options.dark, options.signal, options.mermaidRetryLabel, options.onMermaidRetry)
  if (options.signal.aborted) return
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
      const start = Number(block.dataset.codeStart ?? 1)
      const marked = new Set((block.dataset.highlightLines ?? '').split(',').filter(Boolean).map(Number))
      if (block.dataset.lineNumbers === 'true' || marked.size > 0) {
        const lines = code.innerHTML.split('\n')
        code.replaceChildren(...lines.map((html, index) => {
          const line = document.createElement('span')
          line.className = marked.has(index + 1) ? 'code-line is-highlighted' : 'code-line'
          if (block.dataset.lineNumbers === 'true') line.dataset.codeNumber = String(start + index)
          line.innerHTML = html + (index < lines.length - 1 ? '\n' : '')
          return line
        }))
      }
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
    if (!signal.aborted) showMathSource(root)
  }
}

function showMathSource(root: HTMLElement): void {
  for (const node of root.querySelectorAll<HTMLElement>('[data-math]')) {
    const source = decodeDataValue(node.dataset.math)
    node.textContent = node.classList.contains('math-block') ? `$$\n${source}\n$$` : `$${source}$`
    node.classList.add('math-source')
  }
}

async function enhanceMermaid(root: HTMLElement, dark: boolean, signal: AbortSignal, retryLabel?: string, onRetry?: () => void): Promise<void> {
  const blocks = [...root.querySelectorAll<HTMLElement>('.code-block[data-lang="mermaid"]')]
  if (blocks.length === 0) return
  try {
    const module = await import('mermaid')
    if (signal.aborted) return
    const mermaid = module.default
    // HTML labels live in <foreignObject>, which the SVG sanitizer below strips; SVG <text> survives.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', htmlLabels: false })
    for (const [index, block] of blocks.entries()) {
      const source = block.querySelector('code')?.textContent ?? ''
      const result = await mermaid.render(`autonote-mermaid-${++diagramSequence}-${index}`, source)
      if (signal.aborted) return
      block.replaceChildren(htmlFragment(purifier.sanitize(result.svg, { USE_PROFILES: { svg: true, svgFilters: true } })))
      block.dataset.rendered = 'mermaid'
    }
  } catch {
    if (signal.aborted) return
    for (const block of blocks) {
      if (block.querySelector('[data-mermaid-retry]')) continue
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.mermaidRetry = ''
      button.textContent = retryLabel ?? 'Retry'
      button.onclick = () => onRetry?.()
      block.append(button)
    }
  }
}

function htmlFragment(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}
