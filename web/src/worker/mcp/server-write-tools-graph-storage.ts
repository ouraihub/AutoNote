import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { MCP_SCOPES } from './settings'
import {
  customTool,
  generalOutputSchema,
  noteId,
  operationId,
  readOnlyAnnotations,
  writeAnnotations,
  writeTool,
  type AutoNoteMcpServerOptions,
} from './server-context'
import {
  exploreMcpGraph,
  listMcpBackupRuns,
  listMcpAttachments,
  readMcpAttachment,
  uploadMcpAttachment,
  deleteMcpAttachment,
  runMcpBackup,
  type LibraryContext,
} from './library'

export function registerGraphStorageTools(
  server: McpServer,
  options: AutoNoteMcpServerOptions,
  library: LibraryContext,
) {
  server.registerTool(
    'explore_note_graph',
    {
      title: 'Explore note graph',
      description:
        'Explore a bounded two-way link graph from one note, ' +
        'limited to three hops and 100 nodes.',
      inputSchema: z.object({
        note_id: noteId,
        depth: z.number().int().min(1).max(3).default(2),
        max_nodes: z.number().int().min(2).max(100).default(60),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ note_id, depth, max_nodes }, ctx) =>
      customTool(ctx, options, () =>
        exploreMcpGraph(
          options.env.DB,
          options.auth.userId,
          options.origin,
          note_id,
          depth,
          max_nodes,
        ),
      ),
  )

  server.registerTool(
    'list_backup_runs',
    {
      title: 'List backup runs',
      description:
        'List recent backup outcomes without exposing backup credentials ' +
        'or configuration secrets.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).default(10),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ limit }, ctx) =>
      customTool(ctx, options, () =>
        listMcpBackupRuns(options.env.DB, options.auth.userId, limit),
      ),
  )

  server.registerTool(
    'list_attachments',
    {
      title: 'List attachments',
      description:
        'List bounded private attachment metadata, optionally for one note.',
      inputSchema: z.object({
        note_id: noteId.optional(),
        limit: z.number().int().min(1).max(50).default(20),
        cursor: z.number().int().nonnegative().optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input, ctx) =>
      customTool(ctx, options, () =>
        listMcpAttachments(options.env.DB, options.auth.userId, {
          noteId: input.note_id,
          limit: input.limit,
          cursor: input.cursor,
        }),
      ),
  )

  server.registerTool(
    'read_attachment',
    {
      title: 'Read attachment chunk',
      description:
        'Read a bounded base64 chunk of one private attachment ' +
        'with cursor continuation.',
      inputSchema: z.object({
        attachment_id: noteId,
        cursor: z.number().int().nonnegative().optional(),
        max_bytes: z
          .number()
          .int()
          .min(1024)
          .max(1024 * 1024)
          .default(256 * 1024),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input, ctx) =>
      customTool(ctx, options, () =>
        readMcpAttachment(options.env, options.auth.userId, {
          attachmentId: input.attachment_id,
          cursor: input.cursor,
          maxBytes: input.max_bytes,
        }),
      ),
  )

  server.registerTool(
    'upload_attachment',
    {
      title: 'Upload attachment',
      description:
        'Upload one base64-encoded private attachment ' +
        'using the configured storage and account quota.',
      inputSchema: z.object({
        operation_id: operationId,
        attachment_id: noteId.optional(),
        note_id: noteId.nullable().optional(),
        filename: z.string().trim().min(1).max(180),
        mime: z.string().trim().min(1).max(255),
        data: z.string().min(1).max(36_000_000),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        uploadMcpAttachment(library, {
          operationId: input.operation_id,
          attachmentId: input.attachment_id,
          noteId: input.note_id,
          filename: input.filename,
          mime: input.mime,
          base64: input.data,
        }),
      ),
  )

  server.registerTool(
    'delete_attachment',
    {
      title: 'Delete attachment',
      description:
        'Delete one explicitly identified private attachment ' +
        'and queue its stored bytes for cleanup.',
      inputSchema: z.object({
        operation_id: operationId,
        attachment_id: noteId,
      }),
      outputSchema: generalOutputSchema,
      annotations: { ...writeAnnotations(true), destructiveHint: true },
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        deleteMcpAttachment(library, {
          operationId: input.operation_id,
          attachmentId: input.attachment_id,
        }),
      ),
  )

  server.registerTool(
    'run_backup',
    {
      title: 'Run backup',
      description:
        'Run already configured backup targets ' +
        'without revealing or changing their credentials.',
      inputSchema: z.object({
        operation_id: operationId,
        target_ids: z.array(noteId).max(12).optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async ({ operation_id, target_ids }, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        runMcpBackup(library, operation_id, target_ids),
      ),
  )
}
