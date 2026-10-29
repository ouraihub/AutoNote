import { describe, expect, it } from 'vitest'
import { parseMcp, parseSearchResponse } from '@ouraihub/aether-core/search/vendor'
import { defaultPreferences, processHits } from '@ouraihub/aether-core/search'

const hit = (title: string, url: string, field: string, value: unknown) => JSON.stringify({ [field]: [{ title, url, ...(typeof value === 'object' ? value : { content: value }) }] })

describe('web search response parsing', () => {
  it('normalizes every provider response shape', () => {
    const fixtures: Array<[string, string]> = [
      ['zhipu', JSON.stringify({ search_result: [{ title: 'Z', link: 'https://example.com/z', content: 'z' }] })],
      ['tavily', hit('T', 'https://example.com/t', 'results', 't')],
      ['searxng', hit('S', 'https://example.com/s', 'results', { url: 'https://example.com/s', content: 's' })],
      ['exa', hit('E', 'https://example.com/e', 'results', { url: 'https://example.com/e', text: 'e' })],
      ['bocha', JSON.stringify({ data: { webPages: { value: [{ name: 'B', url: 'https://example.com/b', summary: 'b' }] } } })],
      ['querit', JSON.stringify({ results: { result: [{ title: 'Q', url: 'https://example.com/q', snippet: 'q' }] } })],
      ['brave', JSON.stringify({ web: { results: [{ title: 'Br', url: 'https://example.com/br', description: 'br' }] } })],
      ['parallel', JSON.stringify({ results: [{ title: 'P', url: 'https://example.com/p', excerpts: ['p'] }] })],
      ['jina', JSON.stringify({ data: [{ title: 'J', url: 'https://example.com/j', content: 'j' }] })],
      ['firecrawl', JSON.stringify({ data: { web: [{ title: 'F', url: 'https://example.com/f', markdown: 'f' }] } })],
    ]
    for (const [provider, body] of fixtures) expect(processHits(parseSearchResponse(provider, body), defaultPreferences())[0]?.url).toMatch(/^https:\/\/example\.com\//)
  })

  it('normalizes nested fields, skips invalid links, and rejects malformed shapes', () => {
    expect(processHits(parseSearchResponse('bocha', JSON.stringify({ data: { webPages: { value: [{ name: '标题', url: 'https://example.com/a', summary: '摘要' }, { name: 'bad', url: 'javascript:bad' }] } } })), defaultPreferences())).toEqual([{ title: '标题', url: 'https://example.com/a', snippet: '摘要' }])
    expect(parseSearchResponse('brave', JSON.stringify({ web: { results: [{ title: 'B', url: 'https://example.com/b', description: 'D' }] } }))).toEqual([{ title: 'B', url: 'https://example.com/b', snippet: 'D' }])
    expect(parseSearchResponse('parallel', JSON.stringify({ results: [{ title: 'P', url: 'https://example.com/p', excerpts: ['one', 'two'] }] }))).toEqual([{ title: 'P', url: 'https://example.com/p', snippet: 'one\ntwo' }])
    expect(() => parseSearchResponse('tavily', '{"unexpected":true}')).toThrow(/invalid result shape/)
  })

  it('parses multiline Exa MCP SSE', () => {
    expect(parseMcp('data: {"result":{"content":[{"text":"Title: T\\nURL: https://example.com/t\\nText: body"}]}}\n\n')).toEqual([{ title: 'T', url: 'https://example.com/t', snippet: 'body' }])
  })
  it('preserves Exa MCP highlights and paragraph breaks between results', () => {
    const body = `data: ${JSON.stringify({ result: { content: [{ text: 'Title: First\nURL: https://example.com/first\nHighlights:\nIntro\n\n# Body\nDetails\n\nTitle: Second\nURL: https://example.com/second\nText: Last' }] } })}\n\n`
    expect(parseMcp(body)).toEqual([
      { title: 'First', url: 'https://example.com/first', snippet: 'Intro\n\n# Body\nDetails' },
      { title: 'Second', url: 'https://example.com/second', snippet: 'Last' },
    ])
  })
  it('preserves response-budgeted snippets and skips malformed entries without dropping later results', () => {
    const snippet = '😀'.repeat(1200)
    const body = JSON.stringify({ results: [null, { title: 'First', url: 'https://example.com/first', content: snippet }, { title: 'duplicate', url: 'https://example.com/first', content: 'ignored' }, { title: 'Second', url: 'https://example.com/second', content: 'second' }] })
    expect(processHits(parseSearchResponse('tavily', body), defaultPreferences())).toEqual([
      { title: 'First', url: 'https://example.com/first', snippet },
      { title: 'Second', url: 'https://example.com/second', snippet: 'second' },
    ])
    const mcp = `data: ${JSON.stringify({ result: { content: [{ text: `Title: First\nURL: https://example.com/first\nText: ${snippet}` }] } })}\n\n`
    expect(parseMcp(mcp)[0]?.snippet).toBe(snippet)
  })
})
