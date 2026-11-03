import type { AppBindings } from '../../env'
import type { ImportContext } from './types'
import { addWarning } from './values'
import { assertContentSize } from '../../lib/request'
import { collectObsidianReferences } from '../../lib/obsidian-import'
import { ensureFolderPath } from './folders'
import { findObsidianAsset } from '../../lib/obsidian-import'
import { importedMarkdownTitle } from './values'
import { insertNote } from './notes'
import { mimeForAttachmentName } from '../../lib/obsidian-import'
import { newId } from '../../lib/id'
import { parseDate } from './values'
import { persistAttachmentWithinQuota } from '../../attachments/storage'
import { rewriteObsidianReferences } from '../../lib/obsidian-import'
import { splitFrontMatter } from '@shared/markdown-utils'
import { stripObsidianComments } from '../../lib/obsidian-import'

export async function importMarkdown(
  c: { env: AppBindings['Bindings'] },
  userId: string,
  path: string,
  text: string,
  ctx: ImportContext,
): Promise<void> {
  assertContentSize(text)

  const { meta } = splitFrontMatter(text)
  const normalizedPath = path.replace(/\\/g, '/')
  const dir = normalizedPath.split('/').slice(0, -1).filter(Boolean)
  if (dir[0]?.toLowerCase() === 'notes') dir.shift()
  const folderId = dir.length
    ? await ensureFolderPath(c.env.DB, userId, dir.join('/'), ctx)
    : null

  const filename = normalizedPath.split('/').pop() ?? path
  let content = stripObsidianComments(text)
  if (ctx.assets) {
    const assetDir = normalizedPath.split('/').slice(0, -1).join('/')
    const references = collectObsidianReferences(content)
    const replacements = new Map<string, string>()
    for (const reference of references) {
      if (replacements.has(reference)) continue
      const asset = findObsidianAsset(ctx.assets, reference, assetDir)
      if (!asset) continue
      try {
        const persisted = await persistAttachmentWithinQuota(c.env, {
          id: newId(),
          userId,
          noteId: null,
          filename: asset.name,
          reportedMime: mimeForAttachmentName(asset.name),
          bytes: asset.bytes,
          createdAt: Date.now(),
        })
        replacements.set(reference, `/api/files/${persisted.id}`)
        ctx.result.createdAttachments++
      } catch (error) {
        addWarning(
          ctx.result,
          `${asset.name}: a referenced file could not be imported`,
        )
      }
    }
    if (replacements.size) {
      content = rewriteObsidianReferences(
        content,
        (reference) => replacements.get(reference) ?? null,
      )
    }
  }
  const title = importedMarkdownTitle(
    meta,
    content,
    filename.replace(/\.(md|markdown|txt)$/i, ''),
  )

  await insertNote(
    c,
    userId,
    {
      content,
      title,
      folderId,
      isStarred: meta.starred === 'true',
      isPinned: meta.pinned === 'true',
      isArchived: meta.archived === 'true',
      createdAt: parseDate(meta.created),
      updatedAt: parseDate(meta.updated),
    },
    ctx,
  )
  ctx.result.createdNotes++
}
