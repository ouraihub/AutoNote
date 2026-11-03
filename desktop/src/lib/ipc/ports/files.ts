import type { Backend } from '@app/backend'
import type { IpcTransport } from '../transport'
import { cancelled } from '../errors'

export function filesPort(transport: IpcTransport): Backend['files'] {
  return {
    list: (cursor, options) =>
      transport.invoke(
        'files_list',
        cursor === undefined ? {} : { cursor },
        options,
      ),
    async upload(file, noteId, options) {
      const started = await transport.invoke(
        'files_upload_begin',
        {
          filename: file.name,
          mime: file.type || 'application/octet-stream',
          size: file.size,
          ...(noteId === undefined ? {} : { noteId }),
        },
        options,
      )
      try {
        for (
          let offset = 0;
          offset < file.size;
          offset += started.chunkMaxBytes
        ) {
          if (options?.signal?.aborted) throw cancelled()
          const bytes = await file
            .slice(offset, Math.min(file.size, offset + started.chunkMaxBytes))
            .arrayBuffer()
          await transport.uploadChunk(started.uploadId, offset, bytes, options)
        }
        return await transport.invoke(
          'files_upload_finish',
          { uploadId: started.uploadId },
          options,
        )
      } catch (error) {
        await transport
          .invoke('files_upload_cancel', { uploadId: started.uploadId })
          .catch(() => {
            /* Window destruction also reclaims unpublished uploads. */
          })
        throw error
      }
    },
    remove: (id, options) => transport.invoke('files_remove', { id }, options),
    prune: (options) => transport.invoke('files_prune', undefined, options),
    resolveUrl(url) {
      const match = /^\/api\/files\/([0-9a-hjkmnp-tv-z]{26})$/.exec(url)
      return match?.[1] ? transport.resolveFileUrl(match[1]) : url
    },
  }
}
