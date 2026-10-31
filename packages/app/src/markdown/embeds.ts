import { slugifyHeading } from '@shared/markdown-utils'
import { decodeDataValue } from './data-attr'
import { parseWikiTarget, renderMarkdown } from './renderer'

export interface ResolvedNote {
  id: string
  title: string
  content: string
}

export interface RenderServices {
  resolveNote(target: string, signal: AbortSignal): Promise<ResolvedNote | null>
  resolveAssetUrl(url: string): string
  openNote(target: string): void
  toggleTask(line: number, checked: boolean): Promise<void>
}

export interface EmbedOptions {
  readonly signal: AbortSignal
  readonly maxDepth?: number
  readonly maxEmbeds?: number
}

export async function resolveNoteEmbeds(
  root: HTMLElement,
  services: RenderServices,
  options: EmbedOptions,
): Promise<void> {
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
    let note: ResolvedNote | null
    try {
      note = await services.resolveNote(parsed.raw, options.signal)
    } catch {
      if (!options.signal.aborted) showEmbedError(embed, parsed.raw)
      continue
    }
    if (options.signal.aborted) return
    if (!note) {
      showEmbedError(embed, 'Missing note')
      continue
    }
    const rendered = renderMarkdown(note.content)
    let body = htmlFragment(rendered.html)
    if (parsed.heading || parsed.blockId) {
      const id = parsed.blockId
        ? `^${parsed.blockId}`
        : slugifyHeading(parsed.heading ?? '')
      const local = [
        ...(embed
          .closest('[data-markdown-example]')
          ?.querySelectorAll<HTMLElement>('[id]') ?? []),
      ].find((element) => element.id === id)
      const selected =
        local ??
        [...body.querySelectorAll<HTMLElement>('[id]')].find(
          (element) => element.id === id,
        )
      if (!selected) {
        showEmbedError(embed, parsed.raw)
        continue
      }
      const section = document.createDocumentFragment()
      section.append(selected.cloneNode(true))
      if (parsed.heading) {
        let next = selected.nextElementSibling
        const level = Number(selected.tagName.slice(1))
        while (
          next &&
          !(
            /^H[1-6]$/.test(next.tagName) &&
            Number(next.tagName.slice(1)) <= level
          )
        ) {
          section.append(next.cloneNode(true))
          next = next.nextElementSibling
        }
      }
      body = section
    }
    embed.classList.remove('loading')
    embed.replaceChildren(createEmbedHeader(note.title), body)
    // Embedded source lines belong to another note, never the host document.
    for (const task of embed.querySelectorAll<HTMLElement>(
      '[role="checkbox"]',
    )) {
      task.setAttribute('aria-disabled', 'true')
      task.tabIndex = -1
    }
    const nextAncestors = new Set(ancestors)
    nextAncestors.add(identity)
    await resolveWithin(
      embed,
      services,
      options,
      depth + 1,
      nextAncestors,
      scope,
    )
  }
}

function createEmbedHeader(title: string): HTMLElement {
  const header = document.createElement('button')
  header.type = 'button'
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
  const link = document.createElement('a')
  link.href = '#'
  link.dataset.wikilink = embed.dataset.embedTarget ?? ''
  link.textContent = message
  embed.replaceChildren(link)
}
