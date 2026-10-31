import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import footnote from 'markdown-it-footnote'
import mark from 'markdown-it-mark'
import taskLists from 'markdown-it-task-lists'
import { parseFrontMatter, slugifyHeading } from '@shared/markdown-utils'
import {
  createEnvironment,
  sanitize,
  stripObsidianComments,
} from './renderer-utils.ts'
import { installRendererRules } from './renderer-rules.ts'
export interface WikiTarget {
  readonly raw: string
  readonly noteTitle: string
  readonly heading: string | null
  readonly blockId: string | null
  readonly alias: string | null
}

export interface FenceInfo {
  readonly language: string
  readonly title: string
  readonly lineNumbers: boolean
  readonly startLine: number
  readonly highlightedLines: readonly number[]
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

export { parseFenceInfo, parseWikiTarget } from './renderer-utils.ts'

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: false,
  typographer: false,
  langPrefix: 'language-',
})
markdown
  .use(taskLists, { enabled: true, label: false })
  .use(footnote)
  .use(mark)
  .use(anchor, { slugify: slugifyHeading })
installRendererRules(markdown, (source) => renderMarkdown(source))
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
