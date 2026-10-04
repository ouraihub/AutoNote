import {
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete'
import type { EditorView } from '@codemirror/view'
import { normalizeLinkKey } from '@shared/markdown-utils'
import { truncateText } from '@shared/text-utils'

export interface CompletionNote {
  readonly id: string
  readonly title: string
  readonly excerpt: string
}

export interface CompletionTag {
  readonly name: string
  readonly count: number
}

/**
 * Candidate providers for editor completion. A provider may answer synchronously from
 * in-memory state or asynchronously from a search port; the signal aborts as soon as the
 * document changes so a slow lookup can never populate a stale popup.
 */
export interface CompletionSources {
  notes(query: string, signal: AbortSignal): readonly CompletionNote[] | Promise<readonly CompletionNote[]>
  tags(query: string, signal: AbortSignal): readonly CompletionTag[] | Promise<readonly CompletionTag[]>
}

export interface CompletionLabels {
  createNote(): string
  tagCount(count: number): string
}

const WIKI_TRIGGER = /\[\[([^[\]\n]*)$/
const TAG_TRIGGER = /(?:^|[\s(\uff08[\u3010>\u300c\u300e\uff0c,\u3001;\uff1b])#([\p{L}\p{N}_\-/·]{0,60})$/u
const HEADING_LINE = /^#{1,6}\s/
const FENCE_TRIGGER = /^```([a-zA-Z0-9+#-]*)$/
const FENCE_VALID = /^[a-zA-Z0-9+#-]*$/
const MAX_WIKI_OPTIONS = 24
const MAX_TAG_OPTIONS = 20

export const CODE_FENCE_LANGUAGES: readonly string[] = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'sql',
  'bash',
  'shell',
  'powershell',
  'json',
  'yaml',
  'toml',
  'xml',
  'html',
  'css',
  'scss',
  'markdown',
  'diff',
  'dockerfile',
  'nginx',
  'mermaid',
]

/**
 * Completes `[[title` with known note titles plus a "create" entry for unknown text.
 * Results are not cached across keystrokes (no `validFor`) because ranking is computed
 * here rather than by CodeMirror's filter; every edit re-queries and aborts the old query.
 */
export function wikiLinkSource(getSources: () => CompletionSources, labels: CompletionLabels): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.matchBefore(WIKI_TRIGGER)
    if (!before) return null
    const trimmed = before.text.slice(2).trim()
    const notes = await queryProvider(context, (signal) => getSources().notes(trimmed, signal))
    if (!notes) return null

    const ranked: RankedOption[] = []
    const seenTitles = new Set<string>()
    for (const note of notes) {
      if (!note.title) continue
      const titleKey = normalizeLinkKey(note.title)
      if (seenTitles.has(titleKey)) continue
      seenTitles.add(titleKey)
      const score = trimmed ? matchScore(note.title, trimmed) : 0
      if (score === null) continue
      const detail = note.excerpt ? truncateText(note.excerpt, 34) : undefined
      ranked.push({
        score,
        option: { label: note.title, ...(detail ? { detail } : {}), apply: applyWikiTitle(note.title) },
      })
    }
    const options = sortByScore(ranked).slice(0, MAX_WIKI_OPTIONS)
    if (trimmed && !seenTitles.has(normalizeLinkKey(trimmed))) {
      options.push({ label: trimmed, detail: labels.createNote(), apply: applyWikiTitle(trimmed) })
    }
    if (!options.length) return null
    return { from: before.from + 2, options, filter: false }
  }
}

/** Completes inline `#tag` tokens; ATX headings (`# Title`) never trigger it. */
export function tagSource(getSources: () => CompletionSources, labels: CompletionLabels): CompletionSource {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const before = context.matchBefore(TAG_TRIGGER)
    if (!before) return null
    const hashIndex = before.text.lastIndexOf('#')
    const from = before.from + hashIndex + 1
    const query = before.text.slice(hashIndex + 1)
    const line = context.state.doc.lineAt(context.pos)
    if (from - 1 === line.from && HEADING_LINE.test(line.text)) return null
    const tags = await queryProvider(context, (signal) => getSources().tags(query, signal))
    if (!tags) return null

    const ranked: RankedOption[] = []
    for (const tag of tags) {
      const score = query ? matchScore(tag.name, query) : tag.count
      if (score === null) continue
      ranked.push({
        score: score / 10 + Math.min(tag.count, 20) / 10,
        option: { label: tag.name, detail: labels.tagCount(tag.count), type: 'keyword' },
      })
    }
    if (!ranked.length) return null
    return { from, options: sortByScore(ranked).slice(0, MAX_TAG_OPTIONS), filter: false }
  }
}

/** Completes the info string of an opening fence typed at the start of a line. */
export function codeFenceSource(context: CompletionContext): CompletionResult | null {
  const before = context.matchBefore(FENCE_TRIGGER)
  if (!before) return null
  return {
    from: before.from + 3,
    options: CODE_FENCE_LANGUAGES.map((language) => ({ label: language, type: 'type' })),
    validFor: FENCE_VALID,
  }
}

async function queryProvider<T>(
  context: CompletionContext,
  run: (signal: AbortSignal) => readonly T[] | Promise<readonly T[]>,
): Promise<readonly T[] | null> {
  const controller = new AbortController()
  context.addEventListener('abort', () => controller.abort(), { onDocChange: true })
  try {
    const items = await run(controller.signal)
    return controller.signal.aborted || context.aborted ? null : items
  } catch (error) {
    if (controller.signal.aborted) return null
    throw error
  }
}

function applyWikiTitle(title: string) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const closed = view.state.sliceDoc(to, to + 2) === ']]'
    const insert = closed ? title : `${title}]]`
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length + (closed ? 2 : 0) },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete',
    })
  }
}

interface RankedOption {
  readonly score: number
  readonly option: Completion
}

/** With `filter: false` CodeMirror keeps result order, so ranking happens here; the stable sort keeps provider order on ties. */
function sortByScore(ranked: RankedOption[]): Completion[] {
  return ranked.sort((left, right) => right.score - left.score).map(({ option }) => option)
}

/**
 * AutoNote's fuzzy title score: contiguous substring hits rank above scattered
 * subsequence hits; prefixes and word boundaries rank higher; long titles rank lower.
 */
function matchScore(text: string, query: string): number | null {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase().trim()
  if (!needle) return 0
  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    let score = 1000 - direct * 2
    if (direct === 0) score += 300
    else if (isBoundary(haystack, direct)) score += 150
    return score + Math.max(0, 120 - text.length)
  }

  let cursor = 0
  let score = 0
  let streak = 0
  let segments = 0
  for (const character of needle) {
    if (character === ' ') {
      streak = 0
      continue
    }
    const found = haystack.indexOf(character, cursor)
    if (found < 0) return null
    if (found === cursor && segments > 0) {
      streak += 1
      score += 12 + streak * 6
    } else {
      streak = 0
      score += found === 0 ? 40 : isBoundary(haystack, found) ? 22 : 4
      segments += 1
    }
    cursor = found + 1
  }
  return score - Math.floor(text.length / 12) - segments * 2
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  return /[\s\-_/.·\u3001\uff0c,\uff08(\u3010[]/.test(text[index - 1] ?? '')
}
