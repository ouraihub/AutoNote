import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { describe, expect, test } from 'vitest'
import { codeFenceSource, tagSource, wikiLinkSource, type CompletionSources } from './completion'

const labels = { createNote: () => 'Create new note', tagCount: (count: number) => `${count} notes` }

function sources(overrides: Partial<CompletionSources>): () => CompletionSources {
  return () => ({ notes: () => [], tags: () => [], ...overrides })
}

function contextAt(doc: string, explicit = false, pos = doc.length): CompletionContext {
  return new CompletionContext(EditorState.create({ doc }), pos, explicit)
}

function labelsOf(result: CompletionResult | null): string[] {
  return result?.options.map((option) => option.label) ?? []
}

describe('wikiLinkSource', () => {
  const notes = [
    { id: '1', title: 'Weekly review', excerpt: '' },
    { id: '2', title: 'Project plan', excerpt: 'Milestones and owners for the launch quarter' },
    { id: '3', title: 'project  plan', excerpt: '' },
    { id: '4', title: 'Prose notes', excerpt: '' },
    { id: '5', title: '', excerpt: 'untitled' },
    { id: '6', title: 'Approach', excerpt: '' },
  ]
  const source = wikiLinkSource(sources({ notes: () => notes }), labels)

  test('ranks prefix above inner matches, drops duplicate titles and offers to create unknown text', async () => {
    const result = await source(contextAt('See [[pro'))

    expect(result?.from).toBe('See [['.length)
    expect(labelsOf(result)).toEqual(['Prose notes', 'Project plan', 'Approach', 'pro'])
    expect(result?.options.at(-1)?.detail).toBe('Create new note')
    expect(result?.options.find((option) => option.label === 'Project plan')?.detail?.length).toBeLessThanOrEqual(34)
  })

  test('omits the create entry when the typed text already names a note', async () => {
    expect(labelsOf(await source(contextAt('[[project plan')))).toEqual(['Project plan'])
  })

  test('passes the trimmed query to the provider and lists every title for an explicit empty query', async () => {
    const queries: string[] = []
    const recording = wikiLinkSource(
      sources({
        notes: (query) => {
          queries.push(query)
          return notes
        },
      }),
      labels,
    )

    expect(labelsOf(await recording(contextAt('[[', true)))).toEqual([
      'Weekly review',
      'Project plan',
      'Prose notes',
      'Approach',
    ])
    await recording(contextAt('[[  plan '))
    expect(queries).toEqual(['', 'plan'])
  })

  test('ignores text outside an open link and links closed on the same line', async () => {
    expect(await source(contextAt('plain text'))).toBeNull()
    expect(await source(contextAt('[[Project plan]] and'))).toBeNull()
  })
})

describe('tagSource', () => {
  const tags = [
    { name: 'work', count: 3 },
    { name: 'writing', count: 12 },
    { name: 'home', count: 40 },
  ]
  const source = tagSource(sources({ tags: () => tags }), labels)

  test('completes inline tags with matching names', async () => {
    const result = await source(contextAt('todo #w'))

    expect(result?.from).toBe('todo #'.length)
    expect(labelsOf(result)).toEqual(['writing', 'work'])
    expect(result?.options[0]?.detail).toBe('12 notes')
  })

  test('orders by usage when only the hash is typed', async () => {
    expect(labelsOf(await source(contextAt('note #')))).toEqual(['home', 'writing', 'work'])
  })

  test('does not treat headings, mid-word hashes or unmatched queries as tags', async () => {
    expect(await source(contextAt('# Heading', false, 1))).toBeNull()
    expect(await source(contextAt('issue#w'))).toBeNull()
    expect(await source(contextAt('see #zzz'))).toBeNull()
  })

  test('accepts tags after CJK punctuation', async () => {
    expect(labelsOf(await source(contextAt('记录，#wor')))).toEqual(['work'])
  })
})

describe('codeFenceSource', () => {
  test('offers languages after an opening fence at line start only', () => {
    const result = codeFenceSource(contextAt('intro\n```ty'))

    expect(result?.from).toBe('intro\n```'.length)
    expect(labelsOf(result)).toContain('typescript')
    expect(codeFenceSource(contextAt('text ```ty'))).toBeNull()
  })
})
