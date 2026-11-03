import { sliceText } from '@shared/text-utils'
import type { Note } from '@shared/types'
import {
  NOTE_COLUMNS,
  NOTE_COLUMNS_FULL,
  toNote,
  toNoteSummary,
  type NoteRow,
} from '../db/rows'
import type { Env } from '../env'
import { ApiError } from '../lib/errors'

import { searchUserNotes } from '../routes/search'
import {
  fuseByRrf,
  searchSemanticNotes,
  semanticSnippet,
  type SemanticSearchHit,
} from './ai-search'
import {
  encodeListCursor,
  parseCursor,
  parseListCursor,
} from './retrieval-cursors'
import { noteUrl } from './retrieval-url'
import { clampInteger, escapeQuote, lineOffsets } from './retrieval-tail'
export { buildOutline, listMcpFolders, listMcpTags } from './retrieval-listings'
import { buildOutline } from './retrieval-listings'

const FETCH_MAX_CHARS = 80_000
const READ_DEFAULT_CHARS = 12_000
const READ_MAX_CHARS = 40_000
const SEARCH_CANDIDATES = 40
const HYBRID_CANDIDATES = 24

export type McpSearchMode = 'auto' | 'lexical' | 'semantic' | 'hybrid'

export interface McpSearchOptions {
  query: string
  limit?: number
  tags?: string[]
  folder?: string
  starred?: boolean
  archived?: boolean
  mode?: McpSearchMode
}

export interface McpSearchHit {
  id: string
  title: string
  url: string
  snippet: string
  score: number
  rev: number
  updatedAt: number
  source: 'lexical' | 'semantic' | 'both'
}

export interface McpSearchResponse {
  results: McpSearchHit[]
  mode: 'lexical' | 'semantic' | 'hybrid'
}

export interface NoteOutlineItem {
  level: number
  title: string
  slug: string
  line: number
}

export async function searchMcpNotes(
  env: Env,
  userId: string,
  origin: string,
  ftsEnabled: boolean,
  options: McpSearchOptions,
): Promise<McpSearchResponse> {
  const limit = Math.max(1, Math.min(20, options.limit ?? 8))
  const mode = options.mode ?? 'auto'
  const lexicalQuery = composeLexicalQuery(options)
  const { results: lexical } = await searchUserNotes(
    env.DB,
    userId,
    lexicalQuery,
    SEARCH_CANDIDATES,
    ftsEnabled,
  )
  const lexicalHits: LexicalHit[] = lexical.map((hit) => ({
    id: hit.note.id,
    title: hit.note.title,
    url: noteUrl(origin, hit.note.id),
    snippet: hit.snippet,
    score: hit.score,
    rev: hit.note.rev,
    updatedAt: hit.note.updatedAt,
    excerpt: hit.note.excerpt,
  }))

  const wantsSemantic =
    mode === 'auto' || mode === 'hybrid' || mode === 'semantic'
  let semanticHits: SemanticSearchHit[] | null = null
  if (wantsSemantic) {
    try {
      semanticHits = await searchSemanticNotes(
        env,
        env.DB,
        userId,
        options.query,
        {
          tags: options.tags,
          folder: options.folder,
          starred: options.starred,
          archived: options.archived,
        },
      )
    } catch (error) {
      // AI unavailable, rate-limited, or malformed response:
      // degrade to lexical.
      console.warn(
        '[autonote] Semantic search unavailable; using lexical:',
        error instanceof Error ? error.message : error,
      )
      semanticHits = null
    }
  }
  if (!semanticHits || !semanticHits.length) {
    return {
      results: lexicalHits
        .slice(0, limit)
        .map((hit) => ({ ...hit, source: 'lexical' as const })),
      mode: 'lexical',
    }
  }

  const semanticCandidates: SemanticHit[] = semanticHits
    .slice(0, HYBRID_CANDIDATES)
    .map((hit) => ({
      ...hit,
      url: noteUrl(origin, hit.id),
    }))
  if (mode === 'semantic') {
    return {
      results: semanticCandidates.slice(0, limit).map((hit) => ({
        id: hit.id,
        title: hit.title,
        url: hit.url,
        snippet: semanticSnippet(hit.excerpt),
        score: hit.score,
        rev: hit.rev,
        updatedAt: hit.updatedAt,
        source: 'semantic' as const,
      })),
      mode: 'semantic',
    }
  }
  const fused = fuseByRrf(lexicalHits, semanticCandidates)
  const results: McpSearchHit[] = fused
    .slice(0, limit)
    .map(({ item, sources }) => {
      const lexicalHit =
        sources.has('lexical') && isLexicalHit(item) ? item : null
      const semanticHit =
        sources.has('semantic') && !isLexicalHit(item) ? item : null
      return {
        id: item.id,
        title: item.title,
        url: noteUrl(origin, item.id),
        snippet:
          lexicalHit?.snippet ??
          (semanticHit ? semanticSnippet(semanticHit.excerpt) : ''),
        score: lexicalHit?.score ?? semanticHit?.score ?? item.score,
        rev: item.rev,
        updatedAt: item.updatedAt,
        source:
          sources.size > 1
            ? 'both'
            : sources.has('semantic')
              ? 'semantic'
              : 'lexical',
      }
    })
  return {
    results,
    mode: lexicalHits.length && semanticHits.length ? 'hybrid' : 'semantic',
  }
}

type LexicalHit = {
  id: string
  title: string
  url: string
  snippet: string
  score: number
  rev: number
  updatedAt: number
  excerpt: string
}

type SemanticHit = SemanticSearchHit & { url: string }

function isLexicalHit(hit: LexicalHit | SemanticHit): hit is LexicalHit {
  return 'snippet' in hit
}

export async function loadMcpNote(
  db: D1Database,
  userId: string,
  id: string,
): Promise<Note> {
  const noteId = normalizeNoteId(id)
  const row = await db
    .prepare(
      `SELECT ${NOTE_COLUMNS_FULL} FROM notes n
      WHERE n.id = ?1 AND n.user_id = ?2 AND n.deleted_at IS NULL`,
    )
    .bind(noteId, userId)
    .first<NoteRow>()
  if (!row) throw ApiError.notFound('Note not found')
  return toNote(row)
}

export async function fetchMcpNote(
  db: D1Database,
  userId: string,
  origin: string,
  id: string,
): Promise<{
  id: string
  title: string
  text: string
  url: string
  metadata: Record<string, unknown>
}> {
  const note = await loadMcpNote(db, userId, id)
  const truncated = note.content.length > FETCH_MAX_CHARS
  const text = truncated
    ? sliceText(note.content, 0, FETCH_MAX_CHARS) +
      '\n\n[Content truncated. Call read_note with note_id and cursor "' +
      FETCH_MAX_CHARS +
      '" to continue.]'
    : note.content
  return {
    id: note.id,
    title: note.title,
    text,
    url: noteUrl(origin, note.id),
    metadata: {
      rev: note.rev,
      updated_at: new Date(note.updatedAt).toISOString(),
      created_at: new Date(note.createdAt).toISOString(),
      tags: note.tags,
      folder_id: note.folderId,
      starred: note.isStarred,
      archived: note.isArchived,
      truncated,
      ...(truncated ? { next_cursor: String(FETCH_MAX_CHARS) } : {}),
    },
  }
}

export async function readMcpNote(
  db: D1Database,
  userId: string,
  origin: string,
  input: {
    noteId: string
    section?: string
    cursor?: string
    maxChars?: number
    startLine?: number
    endLine?: number
  },
): Promise<Record<string, unknown>> {
  const note = await loadMcpNote(db, userId, input.noteId)
  const outline = buildOutline(note.content)
  let start = parseCursor(input.cursor)
  let end = note.content.length
  let selectedSection: NoteOutlineItem | undefined

  if (input.section) {
    const wanted = input.section.trim().toLowerCase()
    const headingIndex = outline.findIndex(
      (item) => item.slug === wanted || item.title.toLowerCase() === wanted,
    )
    if (headingIndex < 0)
      throw ApiError.notFound(`Section not found: ${input.section}`)
    selectedSection = outline[headingIndex]
    const lines = lineOffsets(note.content)
    const sectionStart = lines[selectedSection.line - 1] ?? 0
    const next = outline
      .slice(headingIndex + 1)
      .find((item) => item.level <= selectedSection!.level)
    end = next
      ? (lines[next.line - 1] ?? note.content.length)
      : note.content.length
    start = input.cursor ? clampInteger(start, sectionStart, end) : sectionStart
  } else if (input.startLine !== undefined || input.endLine !== undefined) {
    const lines = lineOffsets(note.content)
    const startLine = clampInteger(input.startLine ?? 1, 1, lines.length)
    const endLine = clampInteger(
      input.endLine ?? lines.length,
      startLine,
      lines.length,
    )
    start = lines[startLine - 1] ?? 0
    end = lines[endLine] ?? note.content.length
  }

  const maxChars = clampInteger(
    input.maxChars ?? READ_DEFAULT_CHARS,
    1_000,
    READ_MAX_CHARS,
  )
  const pageEnd = Math.min(end, start + maxChars)
  return {
    note_id: note.id,
    title: note.title,
    url: noteUrl(origin, note.id),
    rev: note.rev,
    content: sliceText(note.content, start, pageEnd),
    start_offset: start,
    end_offset: pageEnd,
    total_chars: note.content.length,
    has_more: pageEnd < end,
    next_cursor: pageEnd < end ? String(pageEnd) : null,
    section: selectedSection ?? null,
    outline,
  }
}

export async function getMcpNoteContext(
  db: D1Database,
  userId: string,
  origin: string,
  noteId: string,
  limit = 20,
): Promise<Record<string, unknown>> {
  const note = await loadMcpNote(db, userId, noteId)
  const capped = Math.max(1, Math.min(30, limit))
  const { results: outgoing } = await db
    .prepare(
      'SELECT l.target_title AS referenced_title, n.id, n.title, ' +
        'n.excerpt, n.updated_at\n' +
        '       FROM links l LEFT JOIN notes n\n' +
        '         ON n.id = l.target_note_id AND n.user_id = ?1 ' +
        'AND n.deleted_at IS NULL\n' +
        '      WHERE l.user_id = ?1 AND l.source_note_id = ?2\n' +
        '      ORDER BY n.updated_at DESC, ' +
        'l.target_title COLLATE NOCASE ASC LIMIT ?3',
    )
    .bind(userId, note.id, capped)
    .all<{
      referenced_title: string
      id: string | null
      title: string | null
      excerpt: string | null
      updated_at: number | null
    }>()
  const { results: backlinks } = await db
    .prepare(
      `SELECT n.id, n.title, n.excerpt, n.updated_at
       FROM links l JOIN notes n ON n.id = l.source_note_id
      WHERE l.user_id = ?1 AND l.target_note_id = ?2
        AND n.user_id = ?1 AND n.deleted_at IS NULL
      ORDER BY n.updated_at DESC, n.id ASC LIMIT ?3`,
    )
    .bind(userId, note.id, capped)
    .all<{
      id: string
      title: string
      excerpt: string
      updated_at: number
    }>()

  return {
    note: {
      id: note.id,
      title: note.title,
      url: noteUrl(origin, note.id),
      excerpt: note.excerpt,
      tags: note.tags,
      rev: note.rev,
      updated_at: new Date(note.updatedAt).toISOString(),
    },
    outline: buildOutline(note.content),
    outgoing: outgoing.map((row) => ({
      id: row.id,
      title: row.title ?? row.referenced_title,
      unresolved: !row.id,
      url: row.id ? noteUrl(origin, row.id) : null,
      excerpt: row.excerpt ?? '',
    })),
    backlinks: backlinks.map((row) => ({
      id: row.id,
      title: row.title,
      url: noteUrl(origin, row.id),
      excerpt: row.excerpt,
      updated_at: new Date(row.updated_at).toISOString(),
    })),
  }
}

export async function listMcpNotes(
  db: D1Database,
  userId: string,
  origin: string,
  input: {
    view?: 'all' | 'recent' | 'starred' | 'archived' | 'trash'
    limit?: number
    cursor?: string
  },
): Promise<Record<string, unknown>> {
  const view = input.view ?? 'recent'
  const limit = Math.max(1, Math.min(50, input.limit ?? 20))
  const cursor = parseListCursor(input.cursor)
  let where = 'n.user_id = ?1'
  if (view === 'trash') where += ' AND n.deleted_at IS NOT NULL'
  else {
    where += ' AND n.deleted_at IS NULL'
    if (view === 'archived') where += ' AND n.is_archived = 1'
    else where += ' AND n.is_archived = 0'
  }
  if (view === 'starred') where += ' AND n.is_starred = 1'
  const query =
    cursor.kind === 'key'
      ? db
          .prepare(
            `SELECT ${NOTE_COLUMNS} FROM notes n WHERE ${where}
        AND (n.updated_at < ?2 OR (n.updated_at = ?2 AND n.id > ?3))
        ORDER BY n.updated_at DESC, n.id ASC LIMIT ?4`,
          )
          .bind(userId, cursor.updatedAt, cursor.id, limit + 1)
      : db
          .prepare(
            `SELECT ${NOTE_COLUMNS} FROM notes n WHERE ${where}
        ORDER BY n.updated_at DESC, n.id ASC LIMIT ?2 OFFSET ?3`,
          )
          .bind(userId, limit + 1, cursor.offset)
  const { results } = await query.all<NoteRow>()
  const hasMore = results.length > limit
  const page = results.slice(0, limit)
  const last = page.at(-1)
  return {
    notes: page.map((row) => {
      const note = toNoteSummary(row)
      return {
        id: note.id,
        title: note.title,
        url: noteUrl(origin, note.id),
        excerpt: note.excerpt,
        tags: note.tags,
        rev: note.rev,
        starred: note.isStarred,
        archived: note.isArchived,
        deleted_at: note.deletedAt
          ? new Date(note.deletedAt).toISOString()
          : null,
        updated_at: new Date(note.updatedAt).toISOString(),
      }
    }),
    next_cursor:
      hasMore && last ? encodeListCursor(last.updated_at, last.id) : null,
  }
}

function composeLexicalQuery(options: McpSearchOptions): string {
  const parts = [options.query.trim()]
  for (const tag of options.tags ?? []) parts.push(`tag:"${escapeQuote(tag)}"`)
  if (options.folder) parts.push(`folder:"${escapeQuote(options.folder)}"`)
  if (options.starred === true) parts.push('is:starred')
  if (options.archived === true) parts.push('is:archived')
  else if (options.archived === false) parts.push('is:unarchived')
  return parts.filter(Boolean).join(' ')
}

function normalizeNoteId(id: string): string {
  return id.startsWith('note:') ? id.slice(5) : id.split('#', 1)[0]!
}
