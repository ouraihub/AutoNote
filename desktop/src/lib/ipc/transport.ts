import { invoke, convertFileSrc, Channel } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { CallOptions, TransferOptions } from '@app/backend'
import { isProgressEvent } from '@shared/backend-types'
import type { FlushResult } from '@shared/backend-types'
import type { SyncResponse } from '@shared/types'
import type { McpLocalStatus, ProgressEvent } from '@shared/backend-types'
import type { SyncStatus } from './ports/remote-sync'
import type { CommandArgs, CommandResults, TransferArgs } from './commands'
import { cancelled, invalidResponse, ipcError } from './errors'
import { isSyncResponse, record, validateResponse } from './validation'
import type { AiChatEvent, AiChatRequest, AiModelRef, AiWriteEvent, AiWriteRequest } from './ports/ai'

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
  aiChat(
    request: AiChatRequest,
    onEvent: (event: AiChatEvent) => void,
    options?: CallOptions,
  ): Promise<{ conversationId: string }>
  aiWrite(
    request: AiWriteRequest,
    onEvent: (event: AiWriteEvent) => void,
    options?: CallOptions,
  ): Promise<{ model: AiModelRef; isFallback: boolean }>
  flushNotes(noteId?: string, options?: CallOptions): Promise<FlushResult>
  onPrepareClose(flush: () => Promise<FlushResult>, closing: (active: boolean) => void): Promise<() => void>
  listenIntents(listener: (intent: 'new-note') => void): Promise<() => void>
  listenSyncStatus(listener: (status: SyncStatus) => void): Promise<() => void>
  listenMcpStatus(listener: (status: McpLocalStatus) => void): Promise<() => void>
  dispose(): Promise<void>
}

type IpcFailureObserver = (command: string, code: string) => void
let failureObserver: IpcFailureObserver | undefined
export function observeIpcFailures(observer: IpcFailureObserver | undefined): void {
  failureObserver = observer
}
function reportFailure(command: string, error: unknown): void {
  const code = ipcError(error).code
  if (command !== 'app_log' && code !== 'cancelled') failureObserver?.(command, code)
}
export class TauriTransport implements IpcTransport {
  #disposed = false
  #pending = new Set<Promise<unknown>>()
  #listeners = new Set<() => void>()
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
  async #chatHistory(command: string, args: unknown, options?: CallOptions): Promise<unknown> {
    if (command === 'ai_conversation_delete') return this.#call('plugin:aether|chat_delete', args as object, options)
    if (command === 'ai_conversations_list') {
      const rows = await this.#call<unknown>('plugin:aether|chat_conversations', { scope: null }, options)
      if (!Array.isArray(rows)) throw invalidResponse()
      return rows.map((row) => {
        if (!record(row)) throw invalidResponse()
        return { id: row.id, title: row.title, updatedAt: row.updatedAt }
      })
    }
    const value = await this.#call<unknown>('plugin:aether|chat_conversation', args as object, options)
    if (!record(value) || !record(value.summary) || !Array.isArray(value.turns)) throw invalidResponse()
    const summary = value.summary
    if (
      !record(summary) ||
      typeof summary.id !== 'string' ||
      typeof summary.title !== 'string' ||
      !Number.isSafeInteger(summary.createdAt)
    )
      throw invalidResponse()
    return {
      id: summary.id,
      title: summary.title,
      messages: value.turns.flatMap((turn) => {
        if (
          !record(turn) ||
          typeof turn.id !== 'string' ||
          typeof turn.input !== 'string' ||
          typeof turn.text !== 'string'
        )
          throw invalidResponse()
        const status =
          turn.status === 'completed'
            ? 'done'
            : turn.status === 'cancelled' || turn.status === 'running' || turn.errorCode === 'interrupted'
              ? 'interrupted'
              : 'failed'
        return [
          {
            id: `${turn.id}:user`,
            role: 'user',
            content: turn.input,
            status: 'done',
            modelId: null,
            createdAt: summary.createdAt,
          },
          {
            id: `${turn.id}:assistant`,
            role: 'assistant',
            content: turn.text || (status === 'failed' ? String(turn.errorCode ?? 'failed') : ''),
            status,
            modelId: turn.modelId,
            createdAt: summary.createdAt,
          },
        ]
      }),
    }
  }
  async invoke<K extends keyof CommandArgs>(
    command: K,
    args: CommandArgs[K],
    options?: CallOptions,
  ): Promise<CommandResults[K]> {
    const jobId = command === 'ai_endpoint_probe' ? (args as CommandArgs['ai_endpoint_probe']).jobId : undefined
    const cancel = () => this.invoke('jobs_cancel', { jobId: jobId! })
    const abort = () => {
      void cancel().catch(() => {
        this.cancellationFailed = true
      })
    }
    if (jobId) {
      this.#jobs.set(jobId, cancel)
      options?.signal?.addEventListener('abort', abort, { once: true })
    }
    try {
      const result = ['ai_conversations_list', 'ai_conversation_get', 'ai_conversation_delete'].includes(command)
        ? ((await this.#chatHistory(command, args, options)) as CommandResults[K])
        : await this.#call<CommandResults[K]>(command, args, options)
      validateResponse(command, result)
      return result
    } catch (error) {
      reportFailure(command, error)
      throw error
    } finally {
      if (jobId) {
        this.#jobs.delete(jobId)
        options?.signal?.removeEventListener('abort', abort)
      }
    }
  }
  async #listen<T>(event: string, listener: (payload: T) => void): Promise<() => void> {
    if (this.#disposed) throw cancelled()
    const release = await listen<T>(event, ({ payload }) => {
      if (!this.#disposed) listener(payload)
    })
    if (this.#disposed) {
      release()
      throw cancelled()
    }
    const unlisten = () => {
      release()
      this.#listeners.delete(unlisten)
    }
    this.#listeners.add(unlisten)
    return unlisten
  }
  listenLibrary(listener: (payload: SyncResponse) => void): Promise<() => void> {
    return this.#listen<unknown>('autonote://library-changed', (payload) => {
      if (isSyncResponse(payload)) listener(payload)
    })
  }
  async flushNotes(noteId?: string, options?: CallOptions): Promise<FlushResult> {
    const writes = await Promise.allSettled([...this.#writes])
    const result = await this.invoke('notes_flush', noteId === undefined ? {} : { noteId }, options)
    return {
      pending: result.pending,
      failed: result.failed + writes.filter((write) => write.status === 'rejected').length,
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
    const result = await this.#call<{ received: number }>('files_upload_chunk', bytes, options, {
      'x-autonote-upload-id': uploadId,
      'x-autonote-offset': String(offset),
    })
    if (!record(result) || result.received !== offset + bytes.byteLength) throw invalidResponse()
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
        (previous?.phase !== event.phase || event.completed >= previous.completed)
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
      const result = await this.#call<unknown>(command, { ...args, jobId, channel })
      if (!record(result)) throw invalidResponse()
      if (result.kind === 'cancelled') return null
      if (result.kind !== 'completed' || !record(result.value)) throw invalidResponse()
      const value = result.value
      if (
        command === 'transfer_export'
          ? value.saved !== true
          : !Array.isArray(value.warnings) ||
            value.warnings.length > 100 ||
            !value.warnings.every((warning: unknown) => typeof warning === 'string') ||
            ![
              'createdNotes',
              'updatedNotes',
              'skippedNotes',
              'createdFolders',
              'createdAttachments',
              'skippedAttachments',
            ].every((key) => {
              const count = value[key]
              return typeof count === 'number' && Number.isSafeInteger(count) && count >= 0
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
      const result = await this.#call<{ ok: true; indexed: number }>('search_reindex', { jobId, onProgress })
      if (!record(result) || result.ok !== true || !Number.isSafeInteger(result.indexed)) throw invalidResponse()
      return result
    } finally {
      options?.signal?.removeEventListener('abort', abort)
      this.#jobs.delete(jobId)
    }
  }
  /** The product port settles after Aether's terminal event, not acceptance. */
  async aiChat(
    request: AiChatRequest,
    onEvent: (event: AiChatEvent) => void,
    options?: CallOptions,
  ): Promise<{ conversationId: string }> {
    if (options?.signal?.aborted) throw cancelled()
    const terminal = Promise.withResolvers<unknown>()
    const channel = new Channel<unknown>()
    let open = true
    let usage = { inputTokens: null as number | null, outputTokens: null as number | null }
    channel.onmessage = (event) => {
      if (!open || !record(event)) return
      if (event.kind === 'end') terminal.resolve(event)
      else if (!this.#disposed && !options?.signal?.aborted) {
        if (event.kind === 'text_delta' && typeof event.text === 'string') onEvent({ kind: 'delta', text: event.text })
        else if (event.kind === 'usage')
          usage = {
            inputTokens: Number.isSafeInteger(event.inputTokens) ? (event.inputTokens as number) : null,
            outputTokens: Number.isSafeInteger(event.outputTokens) ? (event.outputTokens as number) : null,
          }
      }
    }
    let runId: string | undefined
    const cancel = () => (runId ? this.#call('plugin:aether|chat_cancel', { runId }) : Promise.resolve())
    const abort = () => {
      void cancel().catch(() => {
        this.cancellationFailed = true
      })
    }
    options?.signal?.addEventListener('abort', abort, { once: true })
    try {
      const note = request.note
      const accepted = await this.#call<unknown>(
        'plugin:aether|chat_run',
        {
          request: {
            purpose: 'chat',
            model: request.model ?? null,
            skills: [],
            context: note && 'id' in note && note.id ? { kind: 'autonote-note', id: note.id } : null,
            scope: note && 'id' in note && note.id ? `note:${note.id}` : 'autonote',
            input: request.content,
            conversationId: request.conversationId ?? null,
            regenerate: request.regenerate ?? false,
            language: document.documentElement.lang || 'zh-CN',
          },
          onEvent: channel,
        },
        options,
      )
      if (!record(accepted) || typeof accepted.runId !== 'string' || typeof accepted.conversationId !== 'string')
        throw invalidResponse()
      runId = accepted.runId
      this.#jobs.set(runId, cancel)
      if (options?.signal?.aborted || this.#disposed) abort()
      const end = await terminal.promise
      if (!record(end)) throw invalidResponse()
      if (end.status === 'cancelled') throw cancelled()
      if (end.status !== 'completed') throw ipcError(end.error)
      onEvent({ kind: 'done', ...usage })
      return { conversationId: accepted.conversationId }
    } finally {
      open = false
      options?.signal?.removeEventListener('abort', abort)
      if (runId) this.#jobs.delete(runId)
    }
  }
  async aiWrite(
    request: AiWriteRequest,
    onEvent: (event: AiWriteEvent) => void,
    options?: CallOptions,
  ): Promise<{ model: AiModelRef; isFallback: boolean }> {
    if (options?.signal?.aborted) throw cancelled()
    const jobId = crypto.randomUUID()
    const channel = new Channel<unknown>()
    let open = true
    channel.onmessage = (event) => {
      if (!open || this.#disposed || options?.signal?.aborted || !record(event)) return
      if (event.kind === 'delta' && typeof event.text === 'string') onEvent({ kind: 'delta', text: event.text })
      else if (event.kind === 'done')
        onEvent({
          kind: 'done',
          inputTokens: Number.isSafeInteger(event.inputTokens) ? (event.inputTokens as number) : null,
          outputTokens: Number.isSafeInteger(event.outputTokens) ? (event.outputTokens as number) : null,
        })
    }
    const cancel = () => this.invoke('jobs_cancel', { jobId })
    const abort = () => {
      void cancel().catch(() => {
        this.cancellationFailed = true
      })
    }
    this.#jobs.set(jobId, cancel)
    options?.signal?.addEventListener('abort', abort, { once: true })
    try {
      const result = await this.#call<unknown>('ai_write', { jobId, request, onEvent: channel })
      validateResponse('ai_write', result)
      const { model, isFallback } = result as CommandResults['ai_write']
      return { model, isFallback }
    } catch (error) {
      reportFailure('ai_write', error)
      throw error
    } finally {
      open = false
      options?.signal?.removeEventListener('abort', abort)
      this.#jobs.delete(jobId)
    }
  }
  async onPrepareClose(flush: () => Promise<FlushResult>, closing: (active: boolean) => void): Promise<() => void> {
    const releaseCancelled = await this.#listen('autonote://close-cancelled', () => closing(false))
    try {
      const releasePrepare = await this.#listen<unknown>('autonote://prepare-close', (payload) => {
        if (!record(payload) || typeof payload.requestId !== 'number' || !Number.isSafeInteger(payload.requestId))
          return
        const requestId = payload.requestId
        closing(true)
        void (async () => {
          let result: FlushResult
          try {
            result = await flush()
          } catch {
            result = { pending: 0, failed: 1 }
          }
          await this.invoke('desktop_close_ack', { requestId, ...result })
        })().catch(() => {
          closing(false)
        })
      })
      return () => {
        releasePrepare()
        releaseCancelled()
        closing(false)
      }
    } catch (error) {
      releaseCancelled()
      throw error
    }
  }
  listenIntents(listener: (intent: 'new-note') => void): Promise<() => void> {
    return this.#listen<unknown>('autonote://ui-intent', (intent) => {
      if (intent === 'new-note') listener(intent)
    })
  }
  listenSyncStatus(listener: (status: SyncStatus) => void): Promise<() => void> {
    return this.#listen<unknown>('autonote://sync-status', (payload) => {
      try {
        validateResponse('sync_status', payload)
      } catch {
        return
      }
      listener(payload as SyncStatus)
    })
  }
  listenMcpStatus(listener: (status: McpLocalStatus) => void): Promise<() => void> {
    return this.#listen<unknown>('autonote://mcp-status', (payload) => {
      if (
        record(payload) &&
        typeof payload.running === 'boolean' &&
        typeof payload.port === 'number' &&
        Number.isInteger(payload.port) &&
        payload.port >= 1024 &&
        payload.port <= 65535 &&
        (payload.endpoint === null || typeof payload.endpoint === 'string') &&
        (payload.error === null || typeof payload.error === 'string')
      )
        listener(payload as unknown as McpLocalStatus)
    })
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return
    await Promise.allSettled([...this.#jobs.values()].map((cancel) => cancel()))
    this.#disposed = true
    for (const release of this.#listeners) release()
    await Promise.allSettled([...this.#pending])
  }
}

// Non-domain diagnostic panels share the same sole Tauri boundary.
const diagnostics = new TauriTransport()
export function call<K extends keyof CommandArgs>(command: K, args: CommandArgs[K]): Promise<CommandResults[K]> {
  return diagnostics.invoke(command, args)
}
export function listenSyncStatus(listener: (status: SyncStatus) => void): Promise<() => void> {
  return diagnostics.listenSyncStatus(listener)
}
