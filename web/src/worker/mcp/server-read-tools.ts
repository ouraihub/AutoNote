import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { MCP_SCOPES } from './settings'
import {
  customTool,
  generalOutputSchema,
  noteId,
  readOnlyAnnotations,
  requireScope,
  safeTool,
  structured,
  type AutoNoteMcpServerOptions,
} from './server-context'
import {
  fetchMcpNote,
  searchMcpNotes,
  listMcpNotes,
  readMcpNote,
  getMcpNoteContext,
  listMcpFolders,
  listMcpTags,
} from './retrieval'

export function registerReadTools(
  server: McpServer,
  options: AutoNoteMcpServerOptions,
) {
  server.registerTool(
    'search',
    {
      title: 'Search AutoNote',
      description:
        'Search private AutoNote notes by keyword and meaning. ' +
        'Returns citation-ready note ids, titles, and absolute URLs. ' +
        'Use before fetch.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(512),
        mode: z
          .enum(['auto', 'lexical', 'semantic', 'hybrid'])
          .default('auto')
          .describe(
            'auto: hybrid when AI semantic search is enabled, ' +
              'else keyword search; lexical: keyword only; ' +
              'semantic: meaning only; hybrid: both merged',
          ),
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            url: z.string().url(),
          }),
        ),
      }),
      annotations: readOnlyAnnotations(),
    },
    async ({ query, mode }, ctx) =>
      safeTool(async () => {
        requireScope(ctx, options.auth, MCP_SCOPES.read)
        const found = await searchMcpNotes(
          options.env,
          options.auth.userId,
          options.origin,
          options.ftsEnabled,
          { query, limit: 8, mode },
        )
        const value = {
          results: found.results.map(({ id, title, url }) => ({
            id,
            title,
            url,
          })),
          mode: found.mode,
        }
        return structured(value)
      }),
  )

  server.registerTool(
    'fetch',
    {
      title: 'Fetch AutoNote note',
      description:
        'Fetch one private note by id returned from search. ' +
        'Long notes are bounded and include a cursor for read_note.',
      inputSchema: z.object({ id: z.string().min(1).max(256) }),
      outputSchema: z.object({
        id: z.string(),
        title: z.string(),
        text: z.string(),
        url: z.string().url(),
        metadata: z.record(z.string(), z.unknown()),
      }),
      annotations: readOnlyAnnotations(),
    },
    async ({ id }, ctx) =>
      safeTool(async () => {
        requireScope(ctx, options.auth, MCP_SCOPES.read)
        return structured(
          await fetchMcpNote(
            options.env.DB,
            options.auth.userId,
            options.origin,
            id,
          ),
        )
      }),
  )

  server.registerTool(
    'search_notes',
    {
      title: 'Advanced note search',
      description:
        'Search notes with tag, folder, starred, and archive filters; ' +
        'optionally combines keyword and AI semantic search.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(512),
        limit: z.number().int().min(1).max(20).default(10),
        tags: z.array(z.string().trim().min(1).max(60)).max(8).optional(),
        folder: z.string().trim().min(1).max(120).optional(),
        starred: z.boolean().optional(),
        archived: z.boolean().optional(),
        mode: z
          .enum(['auto', 'lexical', 'semantic', 'hybrid'])
          .default('auto')
          .describe(
            'auto: hybrid when AI semantic search is enabled, ' +
              'else keyword search; lexical: keyword only; ' +
              'semantic: meaning only; hybrid: both merged',
          ),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input, ctx) =>
      customTool(ctx, options, async () =>
        searchMcpNotes(
          options.env,
          options.auth.userId,
          options.origin,
          options.ftsEnabled,
          input,
        ),
      ),
  )

  server.registerTool(
    'list_notes',
    {
      title: 'List notes',
      description:
        'List a small, paginated set of recent, starred, archived, ' +
        'or trashed notes. Prefer search_notes for targeted retrieval.',
      inputSchema: z.object({
        view: z
          .enum(['all', 'recent', 'starred', 'archived', 'trash'])
          .default('recent'),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.string().max(64).optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input, ctx) =>
      customTool(ctx, options, () =>
        listMcpNotes(
          options.env.DB,
          options.auth.userId,
          options.origin,
          input,
        ),
      ),
  )

  server.registerTool(
    'read_note',
    {
      title: 'Read note range or section',
      description:
        'Read a bounded range, named Markdown section, ' +
        'or cursor continuation without dumping a large note into context.',
      inputSchema: z.object({
        note_id: noteId,
        section: z.string().trim().min(1).max(300).optional(),
        cursor: z.string().max(32).optional(),
        max_chars: z.number().int().min(1_000).max(40_000).default(12_000),
        start_line: z.number().int().positive().optional(),
        end_line: z.number().int().positive().optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input, ctx) =>
      customTool(ctx, options, () =>
        readMcpNote(options.env.DB, options.auth.userId, options.origin, {
          noteId: input.note_id,
          section: input.section,
          cursor: input.cursor,
          maxChars: input.max_chars,
          startLine: input.start_line,
          endLine: input.end_line,
        }),
      ),
  )

  server.registerTool(
    'get_note_context',
    {
      title: 'Get note context',
      description:
        'Return a note outline plus bounded outgoing links and backlinks. ' +
        'Follows only one graph hop.',
      inputSchema: z.object({
        note_id: noteId,
        limit: z.number().int().min(1).max(30).default(20),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ note_id, limit }, ctx) =>
      customTool(ctx, options, () =>
        getMcpNoteContext(
          options.env.DB,
          options.auth.userId,
          options.origin,
          note_id,
          limit,
        ),
      ),
  )

  server.registerTool(
    'list_folders',
    {
      title: 'List folders',
      description:
        'List the authenticated user’s folder ids, hierarchy paths, ' +
        'and note counts for organizing notes.',
      inputSchema: z.object({}),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (_input, ctx) =>
      customTool(ctx, options, () =>
        listMcpFolders(options.env.DB, options.auth.userId),
      ),
  )

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'List private tag names and usage counts for search and organization.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(100),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ limit }, ctx) =>
      customTool(ctx, options, () =>
        listMcpTags(options.env.DB, options.auth.userId, limit),
      ),
  )
}
