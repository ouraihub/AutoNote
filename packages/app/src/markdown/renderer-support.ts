import createDOMPurify from 'dompurify'
import type { RenderEnvironment } from './renderer'

const DOM_PURIFY = createDOMPurify(window)

export function stripObsidianComments(source: string): string {
  let inComment = false
  let fenceChar = ''
  let fenceLength = 0
  return (source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [])
    .map((line) => {
      const ending = /\r\n$|[\r\n]$/.exec(line)?.[0] ?? ''
      const body = ending ? line.slice(0, -ending.length) : line
      const fence = !inComment ? /^ {0,3}(`{3,}|~{3,})/.exec(body) : null
      if (fence?.[1]) {
        const marker = fence[1]
        if (!fenceChar) {
          fenceChar = marker[0]!
          fenceLength = marker.length
        } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
          fenceChar = ''
          fenceLength = 0
        }
        return line
      }
      if (fenceChar) return line
      let output = ''
      let inlineTicks = 0
      for (let index = 0; index < body.length;) {
        if (body[index] === '`' && !inComment) {
          let end = index + 1
          while (body[end] === '`') end += 1
          const ticks = end - index
          if (!inlineTicks || inlineTicks === ticks)
            inlineTicks = inlineTicks ? 0 : ticks
          output += body.slice(index, end)
          index = end
        } else if (
          body.startsWith('%%', index) &&
          body[index - 1] !== '\\' &&
          !inlineTicks
        ) {
          inComment = !inComment
          output += '  '
          index += 2
        } else {
          output += inComment ? ' ' : body[index]
          index += 1
        }
      }
      return output + ending
    })
    .join('')
}

export function createEnvironment(
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

export function environment(value: unknown): RenderEnvironment {
  return value as RenderEnvironment
}

export function sanitize(html: string): string {
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
    FORBID_TAGS: [
      'style',
      'script',
      'iframe',
      'object',
      'embed',
      'form',
      'input',
      'link',
      'base',
    ],
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
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tel):|[^a-z]|[a-z][a-z\d+.-]*(?:[^a-z\d+.-:]|$))/i,
  })
}

export function findClosingToken(
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

export function sourceLine(
  state: { bMarks: number[]; eMarks: number[]; src: string },
  line: number,
): string {
  return state.src.slice(state.bMarks[line] ?? 0, state.eMarks[line] ?? 0)
}

export function tabItems(
  state: { bMarks: number[]; eMarks: number[]; src: string },
  startLine: number,
  endLine: number,
): Array<{ title: string; body: string; startLine: number }> {
  const items: Array<{ title: string; body: string; startLine: number }> = []
  let title: string | null = null
  let body: string[] = []
  let bodyStart = startLine
  for (let line = startLine; line < endLine; line += 1) {
    const source = sourceLine(state, line)
    const match = /^:{3,4}\s+tab-item\s+(.+?)\s*$/.exec(source)
    if (match) {
      if (title !== null)
        items.push({ title, body: body.join('\n'), startLine: bodyStart })
      title = match[1] ?? ''
      body = []
      bodyStart = line + 1
    } else if (title !== null)
      body.push(/^:{3,4}\s*$/.test(source) ? '' : source)
  }
  if (title !== null)
    items.push({ title, body: body.join('\n'), startLine: bodyStart })
  return items
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        character
      ] ?? character,
  )
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/\n/g, '&#10;')
}
