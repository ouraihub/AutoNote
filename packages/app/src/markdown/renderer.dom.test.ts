import { describe, expect, test } from 'vitest'
import { decodeDataValue } from './data-attr'
import { parseFenceInfo, parseWikiTarget, renderMarkdown, renderMarkdownBlocks } from './renderer'

describe('renderMarkdown', () => {
  test('renders front matter, GFM tasks, wiki links, tags, callouts, tabs, and live Markdown examples', () => {
    const rendered = renderMarkdown(`---
title: Renderer fixture
---
# Heading

- [x] Done

[[Note title#Section|Open note]] #tag

> [!WARNING]- Attention
> Callout text

::::: tabs
:::: tab-item First
First panel
:::: tab-item Second
Second panel
:::::

~~~~md-example title="Preview"
**Rendered example**
~~~~`)

    expect(rendered.frontMatter).toEqual({ title: 'Renderer fixture' })
    expect(rendered.headings).toEqual([{ level: 1, text: 'Heading', slug: 'heading', line: 3 }])
    expect(rendered.html).toContain('data-task-line')
    expect(rendered.html).toContain('data-wikilink')
    expect(rendered.html).toContain('data-tag')
    expect(rendered.html).toContain('callout-warning')
    expect(rendered.html).toContain('role="tablist"')
    expect(rendered.html).toContain('<strong>Rendered example</strong>')
  })

  test('renders block math as a deferred safe placeholder', () => {
    const rendered = renderMarkdown('$$\na^2 + b^2\n$$')

    expect(rendered.hasMath).toBe(true)
    expect(rendered.html).toContain('class="math-block"')
    expect(rendered.html).toContain('data-math=')
  })

  test('removes executable markup, event attributes, and unsafe URLs', () => {
    const rendered = renderMarkdown(
      '<a href="javascript:alert(1)">bad</a> <img src=x onerror="alert(1)"><script>alert(1)</script>',
    )

    expect(rendered.html).not.toContain('javascript:')
    expect(rendered.html).not.toContain('onerror')
    expect(rendered.html).not.toContain('<script')
  })

  test('maps top-level blocks back to source lines', () => {
    const blocks = renderMarkdownBlocks('# First\n\nParagraph')

    expect(blocks.blocks.length).toBeGreaterThan(0)
    expect(blocks.blocks[0]?.startLine).toBe(0)
    expect(blocks.headings[0]?.line).toBe(0)
  })
})

test('parses Wiki targets and code-fence metadata without executing it', () => {
  expect(parseWikiTarget('Note#^block|Alias')).toEqual({
    raw: 'Note#^block',
    noteTitle: 'Note',
    heading: null,
    blockId: 'block',
    alias: 'Alias',
  })
  expect(parseFenceInfo('ts title="example.ts" line-numbers start=4 {2-3}')).toEqual({
    language: 'ts',
    title: 'example.ts',
    lineNumbers: true,
    startLine: 4,
    highlightedLines: [2, 3],
  })
  expect(decodeDataValue('b64.aGVsbG8')).toBe('hello')
})
