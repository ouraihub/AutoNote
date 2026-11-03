import type MarkdownIt from 'markdown-it'
import { encodeDataValue } from './data-attr'
import { renderMarkdown } from './renderer'
import { parseFenceInfo, parseWikiTarget } from './renderer-parsing'
import { environment, escapeAttribute, escapeHtml } from './renderer-support'
export function registerOutputRules(markdown: MarkdownIt): void {
  markdown.renderer.rules.note_embed = (tokens, index) => {
    const target = parseWikiTarget(tokens[index]?.content ?? '')
    return (
      '<div class="note-embed loading" data-embed-targe' +
      't="' +
      `${escapeAttribute(encodeDataValue(target.raw))}` +
      '">' +
      `${escapeHtml(target.alias ?? target.raw)}` +
      '</div>'
    )
  }

  markdown.renderer.rules.wikilink = (tokens, index) => {
    const target = parseWikiTarget(tokens[index]?.content ?? '')
    return (
      '<a class="wikilink" href="#" data-wikilink="' +
      `${escapeAttribute(encodeDataValue(target.raw))}` +
      '">' +
      `${escapeHtml(target.alias ?? target.raw)}` +
      '</a>'
    )
  }

  markdown.renderer.rules.inline_tag = (tokens, index) => {
    const name = tokens[index]?.content ?? ''
    return (
      '<span class="inline-tag" data-tag="' +
      `${escapeAttribute(encodeDataValue(name))}` +
      '" role="link" tabindex="0">#' +
      `${escapeHtml(name)}` +
      '</span>'
    )
  }

  markdown.renderer.rules.math_inline = (tokens, index) => {
    const value = tokens[index]?.content ?? ''
    return (
      '<span class="math-inline" data-math="' +
      `${escapeAttribute(encodeDataValue(value))}` +
      '"></span>'
    )
  }

  markdown.renderer.rules.callout_open = (tokens, index, _options, env) => {
    const token = tokens[index]
    const meta = token?.meta as { type: string; fold: string; title: string }
    const line = token?.map
      ? ' data-line="' + `${token.map[0] + environment(env).lineOffset}` + '"'
      : ''
    if (meta.fold)
      return (
        '<details class="callout callout-' +
        `${escapeAttribute(meta.type)}` +
        '" data-callout="' +
        `${escapeAttribute(meta.type)}` +
        '"' +
        `${line}` +
        '' +
        `${meta.fold === '+' ? ' open' : ''}` +
        '><summary class="callout-title">' +
        `${escapeHtml(meta.title)}` +
        '</summary><div class="callout-content">'
      )
    return (
      '<aside class="callout callout-' +
      `${escapeAttribute(meta.type)}` +
      '" data-callout="' +
      `${escapeAttribute(meta.type)}` +
      '"' +
      `${line}` +
      '><div class="callout-title">' +
      `${escapeHtml(meta.title)}` +
      '</div><div class="callout-content">'
    )
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
    if (
      info.language === 'md-example' ||
      info.language === 'markdown-example'
    ) {
      const nested = renderMarkdown(token.content)
      const exampleCode =
        '<div class="code-block" data-lang="markdown"><pr' +
        'e><code>' +
        `${escapeHtml(token.content)}` +
        '</code></pre></div>'
      return (
        '<section class="markdown-example" data-markdown-' +
        'example data-line="' +
        `${(token.map?.[0] ?? 0) + environment(env).lineOffset}` +
        '"><header class="markdown-example-head">' +
        `${escapeHtml(info.title)}` +
        '</header><div class="markdown-example-preview">' +
        `${nested.html}` +
        '</div>' +
        `${exampleCode}` +
        '</section>'
      )
    }
    if (info.language === 'mermaid') environment(env).hasMermaid = true
    const code = defaultFence
      ? defaultFence(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options)
    return (
      '<div class="code-block" data-lang="' +
      `${escapeAttribute(info.language)}` +
      '" data-code-title="' +
      `${escapeAttribute(info.title)}` +
      '" data-line-numbers="' +
      `${info.lineNumbers}` +
      '" data-code-start="' +
      `${info.startLine}` +
      '" data-highlight-lines="' +
      `${info.highlightedLines.join(',')}` +
      '"' +
      `${
        token.map
          ? ` data-line="${token.map[0] + environment(env).lineOffset}"`
          : ''
      }` +
      '>' +
      `${code}` +
      '</div>'
    )
  }

  const defaultImage = markdown.renderer.rules.image

  markdown.renderer.rules.image = (tokens, index, options, env, self) => {
    const token = tokens[index]
    if (token) {
      token.attrSet('loading', 'lazy')
      token.attrSet('decoding', 'async')
      token.attrSet('referrerpolicy', 'no-referrer')
    }
    return defaultImage
      ? defaultImage(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options)
  }

  const defaultLink = markdown.renderer.rules.link_open

  markdown.renderer.rules.link_open = (tokens, index, options, env, self) => {
    const token = tokens[index]
    if (token?.attrGet('href')?.startsWith('http')) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    }
    return defaultLink
      ? defaultLink(tokens, index, options, env, self)
      : self.renderToken(tokens, index, options)
  }
}
