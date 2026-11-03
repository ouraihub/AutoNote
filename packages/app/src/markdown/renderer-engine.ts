import MarkdownIt from 'markdown-it'
import { registerOutputRules } from './renderer-output-rules'

import anchor from 'markdown-it-anchor'

import footnote from 'markdown-it-footnote'

import mark from 'markdown-it-mark'

import taskLists from 'markdown-it-task-lists'

import { slugifyHeading } from '@shared/markdown-utils'

import { encodeDataValue } from './data-attr.ts'

import {
  environment,
  escapeAttribute,
  escapeHtml,
  findClosingToken,
  sourceLine,
  tabItems,
} from './renderer-support'

const WIKI_LINK = /^\[\[([^[\]\n]{1,400})\]\]/

const NOTE_EMBED = /^!\[\[([^[\]\n]{1,400})\]\]/

const INLINE_TAG = /^#([\p{L}\p{N}_\-/·]{1,60})(?![\p{L}\p{N}_\-/·])/u

const CALL_OUT = new RegExp(
  '^\\[!([A-Za-z][A-Za-z0-9_-]{0,31})\\]([+-])?(?:[ \\' + 't]+(.+?))?[ \\t]*$',
  '',
)

const MATH_INLINE = /^\$(?!\s)((?:[^$\\]|\\.)+?)(?<!\s)\$/

export const markdown = new MarkdownIt({
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

markdown.block.ruler.before(
  'fence',
  'autonote_containers',
  (state, startLine, endLine, silent) => {
    const opener = sourceLine(state, startLine)
    const details = /^:::\s+details(?:\s+\[([^\]]+)\])?\s*$/.exec(opener)
    const tabs = /^(:{4,5})\s+tabs\s*$/.exec(opener)
    if (!details && !tabs) return false
    if (silent) return true

    const marker = details ? ':::' : (tabs?.[1] ?? '::::')
    let closeLine = startLine + 1
    while (
      closeLine < endLine &&
      sourceLine(state, closeLine).trim() !== marker
    )
      closeLine += 1
    if (closeLine >= endLine) return false

    if (details) {
      const open = state.push('details_open', 'details', 1)
      open.map = [startLine, closeLine + 1]
      const summary = state.push('details_summary', 'summary', 0)
      summary.content = details[1]?.trim() || 'Details'
      const nested: typeof state.tokens = []
      state.md.block.parse(
        state.getLines(startLine + 1, closeLine, state.blkIndent, false),
        state.md,
        state.env,
        nested,
      )
      for (const token of nested) {
        if (token.map)
          token.map = [
            token.map[0] + startLine + 1,
            token.map[1] + startLine + 1,
          ]
      }
      state.tokens.push(...nested)
      state.push('details_close', 'details', -1)
    } else {
      const env = environment(state.env)
      const id = `tabs-${env.tabSequence++}`
      const items = tabItems(state, startLine + 1, closeLine)
      const open = state.push('tabs_open', 'div', 1)
      open.map = [startLine, closeLine + 1]
      open.meta = { id, titles: items.map((item) => item.title) }
      for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
        const item = items[itemIndex]
        if (!item) continue
        const panel = state.push('tab_panel_open', 'section', 1)
        panel.meta = { id, index: itemIndex, selected: itemIndex === 0 }
        const nested: typeof state.tokens = []
        state.md.block.parse(item.body, state.md, state.env, nested)
        for (const token of nested) {
          if (token.map)
            token.map = [
              token.map[0] + item.startLine,
              token.map[1] + item.startLine,
            ]
        }
        state.tokens.push(...nested)
        state.push('tab_panel_close', 'section', -1)
      }
      state.push('tabs_close', 'div', -1)
    }
    state.line = closeLine + 1
    return true
  },
)

markdown.block.ruler.before(
  'fence',
  'math_block',
  (state, startLine, endLine, silent) => {
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
  },
)

markdown.renderer.rules.math_block = (tokens, index, _options, env) => {
  const token = tokens[index]
  const line = token?.map
    ? ' data-line="' + `${token.map[0] + environment(env).lineOffset}` + '"'
    : ''
  return (
    '<div class="math-block"' +
    `${line}` +
    ' data-math="' +
    `${escapeAttribute(encodeDataValue(token?.content ?? ''))}` +
    '"></div>'
  )
}

markdown.renderer.rules.details_open = (tokens, index, _options, env) =>
  '<details class="markdown-details" data-line="' +
  `${(tokens[index]?.map?.[0] ?? 0) + environment(env).lineOffset}` +
  '">'

markdown.renderer.rules.details_summary = (tokens, index) =>
  '<summary>' + `${escapeHtml(tokens[index]?.content ?? '')}` + '</summary>'

markdown.renderer.rules.details_close = () => '</details>'

markdown.renderer.rules.tabs_open = (tokens, index) => {
  const meta = tokens[index]?.meta as { id: string; titles: string[] }
  const controls = meta.titles
    .map(
      (title, itemIndex) =>
        '<button type="button" role="tab" id="' +
        `${meta.id}` +
        '-tab-' +
        `${itemIndex}` +
        '" aria-controls="' +
        `${meta.id}` +
        '-panel-' +
        `${itemIndex}` +
        '" aria-selected="' +
        `${itemIndex === 0}` +
        '" tabindex="' +
        `${itemIndex === 0 ? '0' : '-1'}` +
        '" data-tab-button="' +
        `${itemIndex}` +
        '">' +
        `${escapeHtml(title)}` +
        '</button>',
    )
    .join('')
  return (
    '<div class="markdown-tabs" data-tabs data-line="' +
    `${tokens[index]?.attrGet('data-line') ?? 0}` +
    '"><div class="tab-list" role="tablist">' +
    `${controls}` +
    '</div>'
  )
}

markdown.renderer.rules.tabs_close = () => '</div>'

markdown.renderer.rules.tab_panel_open = (tokens, index) => {
  const meta = tokens[index]?.meta as {
    id: string
    index: number
    selected: boolean
  }
  return (
    '<section class="tab-panel" role="tabpanel" data-' +
    'tab-panel="' +
    `${meta.index}` +
    '" id="' +
    `${meta.id}` +
    '-panel-' +
    `${meta.index}` +
    '" aria-labelledby="' +
    `${meta.id}` +
    '-tab-' +
    `${meta.index}` +
    '"' +
    `${meta.selected ? '' : ' hidden'}` +
    '>'
  )
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

markdown.core.ruler.before('github-task-lists', 'block_ids', (state) => {
  const seen = new Set<string>()
  for (let index = 1; index < state.tokens.length; index += 1) {
    const inline = state.tokens[index]
    const opening = state.tokens[index - 1]
    if (inline?.type !== 'inline' || !opening || opening.nesting !== 1) continue
    const match = /(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\s*$/.exec(
      inline.content,
    )
    if (!match?.[1]) continue
    let id = match[1]
    let suffix = 2
    while (seen.has(id)) id = `${match[1]}-${suffix++}`
    seen.add(id)
    opening.attrSet('id', `^${id}`)
    inline.content = inline.content.slice(0, match.index).trimEnd()
    inline.children = []
    state.md.inline.parse(inline.content, state.md, state.env, inline.children)
  }
  return true
})

markdown.core.ruler.after('block', 'obsidian_callouts', (state) => {
  for (let index = 0; index < state.tokens.length; index += 1) {
    const open = state.tokens[index]
    const paragraphOpen = state.tokens[index + 1]
    const inline = state.tokens[index + 2]
    if (
      open?.type !== 'blockquote_open' ||
      paragraphOpen?.type !== 'paragraph_open' ||
      inline?.type !== 'inline'
    )
      continue
    const firstBreak = inline.content.indexOf('\n')
    const firstLine =
      firstBreak < 0 ? inline.content : inline.content.slice(0, firstBreak)
    const marker = CALL_OUT.exec(firstLine)
    if (!marker) continue
    const closeIndex = findClosingToken(
      state.tokens,
      index,
      'blockquote_open',
      'blockquote_close',
    )
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
    if (
      inline?.type !== 'inline' ||
      paragraph?.type !== 'paragraph_open' ||
      item?.type !== 'list_item_open'
    )
      continue
    const checkboxIndex =
      inline.children?.findIndex(
        (token) =>
          token.type === 'html_inline' &&
          token.content.includes('task-list-item-checkbox'),
      ) ?? -1
    const checkbox = inline.children?.[checkboxIndex]
    if (!inline.children || !checkbox || item.map?.[0] === undefined) continue
    const checked = /\schecked(?:=|\s|>)/.test(checkbox.content)
    checkbox.content =
      '<span class="task-checkbox-placeholder" role="ch' +
      'eckbox" tabindex="0" aria-checked="' +
      `${checked}` +
      '" data-task-line="' +
      `${item.map[0] + environment(state.env).lineOffset}` +
      '"></span>'
    const labelOpen = new state.Token('html_inline', '', 0)
    labelOpen.content = '<span class="task-label">'
    const labelClose = new state.Token('html_inline', '', 0)
    labelClose.content = '</span>'
    inline.children.splice(checkboxIndex + 1, 0, labelOpen)
    inline.children.push(labelClose)
    item.attrSet(
      'data-task-line',
      String(item.map[0] + environment(state.env).lineOffset),
    )
    if (checked) item.attrJoin('class', 'done')
  }
  return true
})

markdown.core.ruler.push('source_lines', (state) => {
  for (const token of state.tokens) {
    if (token.map && token.type.endsWith('_open')) {
      token.attrSet(
        'data-line',
        String(token.map[0] + environment(state.env).lineOffset),
      )
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
registerOutputRules(markdown)
