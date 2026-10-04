import { describe, expect, it } from 'vitest'
import { sortOutboxForReplay } from './order'
import type { OutboxItem } from './types'

const item = (writeId: string, createdAt: number, dependsOnWriteId?: string): OutboxItem => ({
  id: `patch:c:${writeId}`,
  clientId: 'c',
  writeId,
  ...(dependsOnWriteId === undefined ? {} : { dependsOnWriteId }),
  noteId: 'n',
  payload: { rev: 1, content: writeId, contentDirty: true },
  attempts: 0,
  createdAt,
})

describe('sortOutboxForReplay', () => {
  it('puts acyclic dependencies first and terminates on a cycle', () => {
    const ordered = sortOutboxForReplay([item('a', 1, 'b'), item('b', 2), item('c', 3)])
    expect(ordered.map(({ writeId }) => writeId)).toEqual(['b', 'a', 'c'])
    const cycle = sortOutboxForReplay([item('a', 1, 'b'), item('b', 2, 'a')])
    expect(cycle.map(({ writeId }) => writeId).sort()).toEqual(['a', 'b'])
  })
})
