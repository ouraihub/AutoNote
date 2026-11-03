import { invoke, convertFileSrc, Channel } from '@tauri-apps/api/core'
import type { CallOptions, TransferOptions } from '@app/backend'
import { isProgressEvent } from '@shared/backend-types'
import type {
  FlushResult,
  McpLocalStatus,
  ProgressEvent,
} from '@shared/backend-types'
import type { SyncResponse } from '@shared/types'
import type { SyncStatus } from './ports/remote-sync'
import type { CommandArgs, CommandResults, TransferArgs } from './commands'
import { cancelled, invalidResponse, ipcError } from './errors'
import { record, validateResponse } from './validation'
import { IpcEventListeners } from './events'

export interface IpcTransport {
  invoke<K extends keyof CommandArgs>(
    command: K,
    args: CommandArgs[K],
    options?: CallOptions,
  ): Promise<CommandResults[K]>
  listenLibrary(listener: (payload: SyncResponse) => void): Promise<() => void>
  changesSince(since: number): Promise<SyncResponse>
  resolveFileUrl(id: string): string
  uploadChunk(
    uploadId: string,
    offset: number,
    bytes: ArrayBuffer,
    options?: CallOptions,
  ): Promise<{ received: number }>
  invokeJob<T>(
    command: 'transfer_export' | 'transfer_import',
    args: TransferArgs,
    options?: TransferOptions,
  ): Promise<T | null>
  reindex(options?: CallOptions): Promise<{ ok: true; indexed: number }>
  flushNotes(noteId?: string, options?: CallOptions): Promise<FlushResult>
  onPrepareClose(
    flush: () => Promise<FlushResult>,
    closing: (active: boolean) => void,
  ): Promise<() => void>
  listenIntents(listener: (intent: 'new-note') => void): Promise<() => void>
  listenSyncStatus(listener: (status: SyncStatus) => void): Promise<() => void>
  listenMcpStatus(
    listener: (status: McpLocalStatus) => void,
  ): Promise<() => void>
  dispose(): Promise<void>
}

type IpcFailureObserver = (command: string, code: string) => void
let failureObserver: IpcFailureObserver | undefined
export function observeIpcFailures(
  observer: IpcFailureObserver | undefined,
): void {
  failureObserver = observer
}
function reportFailure(command: string, error: unknown): void {
  const code = ipcError(error).code
  if (command !== 'app_log' && code !== 'cancelled')
    failureObserver?.(command, code)
}
export class TauriTransport implements IpcTransport {
  #disposed = false
  #pending = new Set<Promise<unknown>>()
  #events = new IpcEventListeners()
  #jobs = new Map<string, () => Promise<unknown>>()
  #writes = new Set<Promise<unknown>>()
  cancellationFailed = false
  async #call<T>(
    command: string,
    args: object | ArrayBuffer | undefined,
    options?: CallOptions,
    headers?: Record<string, string>,
  ): Promise<T> {
    if (this.#disposed) throw cancelled()
    if (options?.signal?.aborted) throw cancelled()
    // Invoke cannot abort a durable commit: always await its real outcome.
    const pending = invoke<T>(
      command,
      args as Record<string, unknown> | ArrayBuffer | undefined,
      headers ? { headers } : undefined,
    )
    this.#pending.add(pending)
    const writing = [
      'notes_create',
      'notes_patch',
      'notes_remove',
      'notes_restore',
      'notes_purge',
      'notes_duplicate',
      'notes_empty_trash',
      'notes_restore_version',
    ].includes(command)
    if (writing) this.#writes.add(pending)
    try {
      return await pending
    } catch (error) {
      throw ipcError(error)
    } finally {
      this.#pending.delete(pending)
      this.#writes.delete(pending)
    }
  }
  async invoke<K extends keyof CommandArgs>(
    command: K,
    args: CommandArgs[K],
    options?: CallOptions,
  ): Promise<CommandResults[K]> {
    try {
      const result = await this.#call<CommandResults[K]>(command, args, options)
      validateResponse(command, result)
      return result
    } catch (error) {
      reportFailure(command, error)
      throw error
    }
  }
  listenLibrary(
    listener: (payload: SyncResponse) => void,
  ): Promise<() => void> {
    return this.#events.listenLibrary(listener)
  }
  async flushNotes(
    noteId?: string,
    options?: CallOptions,
  ): Promise<FlushResult> {
    const writes = await Promise.allSettled([...this.#writes])
    const result = await this.invoke(
      'notes_flush',
      noteId === undefined ? {} : { noteId },
      options,
    )
    return {
      pending: result.pending,
      failed:
        result.failed +
        writes.filter((write) => write.status === 'rejected').length,
    }
  }
  changesSince(since: number): Promise<SyncResponse> {
    return this.invoke('library_changes', { since })
  }
  resolveFileUrl(id: string): string {
    return convertFileSrc(id, 'autonote-file')
  }
  async uploadChunk(
    uploadId: string,
    offset: number,
    bytes: ArrayBuffer,
    options?: CallOptions,
  ): Promise<{ received: number }> {
    const result = await this.#call<{ received: number }>(
      'files_upload_chunk',
      bytes,
      options,
      {
        'x-autonote-upload-id': uploadId,
        'x-autonote-offset': String(offset),
      },
    )
    if (!record(result) || result.received !== offset + bytes.byteLength)
      throw invalidResponse()
    return result
  }
  async invokeJob<T>(
    command: 'transfer_export' | 'transfer_import',
    args: TransferArgs,
    options?: TransferOptions,
  ): Promise<T | null> {
    if (options?.signal?.aborted) return null
    const jobId = crypto.randomUUID()
    const channel = new Channel<unknown>()
    let terminal = false
    let previous: ProgressEvent | undefined
    channel.onmessage = (event) => {
      if (
        !terminal &&
        isProgressEvent(event) &&
        event.jobId === jobId &&
        (event.total === null || event.completed <= event.total) &&
        (previous?.phase !== event.phase ||
          event.completed >= previous.completed)
      ) {
        terminal = event.terminal
        previous = event
        options?.onProgress?.(event)
      }
    }
    const cancel = () => this.invoke('transfer_cancel', { jobId })
    this.#jobs.set(jobId, cancel)
    const abort = () => {
      void cancel().catch(() => {
        this.cancellationFailed = true
      })
    }
    options?.signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await this.#call<unknown>(command, {
        ...args,
        jobId,
        channel,
      })
      if (!record(result)) throw invalidResponse()
      if (result.kind === 'cancelled') return null
      if (result.kind !== 'completed' || !record(result.value))
        throw invalidResponse()
      const value = result.value
      if (
        command === 'transfer_export'
          ? value.saved !== true
          : !Array.isArray(value.warnings) ||
            value.warnings.length > 100 ||
            !value.warnings.every(
              (warning: unknown) => typeof warning === 'string',
            ) ||
            ![
              'createdNotes',
              'updatedNotes',
              'skippedNotes',
              'createdFolders',
              'createdAttachments',
              'skippedAttachments',
            ].every((key) => {
              const count = value[key]
              return (
                typeof count === 'number' &&
                Number.isSafeInteger(count) &&
                count >= 0
              )
            })
      )
        throw invalidResponse()
      return value as T
    } finally {
      terminal = true
      options?.signal?.removeEventListener('abort', abort)
      this.#jobs.delete(jobId)
    }
  }
  async reindex(options?: CallOptions): Promise<{ ok: true; indexed: number }> {
    const jobId = crypto.randomUUID()
    const onProgress = new Channel()
    const cancel = () => this.invoke('jobs_cancel', { jobId })
    const abort = () => {
      void cancel().catch(() => {
        this.cancellationFailed = true
      })
    }
    if (options?.signal?.aborted) throw cancelled()
    this.#jobs.set(jobId, cancel)
    options?.signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await this.#call<{ ok: true; indexed: number }>(
        'search_reindex',
        { jobId, onProgress },
      )
      if (
        !record(result) ||
        result.ok !== true ||
        !Number.isSafeInteger(result.indexed)
      )
        throw invalidResponse()
      return result
    } finally {
      options?.signal?.removeEventListener('abort', abort)
      this.#jobs.delete(jobId)
    }
  }
  onPrepareClose(
    flush: () => Promise<FlushResult>,
    closing: (active: boolean) => void,
  ): Promise<() => void> {
    return this.#events.onPrepareClose(flush, closing, (requestId, result) =>
      this.invoke('desktop_close_ack', { requestId, ...result }),
    )
  }
  listenIntents(listener: (intent: 'new-note') => void): Promise<() => void> {
    return this.#events.listenIntents(listener)
  }
  listenSyncStatus(
    listener: (status: SyncStatus) => void,
  ): Promise<() => void> {
    return this.#events.listenSyncStatus(listener)
  }
  listenMcpStatus(
    listener: (status: McpLocalStatus) => void,
  ): Promise<() => void> {
    return this.#events.listenMcpStatus(listener)
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    await Promise.allSettled([...this.#jobs.values()].map((cancel) => cancel()))
    this.#disposed = true
    this.#events.dispose()
    await Promise.allSettled([...this.#pending])
  }
}

// Non-domain diagnostic panels share the same sole Tauri boundary.
const diagnostics = new TauriTransport()
export function call<K extends keyof CommandArgs>(
  command: K,
  args: CommandArgs[K],
): Promise<CommandResults[K]> {
  return diagnostics.invoke(command, args)
}
export function listenSyncStatus(
  listener: (status: SyncStatus) => void,
): Promise<() => void> {
  return diagnostics.listenSyncStatus(listener)
}
