import { BackendError } from '@app/backend'
import { AppError } from '@app/i18n/errors'
import type { MessageKey } from '@shared/locales/en-US'
import type { ListNotesResponse, NoteSummary } from '@shared/types'

export function appendPage(current: readonly NoteSummary[], page: ListNotesResponse, cursor: string | null): NoteSummary[] {
  if (page.nextCursor !== null && page.nextCursor === cursor) throw new BackendError('invalid_response', 502, 'List cursor did not advance')
  const byId = new Map(current.map((note) => [note.id, note]))
  for (const note of page.notes) byId.set(note.id, note)
  return [...byId.values()]
}

export interface BatchResult { id: string; error: unknown | null }

/** Confirm once, flush each entity before reading its current revision, and retain individual failures. */
export async function runNoteBatch(
  ids: readonly string[],
  confirm: () => Promise<boolean>,
  flush: (id: string) => Promise<{ pending: number; failed: number }>,
  mutate: (id: string) => Promise<void>,
  unsafeFlushKey: MessageKey,
): Promise<BatchResult[]> {
  if (!(await confirm())) return []
  const results: BatchResult[] = []
  for (const id of new Set(ids)) {
    try {
      const saved = await flush(id)
      if (saved.pending !== 0 || saved.failed !== 0) throw new AppError(unsafeFlushKey)
      await mutate(id)
      results.push({ id, error: null })
    } catch (error) { results.push({ id, error }) }
  }
  return results
}

export const NOTE_DRAG_TYPE = 'application/x-autonote-note-ids'
