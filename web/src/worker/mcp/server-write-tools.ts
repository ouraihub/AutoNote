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
  duplicateMcpNote,
  listMcpNoteVersions,
  readMcpNoteVersion,
  restoreMcpNoteVersion,
  type LibraryContext,
} from './library'
import {
  createMcpNote,
  editMcpNote,
  organizeMcpNote,
  trashMcpNote,
  restoreMcpNote,
  type McpWriteContext,
} from './writes'

export function registerWriteTools(
  server: McpServer,
  options: AutoNoteMcpServerOptions,
  writes: McpWriteContext,
  library: LibraryContext,
) {
  server.registerTool(
    'create_note',
    {
      title: 'Create note',
      description:
        'Create a private Markdown note. Requires notes:write ' +
        'and an operation_id for safe retry.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId.optional(),
        title: z.string().max(512).optional(),
        content: z.string().max(2_100_000).default(''),
        folder_id: noteId.nullable().optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, async () =>
        noteResult(
          await createMcpNote(writes, {
            operationId: input.operation_id,
            noteId: input.note_id,
            title: input.title,
            content: input.content,
            folderId: input.folder_id,
          }),
          options.origin,
        ),
      ),
  )

  server.registerTool(
    'edit_note',
    {
      title: 'Edit note safely',
      description:
        'Edit using unique exact text, a Markdown section, ' +
        'append/prepend, or full replacement. ' +
        'Requires current expected_rev and stores a version.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId,
        expected_rev: expectedRev,
        operation: z.enum([
          'replace',
          'replace_section',
          'append',
          'prepend',
          'replace_all',
        ]),
        text: z.string().max(2_100_000),
        old_text: z.string().max(500_000).optional(),
        section: z.string().trim().min(1).max(300).optional(),
        title: z.string().max(512).optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, async () =>
        noteResult(
          await editMcpNote(writes, {
            operationId: input.operation_id,
            noteId: input.note_id,
            expectedRev: input.expected_rev,
            operation: input.operation,
            text: input.text,
            oldText: input.old_text,
            section: input.section,
            title: input.title,
          }),
          options.origin,
        ),
      ),
  )

  server.registerTool(
    'organize_note',
    {
      title: 'Organize note',
      description:
        'Move a note or change starred, archived, or pinned state ' +
        'using optimistic revision protection.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId,
        expected_rev: expectedRev,
        folder_id: noteId.nullable().optional(),
        starred: z.boolean().optional(),
        archived: z.boolean().optional(),
        pinned: z.boolean().optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, async () =>
        noteResult(
          await organizeMcpNote(writes, {
            operationId: input.operation_id,
            noteId: input.note_id,
            expectedRev: input.expected_rev,
            ...('folder_id' in input ? { folderId: input.folder_id } : {}),
            starred: input.starred,
            archived: input.archived,
            pinned: input.pinned,
          }),
          options.origin,
        ),
      ),
  )

  server.registerTool(
    'trash_note',
    {
      title: 'Move note to trash',
      description:
        'Soft-delete a note. Requires the separately consented ' +
        'notes:trash scope and current expected_rev; ' +
        'it never permanently purges.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId,
        expected_rev: expectedRev,
      }),
      outputSchema: generalOutputSchema,
      annotations: { ...writeAnnotations(true), destructiveHint: true },
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.trash, async () =>
        noteResult(
          await trashMcpNote(writes, {
            operationId: input.operation_id,
            noteId: input.note_id,
            expectedRev: input.expected_rev,
          }),
          options.origin,
        ),
      ),
  )

  server.registerTool(
    'restore_note',
    {
      title: 'Restore trashed note',
      description:
        'Restore a soft-deleted note using its current trash revision. ' +
        'Requires notes:write.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId,
        expected_rev: expectedRev,
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, async () =>
        noteResult(
          await restoreMcpNote(writes, {
            operationId: input.operation_id,
            noteId: input.note_id,
            expectedRev: input.expected_rev,
          }),
          options.origin,
        ),
      ),
  )

  server.registerTool(
    'duplicate_note',
    {
      title: 'Duplicate note',
      description:
        'Create an idempotent private copy of an existing note ' +
        'in the same folder.',
      inputSchema: z.object({ operation_id: operationId, note_id: noteId }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, async () =>
        noteResult(
          await duplicateMcpNote(library, {
            operationId: input.operation_id,
            noteId: input.note_id,
          }),
          options.origin,
        ),
      ),
  )

  server.registerTool(
    'list_note_versions',
    {
      title: 'List note versions',
      description:
        'List bounded historical versions of one private note ' +
        'before reading or restoring one.',
      inputSchema: z.object({
        note_id: noteId,
        limit: z.number().int().min(1).max(50).default(20),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ note_id, limit }, ctx) =>
      customTool(ctx, options, () =>
        listMcpNoteVersions(
          options.env.DB,
          options.auth.userId,
          note_id,
          limit,
        ),
      ),
  )

  server.registerTool(
    'read_note_version',
    {
      title: 'Read note version',
      description:
        'Read a specific historical note version so its contents ' +
        'can be reviewed before restoration.',
      inputSchema: z.object({ note_id: noteId, version_id: noteId }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ note_id, version_id }, ctx) =>
      customTool(ctx, options, () =>
        readMcpNoteVersion(
          options.env.DB,
          options.auth.userId,
          note_id,
          version_id,
        ),
      ),
  )

  server.registerTool(
    'restore_note_version',
    {
      title: 'Restore note version',
      description:
        'Restore a reviewed historical version with optimistic ' +
        'revision protection and note history.',
      inputSchema: z.object({
        operation_id: operationId,
        note_id: noteId,
        version_id: noteId,
        expected_rev: expectedRev,
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, async () =>
        noteResult(
          await restoreMcpNoteVersion(library, {
            operationId: input.operation_id,
            noteId: input.note_id,
            versionId: input.version_id,
            expectedRev: input.expected_rev,
          }),
          options.origin,
        ),
      ),
  )
}
