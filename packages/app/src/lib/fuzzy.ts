export interface FuzzyMatch {
  score: number
  ranges: [number, number][]
}

export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  if (!query) return { score: 0, ranges: [] }
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase().trim()
  if (!needle) return { score: 0, ranges: [] }

  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    let score = 1000 - direct * 2
    if (direct === 0) score += 300
    else if (isBoundary(haystack, direct)) score += 150
    score += Math.max(0, 120 - text.length)
    return { score, ranges: [[direct, direct + needle.length]] }
  }

  const ranges: [number, number][] = []
  let textIndex = 0
  let score = 0
  let streak = 0
  for (const character of needle) {
    if (character === ' ') {
      streak = 0
      continue
    }
    const found = haystack.indexOf(character, textIndex)
    if (found < 0) return null
    if (found === textIndex && ranges.length) {
      streak++
      score += 12 + streak * 6
      ranges[ranges.length - 1]![1] = found + 1
    } else {
      streak = 0
      score += found === 0 ? 40 : isBoundary(haystack, found) ? 22 : 4
      ranges.push([found, found + 1])
    }
    textIndex = found + 1
  }
  score -= Math.floor(text.length / 12)
  score -= ranges.length * 2
  return { score, ranges }
}

function isBoundary(text: string, index: number): boolean {
  if (index === 0) return true
  return /[\s\-_/.·\u3001\uff0c,\uff08(\u3010[]/.test(text[index - 1]!)
}

export function splitByRanges(text: string, ranges: readonly [number, number][]): { text: string; hit: boolean }[] {
  if (!ranges.length) return [{ text, hit: false }]
  const merged = mergeRanges(ranges)
  const parts: { text: string; hit: boolean }[] = []
  let cursor = 0
  for (const [start, end] of merged) {
    if (start > cursor) parts.push({ text: text.slice(cursor, start), hit: false })
    parts.push({ text: text.slice(start, end), hit: true })
    cursor = end
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false })
  return parts.filter((part) => part.text)
}

function mergeRanges(ranges: readonly [number, number][]): [number, number][] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const result: [number, number][] = []
  for (const range of sorted) {
    const previous = result[result.length - 1]
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else result.push([range[0], range[1]])
  }
  return result
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  getText: (item: T) => string,
  limit = 50,
): { item: T; match: FuzzyMatch }[] {
  if (!query.trim()) return items.slice(0, limit).map((item) => ({ item, match: { score: 0, ranges: [] } }))
  const matches: { item: T; match: FuzzyMatch }[] = []
  for (const item of items) {
    const match = fuzzyMatch(getText(item), query)
    if (match) matches.push({ item, match })
  }
  matches.sort((a, b) => b.match.score - a.match.score)
  return matches.slice(0, limit)
}
