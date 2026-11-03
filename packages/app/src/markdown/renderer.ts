import { parseFrontMatter } from '@shared/markdown-utils'
import { markdown } from './renderer-engine'
import {
  createEnvironment,
  sanitize,
  stripObsidianComments,
} from './renderer-support'

export interface Heading {
  readonly level: number
  readonly text: string
  readonly slug: string
  readonly line: number
}

export interface RenderResult {
  readonly html: string
  readonly headings: readonly Heading[]
  readonly hasMath: boolean
  readonly hasMermaid: boolean
  readonly hasEmbeds: boolean
  readonly frontMatter: Readonly<Record<string, unknown>>
  readonly frontMatterErrors: readonly string[]
}

export interface MarkdownBlock {
  readonly startLine: number
  readonly endLine: number
  readonly html: string
}

export interface RenderEnvironment {
  headings: Heading[]
  hasMath: boolean
  hasMermaid: boolean
  hasEmbeds: boolean
  frontMatter: Record<string, unknown>
  frontMatterErrors: string[]
  tabSequence: number
  lineOffset: number
}

export function renderMarkdown(source: string): RenderResult {
  const frontMatter = parseFrontMatter(source)
  const env = createEnvironment(frontMatter, frontMatter.lineOffset)
  const html = sanitize(
    markdown.render(stripObsidianComments(frontMatter.body), env),
  )
  return {
    html,
    headings: env.headings,
    hasMath: env.hasMath,
    hasMermaid: env.hasMermaid,
    hasEmbeds: env.hasEmbeds,
    frontMatter: env.frontMatter,
    frontMatterErrors: env.frontMatterErrors,
  }
}

export function renderMarkdownBlocks(source: string): {
  blocks: readonly MarkdownBlock[]
  headings: readonly Heading[]
} {
  const rendered = renderMarkdown(source)
  const template = document.createElement('template')
  template.innerHTML = rendered.html
  const elements = [...template.content.children].filter((element) =>
    element.hasAttribute('data-line'),
  )
  const lineCount = source.split('\n').length
  const blocks = elements.map((element, index) => ({
    startLine: Number(element.getAttribute('data-line')),
    endLine: Number(
      elements[index + 1]?.getAttribute('data-line') ?? lineCount,
    ),
    html: element.outerHTML,
  }))
  return { blocks, headings: rendered.headings }
}

export {
  createEnvironment,
  environment,
  escapeAttribute,
  escapeHtml,
  findClosingToken,
  sanitize,
  sourceLine,
  stripObsidianComments,
  tabItems,
} from './renderer-support'

export {
  parseFenceInfo,
  parseWikiTarget,
  type FenceInfo,
  type WikiTarget,
} from './renderer-parsing'
