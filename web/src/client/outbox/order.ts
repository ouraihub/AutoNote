import type { OutboxItem } from './types'

/** Stable creation order with dependency-first DFS; a back-edge is ignored. */
export function sortOutboxForReplay(
  items: readonly OutboxItem[],
): OutboxItem[] {
  const stable = [...items].sort(
    (left, right) =>
      left.createdAt - right.createdAt || left.id.localeCompare(right.id),
  )
  const byWriteId = new Map(stable.map((item) => [item.writeId, item]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const result: OutboxItem[] = []
  const visit = (item: OutboxItem): void => {
    if (visited.has(item.writeId) || visiting.has(item.writeId)) return
    visiting.add(item.writeId)
    const dependency =
      item.dependsOnWriteId === undefined
        ? undefined
        : byWriteId.get(item.dependsOnWriteId)
    if (dependency !== undefined) visit(dependency)
    visiting.delete(item.writeId)
    if (!visited.has(item.writeId)) {
      visited.add(item.writeId)
      result.push(item)
    }
  }
  for (const item of stable) visit(item)
  return result
}
