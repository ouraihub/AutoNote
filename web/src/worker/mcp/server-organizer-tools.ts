import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { MCP_SCOPES } from './settings'
import {
  customTool,
  expectedRev,
  generalOutputSchema,
  noteId,
  operationId,
  readOnlyAnnotations,
  writeAnnotations,
  writeTool,
  type AutoNoteMcpServerOptions,
} from './server-context'
import {
  createMcpFolder,
  updateMcpFolder,
  createMcpTag,
  updateMcpTag,
  previewMcpTagChange,
  deleteMcpTag,
  previewMcpFolderRemoval,
  removeMcpFolderAndPromote,
  bulkOrganizeMcpNotes,
  type LibraryContext,
} from './library'

export function registerOrganizerTools(
  server: McpServer,
  options: AutoNoteMcpServerOptions,
  library: LibraryContext,
) {
  server.registerTool(
    'create_folder',
    {
      title: 'Create folder',
      description:
        'Create a private folder under an optional existing parent ' +
        'with safe retry.',
      inputSchema: z.object({
        operation_id: operationId,
        folder_id: noteId.optional(),
        name: z.string().trim().min(1).max(120),
        parent_id: noteId.nullable().optional(),
        icon: z.string().max(80).nullable().optional(),
        color: z.string().max(32).nullable().optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        createMcpFolder(library, {
          operationId: input.operation_id,
          folderId: input.folder_id,
          name: input.name,
          parentId: input.parent_id,
          icon: input.icon,
          color: input.color,
        }),
      ),
  )

  server.registerTool(
    'update_folder',
    {
      title: 'Update folder',
      description:
        'Rename, move, or change the appearance of a folder ' +
        'with timestamp conflict protection.',
      inputSchema: z.object({
        operation_id: operationId,
        folder_id: noteId,
        expected_updated_at: z.number().int().nonnegative(),
        name: z.string().trim().min(1).max(120).optional(),
        parent_id: noteId.nullable().optional(),
        icon: z.string().max(80).nullable().optional(),
        color: z.string().max(32).nullable().optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        updateMcpFolder(library, {
          operationId: input.operation_id,
          folderId: input.folder_id,
          expectedUpdatedAt: input.expected_updated_at,
          name: input.name,
          parentId: input.parent_id,
          icon: input.icon,
          color: input.color,
        }),
      ),
  )

  server.registerTool(
    'create_tag',
    {
      title: 'Create tag',
      description:
        'Create a persistent private tag for later use in Markdown notes.',
      inputSchema: z.object({
        operation_id: operationId,
        tag_id: noteId.optional(),
        name: z.string().trim().min(1).max(60),
        color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .nullable()
          .optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        createMcpTag(library, {
          operationId: input.operation_id,
          tagId: input.tag_id,
          name: input.name,
          color: input.color,
        }),
      ),
  )

  server.registerTool(
    'update_tag',
    {
      title: 'Update tag',
      description:
        'Rename or recolor a tag; renames safely rewrite Markdown ' +
        'and YAML tag sources with history.',
      inputSchema: z.object({
        operation_id: operationId,
        tag_id: noteId,
        name: z.string().trim().min(1).max(60).optional(),
        color: z
          .string()
          .regex(/^#[0-9a-f]{6}$/i)
          .nullable()
          .optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        updateMcpTag(library, {
          operationId: input.operation_id,
          tagId: input.tag_id,
          name: input.name,
          color: input.color,
        }),
      ),
  )

  server.registerTool(
    'preview_tag_change',
    {
      title: 'Preview tag change',
      description:
        'Preview the note impact and any merge target ' +
        'before renaming or deleting a tag.',
      inputSchema: z.object({
        tag_id: noteId,
        next_name: z.string().trim().min(1).max(60).nullable().optional(),
      }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async (input, ctx) =>
      customTool(ctx, options, () =>
        previewMcpTagChange(
          options.env.DB,
          options.auth.userId,
          input.tag_id,
          input.next_name,
        ),
      ),
  )

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete tag',
      description:
        'Delete one tag and safely remove it from Markdown and YAML ' +
        'sources with version history.',
      inputSchema: z.object({ operation_id: operationId, tag_id: noteId }),
      outputSchema: generalOutputSchema,
      annotations: { ...writeAnnotations(true), destructiveHint: true },
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        deleteMcpTag(library, {
          operationId: input.operation_id,
          tagId: input.tag_id,
        }),
      ),
  )

  server.registerTool(
    'preview_folder_removal',
    {
      title: 'Preview folder removal',
      description:
        'Preview exactly which notes and child folders would be promoted, ' +
        'including name conflicts.',
      inputSchema: z.object({ folder_id: noteId }),
      outputSchema: generalOutputSchema,
      annotations: readOnlyAnnotations(),
    },
    async ({ folder_id }, ctx) =>
      customTool(ctx, options, () =>
        previewMcpFolderRemoval(options.env.DB, options.auth.userId, folder_id),
      ),
  )

  server.registerTool(
    'remove_folder_and_promote_contents',
    {
      title: 'Remove folder and promote contents',
      description:
        'Remove one folder while preserving its notes and child folders ' +
        'by moving them to the parent.',
      inputSchema: z.object({
        operation_id: operationId,
        folder_id: noteId,
        expected_updated_at: z.number().int().nonnegative(),
      }),
      outputSchema: generalOutputSchema,
      annotations: { ...writeAnnotations(true), destructiveHint: true },
    },
    async (input, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        removeMcpFolderAndPromote(library, {
          operationId: input.operation_id,
          folderId: input.folder_id,
          expectedUpdatedAt: input.expected_updated_at,
        }),
      ),
  )

  server.registerTool(
    'bulk_organize_notes',
    {
      title: 'Bulk organize notes',
      description:
        'Safely organize up to 20 explicitly identified notes; ' +
        'every item has its own revision guard.',
      inputSchema: z.object({
        operation_id: operationId,
        items: z
          .array(
            z.object({
              note_id: noteId,
              expected_rev: expectedRev,
              folder_id: noteId.nullable().optional(),
              starred: z.boolean().optional(),
              archived: z.boolean().optional(),
              pinned: z.boolean().optional(),
            }),
          )
          .min(1)
          .max(20),
      }),
      outputSchema: generalOutputSchema,
      annotations: writeAnnotations(true),
    },
    async ({ operation_id, items }, ctx) =>
      writeTool(ctx, options, MCP_SCOPES.write, () =>
        bulkOrganizeMcpNotes(
          library,
          operation_id,
          items.map((item) => ({
            noteId: item.note_id,
            expectedRev: item.expected_rev,
            folderId: item.folder_id,
            starred: item.starred,
            archived: item.archived,
            pinned: item.pinned,
          })),
        ),
      ),
  )
}
