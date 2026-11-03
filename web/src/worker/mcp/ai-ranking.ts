export const RRF_K = 60

/**
 * Reciprocal-rank fusion: merges two ranked lists into one by rank, so a
 * note that ranks well in both lexical and semantic search surfaces above
 * one that only appears in a single index.
 */
export interface FusedHit<T> {
  item: T
  rrf: number
  sources: Set<'lexical' | 'semantic'>
}

export function fuseByRrf<T extends { id: string }>(
  lexical: readonly T[],
  semantic: readonly T[],
  k = RRF_K,
): FusedHit<T>[] {
  const combined = new Map<string, FusedHit<T>>()
  const push = (list: readonly T[], source: 'lexical' | 'semantic') => {
    for (let index = 0; index < list.length; index++) {
      const item = list[index]!
      const key = item.id
      const existing = combined.get(key)
      if (existing) {
        existing.rrf += 1 / (k + index + 1)
        existing.sources.add(source)
      } else {
        combined.set(key, {
          item,
          rrf: 1 / (k + index + 1),
          sources: new Set([source]),
        })
      }
    }
  }
  push(lexical, 'lexical')
  push(semantic, 'semantic')
  return [...combined.values()].sort(
    (a, b) =>
      b.rrf - a.rrf ||
      b.sources.size - a.sources.size ||
      a.item.id.localeCompare(b.item.id),
  )
}
