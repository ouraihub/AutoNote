import { describe, expect, test } from 'vitest'
import {
  BackendSessionSchema,
  NoteWriteResultSchema,
  ProgressEventSchema,
  WriteQueueEventSchema,
} from './backend-types'

const note = {
  id: '01j8v2rz4k4ybx4yy1fcp1mv1w',
  title: 'A note',
  excerpt: '',
  folderId: null,
  tags: [],
  isPinned: false,
  isStarred: false,
  isArchived: false,
  wordCount: 2,
  charCount: 6,
  rev: 3,
  position: 0,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  deletedAt: null,
  content: 'Hello.',
}

describe('cross-platform DTO schemas', () => {
  test('accepts a desktop-compatible local backend session', () => {
    const parsed = BackendSessionSchema.safeParse({
      user: {
        id: '01j8v2rz4k4ybx4yy1fcp1mv1w',
        login: 'local',
        username: 'local',
        name: 'Local library',
        avatarUrl: '',
        role: 'owner',
        createdAt: 1_700_000_000_000,
      },
      site: {
        name: 'AutoNote',
        initialized: true,
        registrationOpen: false,
        r2Enabled: false,
        kvEnabled: false,
        attachmentStorage: 'local',
        realtimeEnabled: false,
        version: '0.1.0',
      },
      settings: null,
    })

    expect(parsed.success).toBe(true)
  })

  test('rejects invalid revisions and incorrect nullable write fields', () => {
    expect(
      NoteWriteResultSchema.safeParse({
        queued: true,
        writeId: 'write-1',
        noteId: note.id,
        rev: -1,
      }).success,
    ).toBe(false)
    expect(
      NoteWriteResultSchema.safeParse({
        queued: false,
        writeId: 'write-1',
        note: { ...note, deletedAt: undefined },
      }).success,
    ).toBe(false)
  })

  test('rejects missing write event fields and invalid progress totals', () => {
    expect(
      WriteQueueEventSchema.safeParse({
        kind: 'failed',
        writeId: 'write-1',
        noteId: note.id,
        code: 'offline',
      }).success,
    ).toBe(false)
    expect(
      ProgressEventSchema.safeParse({
        jobId: 'import-1',
        phase: 'reading',
        completed: 2,
        total: -1,
        terminal: false,
      }).success,
    ).toBe(false)
  })
})
