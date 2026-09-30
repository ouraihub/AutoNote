import createDOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import anchor from 'markdown-it-anchor'
import footnote from 'markdown-it-footnote'
import mark from 'markdown-it-mark'
import taskLists from 'markdown-it-task-lists'
import { parseFrontMatter, slugifyHeading } from '@shared/markdown-utils'
import { encodeDataValue } from './data-attr.ts'

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

interface RenderEnvironment {
  headings: Heading[]
  hasMath: boolean
  hasMermaid: boolean
  hasEmbeds: boolean
  frontMatter: Record<string, unknown>
  frontMatterErrors: string[]
  tabSequence: number
  lineOffset: number
}

const DOM_PURIFY = createDOMPurify(window)
const WIKI_LINK = /^\[\[([^[\]\n]{1,400})\]\]/
const NOTE_EMBED = /^!\[\[([^[\]\n]{1,400})\]\]/
const INLINE_TAG = /^#([\p{L}\p{N}_\-/·]{1,60})(?![\p{L}\p{N}_\-/·])/u
const CALL_OUT = /^\[!([A-Za-z][A-Za-z0-9_-]{0,31})\]([+-])?(?:[ \t]+(.+?))?[ \t]*$/
const MATH_INLINE = /^\$(?!\s)((?:[^$\\]|\\.)+?)(?<!\s)\$/

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

markdown.block.ruler.before('fence', 'autonote_containers', (state, startLine, endLine, silent) => {
  const opener = sourceLine(state, startLine)
  const details = /^:::\s+details(?:\s+\[([^\]]+)\])?\s*$/.exec(opener)
  const tabs = /^:::::\s+tabs\s*$/.test(opener)
  if (!details && !tabs) return false
  if (silent) return true

  const marker = details ? ':::' : ':::::'
  let closeLine = startLine + 1
  while (closeLine < endLine && sourceLine(state, closeLine).trim() !== marker) closeLine += 1
  if (closeLine >= endLine) return false

  if (details) {
    const open = state.push('details_open', 'details', 1)
    open.map = [startLine + environment(state.env).lineOffset, closeLine + environment(state.env).lineOffset + 1]
    const summary = state.push('details_summary', 'summary', 0)
    summary.content = details[1]?.trim() || 'Details'
    state.md.block.parse(
      state.getLines(startLine + 1, closeLine, state.blkIndent, false),
      state.md,
      state.env,
      state.tokens,
    )
    state.push('details_close', 'details', -1)
  } else {
    const env = environment(state.env)
    const id = `tabs-${env.tabSequence++}`
    const items = tabItems(state, startLine + 1, closeLine)
    const open = state.push('tabs_open', 'div', 1)
    open.map = [startLine + env.lineOffset, closeLine + env.lineOffset + 1]
    open.meta = { id, titles: items.map((item) => item.title) }
    for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
      const item = items[itemIndex]
      if (!item) continue
      const panel = state.push('tab_panel_open', 'section', 1)
      panel.meta = { id, index: itemIndex, selected: itemIndex === 0 }
      state.md.block.parse(item.body, state.md, state.env, state.tokens)
      state.push('tab_panel_close', 'section', -1)
    }
    state.push('tabs_close', 'div', -1)
  }
  state.line = closeLine + 1
  return true
})

markdown.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  const opener = sourceLine(state, startLine)
  if (!opener.startsWith('$$')) return false
  let closeLine = startLine
  let content = opener.slice(2)
  if (!content.trim().endsWith('$$')) {
    for (closeLine = startLine + 1; closeLine < endLine; closeLine += 1) {
      const line = sourceLine(state, closeLine)
      if (line.trim().endsWith('$$')) {
        content += `\n${line.slice(0, line.lastIndexOf('$$'))}`
        break
      }
      content += `\n${line}`
    }
    if (closeLine >= endLine) return false
  } else content = content.trim().slice(0, -2)
  if (silent) return true
  const token = state.push('math_block', 'div', 0)
  token.map = [startLine, closeLine + 1]
  token.content = content.trim()
  environment(state.env).hasMath = true
  state.line = closeLine + 1
  return true
})

markdown.renderer.rules.math_block = (tokens, index, _options, env) => {
  const token = tokens[index]
  const line = token?.map ? ` data-line="${token.map[0] + environment(env).lineOffset}"` : ''
  return `<div class="math-block"${line} data-math="${escapeAttribute(encodeDataValue(token?.content ?? ''))}"></div>`
}

markdown.renderer.rules.details_open = (tokens, index, _options, env) =>
  `<details class="markdown-details" data-line="${(tokens[index]?.map?.[0] ?? 0) + environment(env).lineOffset}">`
markdown.renderer.rules.details_summary = (tokens, index) =>
  `<summary>${escapeHtml(tokens[index]?.content ?? '')}</summary>`
markdown.renderer.rules.details_close = () => '</details>'
markdown.renderer.rules.tabs_open = (tokens, index) => {
  const meta = tokens[index]?.meta as { id: string; titles: string[] }
  const controls = meta.titles
    .map(
      (title, itemIndex) =>
        `<button type="button" role="tab" id="${meta.id}-tab-${itemIndex}" aria-controls="${meta.id}-panel-${itemIndex}" aria-selected="${itemIndex === 0}" tabindex="${itemIndex === 0 ? '0' : '-1'}" data-tab-button="${itemIndex}">${escapeHtml(title)}</button>`,
    )
    .join('')
  return `<div class="markdown-tabs" data-tabs><div class="tab-list" role="tablist">${controls}</div>`
}
markdown.renderer.rules.tabs_close = () => '</div>'
markdown.renderer.rules.tab_panel_open = (tokens, index) => {
  const meta = tokens[index]?.meta as { id: string; index: number; selected: boolean }
  return `<section class="tab-panel" role="tabpanel" id="${meta.id}-panel-${meta.index}" aria-labelledby="${meta.id}-tab-${meta.index}"${meta.selected ? '' : ' hidden'}>`
}
markdown.renderer.rules.tab_panel_close = () => '</section>'

markdown.inline.ruler.before('image', 'note_embed', (state, silent) => {
  if (!state.src.startsWith('![[', state.pos)) return false
  const match = NOTE_EMBED.exec(state.src.slice(state.pos))
  if (!match) return false
  if (!silent) {
    const token = state.push('note_embed', 'div', 0)
    token.content = match[1]?.trim() ?? ''
    environment(state.env).hasEmbeds = true
  }
  state.pos += match[0].length
  return true
})

markdown.inline.ruler.before('link', 'wikilink', (state, silent) => {
  if (!state.src.startsWith('[[', state.pos)) return false
  const match = WIKI_LINK.exec(state.src.slice(state.pos))
  if (!match) return false
  if (!silent) {
    const token = state.push('wikilink', 'a', 0)
    token.content = match[1]?.trim() ?? ''
  }
  state.pos += match[0].length
  return true
})

markdown.inline.ruler.before('text', 'inline_tag', (state, silent) => {
  if (state.src[state.pos] !== '#') return false
  const previous = state.pos === 0 ? ' ' : (state.src[state.pos - 1] ?? '')
  if (state.pos > 0 && !/[\s(（【>「『，,、;；]/u.test(previous)) return false
  const match = INLINE_TAG.exec(state.src.slice(state.pos))
  if (!match) return false
  if (!silent) {
    const token = state.push('inline_tag', 'span', 0)
    token.content = match[1] ?? ''
  }
  state.pos += match[0].length
  return true
})

markdown.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  if (state.src[state.pos] !== '$') return false
  const match = MATH_INLINE.exec(state.src.slice(state.pos))
  if (!match) return false
  if (!silent) {
    const token = state.push('math_inline', 'span', 0)
    token.content = match[1] ?? ''
    environment(state.env).hasMath = true
  }
  state.pos += match[0].length
  return true
})

markdown.core.ruler.after('block', 'obsidian_callouts', (state) => {
  for (let index = 0; index < state.tokens.length; index += 1) {
    const open = state.tokens[index]
    const paragraphOpen = state.tokens[index + 1]
    const inline = state.tokens[index + 2]
    if (open?.type !== 'blockquote_open' || paragraphOpen?.type !== 'paragraph_open' || inline?.type !== 'inline')
      continue
    const firstBreak = inline.content.indexOf('\n')
    const firstLine = firstBreak < 0 ? inline.content : inline.content.slice(0, firstBreak)
    const marker = CALL_OUT.exec(firstLine)
    if (!marker) continue
    const closeIndex = findClosingToken(state.tokens, index, 'blockquote_open', 'blockquote_close')
    if (closeIndex < 0) continue
    const type = marker[1]?.toLowerCase() ?? 'note'
    const fold = marker[2] ?? ''
    const title = marker[3]?.trim() || type[0]?.toUpperCase() + type.slice(1)
    open.type = 'callout_open'
    open.tag = fold ? 'details' : 'aside'
    open.meta = { type, fold, title }
    const close = state.tokens[closeIndex]
    if (!close) continue
    close.type = 'callout_close'
    close.tag = open.tag
    close.meta = { fold }
    const rest = firstBreak < 0 ? '' : inline.content.slice(firstBreak + 1)
    if (rest.trim()) {
      inline.content = rest
      inline.children = []
      state.md.inline.parse(rest, state.md, state.env, inline.children)
    } else state.tokens.splice(index + 1, 3)
  }
  return true
})

markdown.core.ruler.after('github-task-lists', 'task_placeholders', (state) => {
  for (let index = 2; index < state.tokens.length; index += 1) {
    const inline = state.tokens[index]
    const paragraph = state.tokens[index - 1]
    const item = state.tokens[index - 2]
    if (inline?.type !== 'inline' || paragraph?.type !== 'paragraph_open' || item?.type !== 'list_item_open') continue
    const checkbox = inline.children?.find(
      (token) => token.type === 'html_inline' && token.content.includes('task-list-item-checkbox'),
    )
    if (!checkbox || item.map?.[0] === undefined) continue
    const checked = /\schecked(?:=|\s|>)/.test(checkbox.content)
    checkbox.content = `<span class="task-checkbox-placeholder" role="checkbox" tabindex="0" aria-checked="${checked}" data-task-line="${item.map[0] + environment(state.env).lineOffset}"></span>`
    item.attrSet('data-task-line', String(item.map[0] + environment(state.env).lineOffset))
    if (checked) item.attrJoin('class', 'done')
  }
  return true
})

markdown.core.ruler.push('source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.type.endsWith('_open') && token.level === 0) {
      token.attrSet('data-line', String(token.map[0] + environment(state.env).lineOffset))
    }
  }
  return true
})

markdown.core.ruler.push('collect_headings', (state) => {
  const env = environment(state.env)
  env.headings = []
  for (let index = 0; index < state.tokens.length; index += 1) {
    const token = state.tokens[index]
    if (token?.type !== 'heading_open') continue
    const inline = state.tokens[index + 1]
    const text = inline?.content ?? ''
    env.headings.push({
      level: Number(token.tag.slice(1)),
      text,
      slug: token.attrGet('id') ?? slugifyHeading(text),
      line: (token.map?.[0] ?? 0) + env.lineOffset,
    })
  }
  return true
})

markdown.renderer.rules.note_embed = (tokens, index) => {
  const target = parseWikiTarget(tokens[index]?.content ?? '')
  return `<div class="note-embed loading" data-embed-target="${escapeAttribute(encodeDataValue(target.raw))}">${escapeHtml(target.alias ?? target.raw)}</div>`
}
markdown.renderer.rules.wikilink = (tokens, index) => {
  const target = parseWikiTarget(tokens[index]?.content ?? '')
  return `<a class="wikilink" href="#" data-wikilink="${escapeAttribute(encodeDataValue(target.raw))}">${escapeHtml(target.alias ?? target.raw)}</a>`
}
markdown.renderer.rules.inline_tag = (tokens, index) => {
  const name = tokens[index]?.content ?? ''
  return `<span class="inline-tag" data-tag="${escapeAttribute(encodeDataValue(name))}" role="link" tabindex="0">#${escapeHtml(name)}</span>`
}
markdown.renderer.rules.math_inline = (tokens, index) => {
  const value = tokens[index]?.content ?? ''
  return `<span class="math-inline" data-math="${escapeAttribute(encodeDataValue(value))}"></span>`
}
markdown.renderer.rules.callout_open = (tokens, index, _options, env) => {
  const token = tokens[index]
  const meta = token?.meta as { type: string; fold: string; title: string }
  const line = token?.map ? ` data-line="${token.map[0] + environment(env).lineOffset}"` : ''
  if (meta.fold)
    return `<details class="callout callout-${escapeAttribute(meta.type)}" data-callout="${escapeAttribute(meta.type)}"${line}${meta.fold === '+' ? ' open' : ''}><summary class="callout-title">${escapeHtml(meta.title)}</summary><div class="callout-content">`
  return `<aside class="callout callout-${escapeAttribute(meta.type)}" data-callout="${escapeAttribute(meta.type)}"${line}><div class="callout-title">${escapeHtml(meta.title)}</div><div class="callout-content">`
}
markdown.renderer.rules.callout_close = (tokens, index) => {
  const meta = tokens[index]?.meta as { fold: string }
  return `</div>${meta.fold ? '</details>' : '</aside>'}`
}

const defaultFence = markdown.renderer.rules.fence
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const token = tokens[index]
  if (!token) return ''
  const info = parseFenceInfo(token.info)
  if (info.language === 'md-example' || info.language === 'markdown-example') {
    const nested = renderMarkdown(token.content)
    return `<section class="markdown-example" data-markdown-example><header class="markdown-example-head">${escapeHtml(info.title)}</header><div class="markdown-example-preview">${nested.html}</div></section>`
  }
  if (info.language === 'mermaid') environment(env).hasMermaid = true
  const code = defaultFence ? defaultFence(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
  return `<div class="code-block" data-lang="${escapeAttribute(info.language)}"${token.map ? ` data-line="${token.map[0] + environment(env).lineOffset}"` : ''}>${code}</div>`
}

const defaultImage = markdown.renderer.rules.image
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]
  if (token) {
    token.attrSet('loading', 'lazy')
    token.attrSet('decoding', 'async')
    token.attrSet('referrerpolicy', 'no-referrer')
  }
  return defaultImage ? defaultImage(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}

const defaultLink = markdown.renderer.rules.link_open
markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
  const token = tokens[index]
  if (token?.attrGet('href')?.startsWith('http')) {
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
  }
  return defaultLink ? defaultLink(tokens, index, options, env, self) : self.renderToken(tokens, index, options)
}

export function renderMarkdown(source: string): RenderResult {
  const frontMatter = parseFrontMatter(source)
  const env = createEnvironment(frontMatter, frontMatter.lineOffset)
  const html = sanitize(markdown.render(frontMatter.body, env))
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
  const blockPattern =
    /<(?:h[1-6]|p|ul|ol|blockquote|aside|details|div|table)[^>]*data-line="(\d+)"[^>]*>[\s\S]*?<\/(?:h[1-6]|p|ul|ol|blockquote|aside|details|div|table)>/g
  const blocks = [...rendered.html.matchAll(blockPattern)].map((match) => ({
    startLine: Number(match[1]),
    endLine: Number(match[1]) + 1,
    html: match[0],
  }))
  return { blocks, headings: rendered.headings }
}

export function parseWikiTarget(source: string): WikiTarget {
  const pipe = source.indexOf('|')
  const raw = (pipe < 0 ? source : source.slice(0, pipe)).trim()
  const alias = pipe < 0 ? null : source.slice(pipe + 1).trim() || null
  if (raw.startsWith('^')) return { raw, noteTitle: '', heading: null, blockId: raw.slice(1), alias }
  const hash = raw.indexOf('#')
  if (hash < 0) return { raw, noteTitle: raw, heading: null, blockId: null, alias }
  const noteTitle = raw.slice(0, hash).trim()
  const fragment = raw.slice(hash + 1).trim()
  return {
    raw,
    noteTitle,
    heading: fragment.startsWith('^') ? null : fragment || null,
    blockId: fragment.startsWith('^') ? fragment.slice(1) : null,
    alias,
  }
}

export function parseFenceInfo(source: string): FenceInfo {
  const language = /^([^\s{]+)/.exec(source.trim())?.[1]?.toLowerCase() ?? ''
  const title = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|([^\s]+))/.exec(source)?.slice(1).find(Boolean) ?? ''
  const lineNumbers = /(?:^|\s)(?:line-numbers|linenos|numberLines)(?=\s|$)/.test(source)
  const startLine = Number(/(?:^|\s)(?:start|startFrom)=(\d+)/.exec(source)?.[1] ?? 1)
  const highlightedLines = [...(source.match(/\{([\d,\s-]+)\}/)?.[1]?.matchAll(/(\d+)(?:-(\d+))?/g) ?? [])].flatMap(
    (match) => {
      const first = Number(match[1])
      const last = Number(match[2] ?? first)
      return Array.from({ length: Math.min(500, Math.max(0, last - first + 1)) }, (_, index) => first + index)
    },
  )
  return {
    language,
    title,
    lineNumbers,
    startLine: Number.isFinite(startLine) && startLine > 0 ? startLine : 1,
    highlightedLines,
  }
}

function createEnvironment(
  frontMatter: { data: Record<string, unknown>; errors: string[] },
  lineOffset: number,
): RenderEnvironment {
  return {
    headings: [],
    hasMath: false,
    hasMermaid: false,
    hasEmbeds: false,
    frontMatter: frontMatter.data,
    frontMatterErrors: frontMatter.errors,
    tabSequence: 0,
    lineOffset,
  }
}

function environment(value: unknown): RenderEnvironment {
  return value as RenderEnvironment
}

function sanitize(html: string): string {
  return DOM_PURIFY.sanitize(html, {
    ADD_ATTR: [
      'data-line',
      'data-math',
      'data-wikilink',
      'data-embed-target',
      'data-tag',
      'data-lang',
      'data-callout',
      'target',
      'loading',
      'decoding',
      'referrerpolicy',
      'open',
      'role',
      'tabindex',
    ],
    ADD_TAGS: ['aside', 'details', 'summary', 'section', 'header'],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'link', 'base'],
    FORBID_ATTR: [
      'style',
      'onerror',
      'onload',
      'onclick',
      'onchange',
      'oninput',
      'onfocus',
      'srcdoc',
      'formaction',
      'action',
    ],
    ALLOW_DATA_ATTR: true,
  })
}

function findClosingToken(
  tokens: readonly { type: string; nesting: number }[],
  start: number,
  open: string,
  close: string,
): number {
  let depth = 0
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) continue
    if (token.type === open) depth += 1
    if (token.type === close && --depth === 0) return index
  }
  return -1
}

function sourceLine(state: { bMarks: number[]; eMarks: number[]; src: string }, line: number): string {
  return state.src.slice(state.bMarks[line] ?? 0, state.eMarks[line] ?? 0)
}

function tabItems(
  state: { bMarks: number[]; eMarks: number[]; src: string },
  startLine: number,
  endLine: number,
): Array<{ title: string; body: string }> {
  const items: Array<{ title: string; body: string }> = []
  let title: string | null = null
  let body: string[] = []
  for (let line = startLine; line < endLine; line += 1) {
    const source = sourceLine(state, line)
    const match = /^::::\s+tab-item\s+(.+?)\s*$/.exec(source)
    if (match) {
      if (title !== null) items.push({ title, body: body.join('\n') })
      title = match[1] ?? ''
      body = []
    } else if (title !== null) body.push(source)
  }
  if (title !== null) items.push({ title, body: body.join('\n') })
  return items
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character,
  )
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/\n/g, '&#10;')
}
