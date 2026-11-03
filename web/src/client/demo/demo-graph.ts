import { Hono } from 'hono'
import {
  deriveExcerpt,
  extractWikiLinks,
  normalizeLinkKey,
  wikiNoteTarget,
} from '@shared/markdown-utils'
import type {
  GraphResponse,
  Note,
  SearchResponse,
  SyncResponse,
} from '@shared/types'
import { listFolders, listTags, summarize, type DemoState } from './state'

export function registerGraphRoutes(app: Hono, state: DemoState): void {
  app.get('/api/search', (c) => {
    const started = performance.now()
    const query = (c.req.query('q') ?? '').trim()
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit')) || 50))
    const needle = query.toLocaleLowerCase()
    const results = [...state.notes.values()]
      .filter(
        (note) =>
          note.deletedAt === null &&
          `${note.title}\n${note.content}`.toLocaleLowerCase().includes(needle),
      )
      .slice(0, limit)
      .map((note) => ({
        note: summarize(note),
        snippet: deriveExcerpt(note.content, 140),
        score: 1,
      }))
    const response: SearchResponse = {
      results,
      mode: 'like',
      took: Math.max(0, performance.now() - started),
      query: {
        text: query,
        tags: [],
        folder: null,
        starred: null,
        archived: null,
      },
    }
    return c.json(response)
  })
  app.post('/api/search/reindex', (c) =>
    c.json({ ok: true as const, indexed: state.notes.size }),
  )
  app.get('/api/graph', (c) => {
    const mode = c.req.query('mode') === 'local' ? 'local' : 'global'
    const centerId = c.req.query('center') || null
    const depth = Math.max(1, Math.min(3, Number(c.req.query('depth')) || 1))
    const limit = Math.max(
      50,
      Math.min(600, Number(c.req.query('limit')) || 350),
    )
    const needle = (c.req.query('q') ?? '').trim().toLocaleLowerCase()
    const folderId = c.req.query('folderId') ?? ''
    const tag = (c.req.query('tag') ?? '').trim().toLocaleLowerCase()
    const includeOrphans = c.req.query('includeOrphans') !== '0'
    const includeUnresolved = c.req.query('includeUnresolved') === '1'
    const active = [...state.notes.values()]
      .filter((note) => note.deletedAt === null && !note.isArchived)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
    const byTitle = new Map<string, Note>()
    for (const note of active) {
      const key = normalizeLinkKey(note.title)
      if (!byTitle.has(key)) byTitle.set(key, note)
    }
    const linkRecords = active.flatMap((note) =>
      extractWikiLinks(note.content).map((link) => ({
        source: note.id,
        target: byTitle.get(link.key)?.id ?? null,
        key: link.key,
        title: wikiNoteTarget(link.target),
      })),
    )
    const allEdges = linkRecords
      .filter((link): link is typeof link & { target: string } =>
        Boolean(link.target && link.target !== link.source),
      )
      .map((link) => ({ source: link.source, target: link.target }))
    const uniqueEdges = [
      ...new Map(
        allEdges.map((edge) => [`${edge.source}>${edge.target}`, edge]),
      ).values(),
    ]
    const degree = new Map<string, number>()
    const incoming = new Map<string, number>()
    const outgoing = new Map<string, number>()
    for (const edge of uniqueEdges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1)
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1)
      outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1)
      incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1)
    }
    let allowed = new Set(active.map((note) => note.id))
    if (mode === 'local' && centerId) {
      allowed = new Set([centerId])
      let frontier = new Set([centerId])
      for (let level = 0; level < depth; level++) {
        const next = new Set<string>()
        for (const edge of uniqueEdges) {
          if (frontier.has(edge.source) && !allowed.has(edge.target))
            next.add(edge.target)
          if (frontier.has(edge.target) && !allowed.has(edge.source))
            next.add(edge.source)
        }
        for (const id of next) allowed.add(id)
        frontier = next
      }
    }
    const filtered = active
      .filter(
        (note) =>
          allowed.has(note.id) &&
          (!needle || note.title.toLocaleLowerCase().includes(needle)) &&
          (!folderId || note.folderId === folderId) &&
          (!tag ||
            note.tags.some((name) => name.toLocaleLowerCase() === tag)) &&
          (includeOrphans || (degree.get(note.id) ?? 0) > 0),
      )
      .sort(
        (a, b) =>
          (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0) ||
          b.updatedAt - a.updatedAt,
      )
    const shown = filtered.slice(0, limit)
    const shownIds = new Set(shown.map((note) => note.id))
    const edges = uniqueEdges.filter(
      (edge) => shownIds.has(edge.source) && shownIds.has(edge.target),
    )
    const folders = new Map(
      listFolders(state).map((folder) => [folder.id, folder]),
    )
    const nodes: GraphResponse['nodes'] = shown.map((note) => ({
      id: note.id,
      title: note.title,
      kind: 'note' as const,
      degree: degree.get(note.id) ?? 0,
      inDegree: incoming.get(note.id) ?? 0,
      outDegree: outgoing.get(note.id) ?? 0,
      folderId: note.folderId,
      folderName: note.folderId
        ? (folders.get(note.folderId)?.name ?? null)
        : null,
      folderColor: note.folderId
        ? (folders.get(note.folderId)?.color ?? null)
        : null,
      tags: note.tags.map((name) => ({
        name,
        color: state.tagColors.get(name) ?? null,
      })),
    }))
    const unresolved = new Map<
      string,
      { title: string; sources: Set<string> }
    >()
    if (includeUnresolved) {
      for (const link of linkRecords) {
        if (link.target !== null || !shownIds.has(link.source)) continue
        if (unresolved.size >= 50 && !unresolved.has(link.key)) continue
        const missing = unresolved.get(link.key) ?? {
          title: link.title,
          sources: new Set<string>(),
        }
        missing.sources.add(link.source)
        unresolved.set(link.key, missing)
      }
      for (const [key, missing] of unresolved) {
        const id = `unresolved:${key}`
        nodes.push({
          id,
          title: missing.title,
          kind: 'unresolved',
          degree: missing.sources.size,
          inDegree: missing.sources.size,
          outDegree: 0,
          folderId: null,
          folderName: null,
          folderColor: null,
          tags: [],
        })
        for (const source of missing.sources) edges.push({ source, target: id })
      }
    }
    return c.json({
      nodes,
      edges,
      meta: {
        mode,
        centerId: mode === 'local' ? centerId : null,
        depth,
        totalNodes: filtered.length + unresolved.size,
        totalEdges: edges.length,
        truncated: filtered.length > limit,
        limit,
      },
    })
  })
  app.get('/api/sync', (c) => {
    const since = Number(c.req.query('since')) || 0
    const changed = since < state.cursor
    const response: SyncResponse = {
      cursor: state.cursor,
      full: changed,
      hasMore: false,
      nextKey: null,
      facetsFull: changed,
      settingsChanged: false,
      profileChanged: false,
      notes: changed ? [...state.notes.values()].map(summarize) : [],
      folders: changed ? listFolders(state) : [],
      tags: changed ? listTags(state) : [],
      deletions: [],
      serverTime: Date.now(),
    }
    return c.json(response)
  })
}
