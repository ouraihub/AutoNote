import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { MCP_SCOPES } from './settings'
import {
  customTool,
  expectedRev,
  generalOutputSchema,
  noteId,
  noteResult,
  operationId,
  readOnlyAnnotations,
  writeAnnotations,
  writeTool,
  type AutoNoteMcpServerOptions,
} from './server-context'
import {
  getMcpShare,
  getMcpNoteProperties,
  updateMcpNoteProperties,
  queryMcpNoteProperties,
  createMcpShare,
  revokeMcpShare,
  type LibraryContext,
} from './library'

export function registerSharingTools(
  server: McpServer,
  options: AutoNoteMcpServerOptions,
  library: LibraryContext,
) {
  server.registerTool(
    'get_note_share',
    {
      title: 'Get note share',
      description:
        'Inspect the current public-share state of one private note ' +
        'without reading any password hash.',
      inputSchema: z.object({ note_id: noteId }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ note_id }, ctx) =>
      customTool(ctx, options, () =>
        getMcpShare(
          options.env.DB,
          options.auth.userId,
          options.origin,
          note_id,
        ),
      ),
  )

  server.registerTool(
    'get_note_properties',
    {
      title: 'Get note properties',
      description:
        'Read the typed YAML Front Matter properties ' +
        'and current revision of one note.',
      inputSchema: z.object({ note_id: noteId }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ note_id }, ctx) =>
      customTool(ctx, options, () =>
        getMcpNoteProperties(options.env.DB, options.auth.userId, note_id),
      ),
  )

  server.registerTool(
    'update_note_properties',
    {
      title: 'Update note properties',
      description:
        'Merge or replace typed YAML Front Matter ' +
        'while preserving Markdown as the source of truth.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId,
        expected_rev: expectedRev,
        mode: z.enum(['merge', 'replace']).default('merge'),
        properties: z.record(z.string().min(1).max(120), z.unknown()),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, async () =>
        noteResult(
          await updateMcpNoteProperties(library, {
            operationId: input.operation_id,
            noteId: input.note_id,
            expectedRev: input.expected_rev,
            mode: input.mode,
            properties: input.properties,
          }),
          options.origin,
        ),
      ),
  )

  server.registerTool(
    'query_note_properties',
    {
      title: 'Query note properties',
      description:
        'Run a bounded lightweight Bases-style query ' +
        'over typed YAML Front Matter properties.',
      inputSchema: z.object({
        conditions: z
          .array(
            z.object({
              key: z.string().trim().min(1).max(120),
              operator: z.enum(['exists', 'equals', 'contains']),
              value: z.unknown().optional(),
            }),
          )
          .min(1)
          .max(8),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input, ctx) =>
      customTool(ctx, options, () =>
        queryMcpNoteProperties(options.env.DB, options.auth.userId, input),
      ),
  )

  server.registerTool(
    'create_note_share',
    {
      title: 'Create note share',
      description:
        'Create or update a public note link ' +
        'with an optional password and bounded expiration.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId,
        password: z.string().min(4).max(128).nullable().optional(),
        expires_in_seconds: z
          .number()
          .int()
          .min(0)
          .max(365 * 24 * 60 * 60)
          .nullable()
          .optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        createMcpShare(library, {
          operationId: input.operation_id,
          noteId: input.note_id,
          password: input.password,
          expiresIn:
            input.expires_in_seconds === null ||
            input.expires_in_seconds === undefined
              ? input.expires_in_seconds
              : input.expires_in_seconds * 1000,
        }),
      ),
  )

  server.registerTool(
    'revoke_note_share',
    {
      title: 'Revoke note share',
      description: 'Revoke the public link for one explicitly identified note.',
      inputSchema: z.object({ operation_id: operationId, note_id: noteId }),
      outputSchema: generalOutputSchema,
      annotations: { ...writeAnnotations(true), destructiveHint: true },
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        revokeMcpShare(library, {
          operationId: input.operation_id,
          noteId: input.note_id,
        }),
      ),
  )
}
