import { decodeDataValue } from './data-attr'
import { parseWikiTarget, renderMarkdown } from './renderer'

export interface RenderServices {
  resolveNote(target: string, signal: AbortSignal): Promise<{ id: string; title: string; content: string } | null>
  resolveAssetUrl(url: string): string
  openNote(target: string): void
  toggleTask(line: number, checked: boolean): Promise<void>
}

export interface EmbedOptions {
  readonly signal: AbortSignal
  readonly maxDepth?: number
  readonly maxEmbeds?: number
}

export async function resolveNoteEmbeds(root: HTMLElement, services: RenderServices, options: EmbedOptions): Promise<void> {
  const scope = { count: 0, maxEmbeds: options.maxEmbeds ?? 24 }
  await resolveWithin(root, services, options, 0, new Set(), scope)
}

async function resolveWithin(
  root: HTMLElement,
  services: RenderServices,
  options: EmbedOptions,
  depth: number,
  ancestors: ReadonlySet<string>,
  scope: { count: number; maxEmbeds: number },
): Promise<void> {
  if (depth >= (options.maxDepth ?? 4) || options.signal.aborted) return
  const embeds = [...root.querySelectorAll<HTMLElement>('[data-embed-target]')]
  for (const embed of embeds) {
    if (options.signal.aborted || scope.count >= scope.maxEmbeds) return
    const encodedTarget = embed.dataset.embedTarget
    if (!encodedTarget) continue
    const parsed = parseWikiTarget(decodeDataValue(encodedTarget))
    const identity = parsed.noteTitle || parsed.raw
    if (!identity || ancestors.has(identity)) {
      showEmbedError(embed, 'Circular embed')
      continue
    }
    scope.count += 1
    const note = await services.resolveNote(parsed.noteTitle || parsed.raw, options.signal)
    if (options.signal.aborted) return
    if (!note) {
      showEmbedError(embed, 'Missing note')
      continue
    }
    const rendered = renderMarkdown(note.content)
    embed.classList.remove('loading')
    embed.replaceChildren(createEmbedHeader(note.title), htmlFragment(rendered.html))
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(identity)
    await resolveWithin(embed, services, options, depth + 1, nextAncestors, scope)
  }
}

function createEmbedHeader(title: string): HTMLElement {
  const header = document.createElement('span')
  header.className = 'note-embed-head'
  header.textContent = title
  return header
}

function htmlFragment(html: string): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content
}

function showEmbedError(embed: HTMLElement, message: string): void {
  embed.classList.remove('loading')
  embed.textContent = message
}
