import { expect, test } from 'vitest'
import { backendContractCases, type BackendContractFixture } from './index'
import type { Backend } from '../port'
import type { Note } from '@shared/types'

const createReadSourceCase = backendContractCases.find((contractCase) => contractCase.name === 'create-read-source')
if (!createReadSourceCase) throw new Error('Missing create-read-source backend contract case')

test('rejects a backend that changes note source after create', async () => {
  const fixture: BackendContractFixture = {
    createBackend: async () => faultyBackend,
    reopenBackend: async () => faultyBackend,
    createFile: (name, mime, bytes) => new File([Uint8Array.from(bytes).buffer], name, { type: mime }),
    readAttachment: async () => new Uint8Array(),
    writeConflictMode: 'reject',
  }

  await expect(createReadSourceCase.run(fixture)).rejects.toThrow('reading a created note must preserve its source')
})

const faultyBackend = {
  notes: {
    create: async (): Promise<Note> => note('written source'),
    get: async (): Promise<Note> => note('changed source'),
  },
  dispose: async (): Promise<void> => {},
} as unknown as Backend

function note(content: string): Note {
  return {
    id: '01j8v2rz4k4ybx4yy1fcp1mv1w',
    title: 'Contract source',
    excerpt: content,
    folderId: null,
    tags: [],
    isPinned: false,
    isStarred: false,
    isArchived: false,
    wordCount: 1,
    charCount: content.length,
    rev: 1,
    position: 0,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    deletedAt: null,
    content,
  }
}
