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

export function parseWikiTarget(source: string): WikiTarget {
  const pipe = source.indexOf('|')
  const raw = (pipe < 0 ? source : source.slice(0, pipe)).trim()
  const alias = pipe < 0 ? null : source.slice(pipe + 1).trim() || null
  if (raw.startsWith('^'))
    return { raw, noteTitle: '', heading: null, blockId: raw.slice(1), alias }
  const hash = raw.indexOf('#')
  if (hash < 0)
    return { raw, noteTitle: raw, heading: null, blockId: null, alias }
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
  const title =
    /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|([^\s]+))/
      .exec(source)
      ?.slice(1)
      .find(Boolean) ?? ''
  const lineNumbers =
    /(?:^|\s)(?:line-numbers|linenos|numberLines)(?=\s|$)/.test(source)
  const startLine = Number(
    /(?:^|\s)(?:start|startFrom)=(\d+)/.exec(source)?.[1] ?? 1,
  )
  const highlightedLines = [
    ...(source.match(/\{([\d,\s-]+)\}/)?.[1]?.matchAll(/(\d+)(?:-(\d+))?/g) ??
      []),
  ].flatMap((match) => {
    const first = Number(match[1])
    const last = Number(match[2] ?? first)
    return Array.from(
      { length: Math.min(500, Math.max(0, last - first + 1)) },
      (_, index) => first + index,
    )
  })
  return {
    language,
    title,
    lineNumbers,
    startLine: Number.isFinite(startLine) && startLine > 0 ? startLine : 1,
    highlightedLines,
  }
}
