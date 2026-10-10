import { BackendError } from '@app/backend/errors'
import type {
  AiChatEvent,
  AiChatRequest,
  AiConversation,
  AiConversationSummary,
  AiModelRef,
  AiPort,
  AiProbeResult,
  AiProvider,
  AiProviderSave,
  AiRole,
  AiRoleBinding,
  AiWriteEvent,
  AiWriteRequest,
} from '@shared/ai-types'
import type { HttpTransport } from '../transport'

export interface AiPortDeps {
  readonly transport: Pick<HttpTransport, 'json' | 'raw'>
}
export class HttpAiPort implements AiPort {
  constructor(private readonly deps: AiPortDeps) {}
  listProviders(options?: { signal?: AbortSignal }): Promise<AiProvider[]> {
    return this.deps.transport.json({ path: '/api/ai/providers', signal: options?.signal })
  }

  saveProvider(provider: AiProviderSave, options?: { signal?: AbortSignal }): Promise<AiProvider[]> {
    return this.deps.transport.json({
      method: 'PUT',
      path: '/api/ai/providers',
      body: { provider },
      signal: options?.signal,
    })
  }
  deleteProvider(id: string, options?: { signal?: AbortSignal }): Promise<{ ok: true }> {
    return this.deps.transport.json({
      method: 'DELETE',
      path: `/api/ai/providers/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  async revealKey(endpointId: string, options?: { signal?: AbortSignal }): Promise<string> {
    const result = await this.deps.transport.json<{ key: string }>({
      method: 'POST',
      path: `/api/ai/endpoints/${encodeURIComponent(endpointId)}/key`,
      body: {},
      signal: options?.signal,
    })
    return result.key
  }
  probe(endpointId: string, options?: { signal?: AbortSignal }): Promise<AiProbeResult> {
    return this.deps.transport.json({
      method: 'POST',
      path: `/api/ai/endpoints/${encodeURIComponent(endpointId)}/probe`,
      signal: options?.signal,
    })
  }
  roles(options?: { signal?: AbortSignal }): Promise<AiRoleBinding[]> {
    return this.deps.transport.json({ path: '/api/ai/roles', signal: options?.signal })
  }
  setRole(role: AiRole, binding: AiModelRef | null, options?: { signal?: AbortSignal }): Promise<AiRoleBinding[]> {
    return this.deps.transport.json({
      method: 'PUT',
      path: '/api/ai/roles',
      body: { role, binding },
      signal: options?.signal,
    })
  }
  async listConversations(options?: { signal?: AbortSignal }): Promise<AiConversationSummary[]> {
    const result = await this.deps.transport.json<AiConversationSummary[] | { conversations: AiConversationSummary[] }>(
      { path: '/api/ai/conversations', signal: options?.signal },
    )
    return Array.isArray(result) ? result : result.conversations
  }
  getConversation(id: string, options?: { signal?: AbortSignal }): Promise<AiConversation> {
    return this.deps.transport.json({
      path: `/api/ai/conversations/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  deleteConversation(id: string, options?: { signal?: AbortSignal }): Promise<{ ok: true }> {
    return this.deps.transport.json({
      method: 'DELETE',
      path: `/api/ai/conversations/${encodeURIComponent(id)}`,
      signal: options?.signal,
    })
  }
  async chat(
    request: AiChatRequest,
    onEvent: (event: AiChatEvent) => void,
    options?: { signal?: AbortSignal },
  ): Promise<{ conversationId: string }> {
    let conversationId: string | undefined
    await this.stream(
      '/api/ai/chat',
      request,
      (event) => {
        if (event.kind === 'meta' && typeof event.conversationId === 'string') conversationId = event.conversationId
        else if (event.kind === 'delta' || event.kind === 'done') onEvent(event as AiChatEvent)
      },
      options?.signal,
    )
    if (!conversationId) throw new BackendError('invalid_response', 502, 'Missing conversation id')
    return { conversationId }
  }
  async write(
    request: AiWriteRequest,
    onEvent: (event: AiWriteEvent) => void,
    options?: { signal?: AbortSignal },
  ): Promise<{ model: AiModelRef; isFallback: boolean }> {
    let result: { model: AiModelRef; isFallback: boolean } | undefined
    await this.stream(
      '/api/ai/write',
      request,
      (event) => {
        if (event.kind === 'meta' && event.model && typeof event.isFallback === 'boolean')
          result = { model: event.model as AiModelRef, isFallback: event.isFallback }
        else if (event.kind === 'delta' || event.kind === 'done') onEvent(event as AiWriteEvent)
      },
      options?.signal,
    )
    if (!result) throw new BackendError('invalid_response', 502, 'Missing model result')
    return result
  }

  private async stream(
    path: `/api/${string}`,
    body: unknown,
    onEvent: (value: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.deps.transport.raw({ method: 'POST', path, body, signal })
    if (!response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body)
      throw new BackendError('invalid_response', 502, 'Expected event stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let done = false
    try {
      while (true) {
        const chunk = await reader.read()
        if (signal?.aborted) throw new BackendError('cancelled', 0, 'Request cancelled')
        buffer += decoder.decode(chunk.value, { stream: !chunk.done }).replaceAll('\r\n', '\n')
        let boundary: number
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const lines = buffer
            .slice(0, boundary)
            .split('\n')
            .filter((line) => line.startsWith('data:'))
          buffer = buffer.slice(boundary + 2)
          if (lines.length === 0) continue
          let value: unknown
          try {
            value = JSON.parse(lines.map((line) => line.slice(5).trimStart()).join('\n'))
          } catch {
            throw new BackendError('invalid_response', 502, 'Invalid event stream')
          }
          if (
            !value ||
            typeof value !== 'object' ||
            Array.isArray(value) ||
            typeof (value as Record<string, unknown>).kind !== 'string'
          )
            throw new BackendError('invalid_response', 502, 'Invalid event stream')
          const event = value as Record<string, unknown>
          if (event.kind === 'error')
            throw new BackendError(
              'internal',
              502,
              typeof event.message === 'string' ? event.message : 'AI stream failed',
            )
          if (event.kind === 'done') done = true
          onEvent(event)
        }
        if (chunk.done) break
      }
      if (!done) throw new BackendError('invalid_response', 502, 'Incomplete event stream')
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
}
