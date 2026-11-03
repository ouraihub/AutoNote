import type { BackupRun } from '@shared/types'
import type { LibraryContext } from './library'
import { requireOwnedNote, parseArray } from './library-tail'
import { organizeMcpNote } from './writes'

export async function bulkOrganizeMcpNotes(
  context: LibraryContext,
  operationId: string,
  items: Array<{
    noteId: string
    expectedRev: number
    folderId?: string | null
    starred?: boolean
    archived?: boolean
    pinned?: boolean
  }>,
) {
  const results = []
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!
    try {
      const note = await organizeMcpNote(context, {
        operationId:
          operationId.slice(0, 88) + ':' + String(index).padStart(2, '0'),
        ...item,
      })
      results.push({ note_id: item.noteId, ok: true, rev: note.rev })
    } catch (error) {
      results.push({
        note_id: item.noteId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { results }
}

export async function exploreMcpGraph(
  db: D1Database,
  userId: string,
  origin: string,
  rootId: string,
  depth = 2,
  maxNodes = 60,
) {
  await requireOwnedNote(db, userId, rootId)
  const cappedDepth = Math.max(1, Math.min(3, depth))
  const cappedNodes = Math.max(2, Math.min(100, maxNodes))
  const nodes = new Map<
    string,
    { id: string; title: string; excerpt: string }
  >()
  const edges = new Map<string, { source: string; target: string }>()
  let frontier = [rootId]
  for (
    let level = 0;
    level <= cappedDepth && frontier.length && nodes.size < cappedNodes;
    level++
  ) {
    const next = new Set<string>()
    for (const id of frontier) {
      const note = await db
        .prepare(
          `SELECT id, title, excerpt FROM notes ` +
            `WHERE id = ?1 AND user_id = ?2 AND deleted_at IS NULL`,
        )
        .bind(id, userId)
        .first<{ id: string; title: string; excerpt: string }>()
      if (!note) continue
      nodes.set(id, note)
      if (level === cappedDepth) continue
      const { results } = await db
        .prepare(
          `SELECT source_note_id, target_note_id FROM links
          WHERE user_id = ?1 AND target_note_id IS NOT NULL
            AND (source_note_id = ?2 OR target_note_id = ?2) LIMIT 100`,
        )
        .bind(userId, id)
        .all<{ source_note_id: string; target_note_id: string }>()
      for (const edge of results) {
        edges.set(`${edge.source_note_id}:${edge.target_note_id}`, {
          source: edge.source_note_id,
          target: edge.target_note_id,
        })
        const adjacent =
          edge.source_note_id === id ? edge.target_note_id : edge.source_note_id
        if (!nodes.has(adjacent) && nodes.size + next.size < cappedNodes)
          next.add(adjacent)
      }
    }
    frontier = [...next]
  }
  return {
    root_id: rootId,
    nodes: [...nodes.values()].map((node) => ({
      ...node,
      url: `${origin.replace(/\/$/, '')}/n/${encodeURIComponent(node.id)}`,
    })),
    edges: [...edges.values()].filter(
      (edge) => nodes.has(edge.source) && nodes.has(edge.target),
    ),
    truncated: frontier.length > 0 || nodes.size >= cappedNodes,
  }
}

export async function listMcpBackupRuns(
  db: D1Database,
  userId: string,
  limit = 10,
) {
  const { results } = await db
    .prepare(
      'SELECT id, trigger, status, started_at, finished_at, ' +
        'note_count, file_count, bytes, detail\n' +
        '       FROM backup_runs WHERE user_id = ?1 ' +
        'ORDER BY started_at DESC LIMIT ?2',
    )
    .bind(userId, Math.max(1, Math.min(20, limit)))
    .all<{
      id: string
      trigger: 'manual' | 'cron'
      status: BackupRun['status']
      started_at: number
      finished_at: number | null
      note_count: number
      file_count: number
      bytes: number
      detail: string
    }>()
  return {
    runs: results.map((row) => ({
      id: row.id,
      trigger: row.trigger,
      status: row.status,
      started_at: new Date(row.started_at).toISOString(),
      finished_at: row.finished_at
        ? new Date(row.finished_at).toISOString()
        : null,
      note_count: row.note_count,
      file_count: row.file_count,
      bytes: row.bytes,
      results: parseArray(row.detail),
    })),
  }
}
