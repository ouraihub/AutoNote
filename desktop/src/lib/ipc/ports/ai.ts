import type { CallOptions } from '@app/backend'
import type { AiWriteAction, AiWriteEvent, AiWriteRequest } from '@shared/ai-types'
import type { IpcTransport } from '../transport'

export type AiProtocol = 'anthropic-messages' | 'openai-chat' | 'openai-responses'
export type AiModelType = 'chat' | 'image' | 'video' | 'tts' | 'stt' | 'embedding' | 'rerank' | 'unknown'
export type AiTypeSource = 'inferred' | 'user'
export type AiRole = 'chat' | 'writing'

export interface AiModel {
  id: string
  modelType: AiModelType
  typeSource: AiTypeSource
  contextWindow: number | null
  canVision: boolean
}
export interface AiEndpoint {
  id: string
  slug: string
  baseUrl: string
  protocol: AiProtocol
  keyMasked: string | null
  probeUrl: string
  models: AiModel[]
}
export interface AiProvider {
  id: string
  name: string
  endpoints: AiEndpoint[]
}

export interface AiEndpointSave {
  id?: string
  slug: string
  baseUrl: string
  protocol: AiProtocol
  apiKey?: string
  models: AiModel[]
}
export interface AiProviderSave {
  id?: string
  name: string
  endpoints: AiEndpointSave[]
}

export interface AiProbeResult {
  probeUrl: string
  models: (AiModel & { group: string | null })[]
  error: AiProbeError | null
}
export interface AiProbeError {
  kind:
    'missing_key' | 'unauthorized' | 'not_found' | 'rate_limited' | 'status' | 'timeout' | 'connect' | 'invalid_body'
  status: number | null
  /** Provider's own error text, sanitized (≤ 300 chars, never the key). */
  message: string | null
}

export interface AiModelRef {
  endpointId: string
  modelId: string
}
export interface AiRoleBinding {
  role: AiRole
  binding: (AiModelRef & { label: string }) | null
  isFallback: boolean
}

export interface AiConversationSummary {
  id: string
  title: string
  updatedAt: number
}
export interface AiStoredMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status: 'done' | 'failed' | 'interrupted'
  modelId: string | null
  createdAt: number
}
export interface AiConversation {
  id: string
  title: string
  messages: AiStoredMessage[]
}
export type AiChatEvent =
  { kind: 'delta'; text: string } | { kind: 'done'; inputTokens: number | null; outputTokens: number | null }
export type { AiWriteAction, AiWriteEvent, AiWriteRequest }

export interface AiChatRequest {
  /** Omitted: start a new conversation. */
  conversationId?: string
  /** The new user message; ignored with `regenerate`. */
  content: string
  /** Drop the last assistant reply and answer the last user message again. */
  regenerate?: boolean
  role?: AiRole
  model?: AiModelRef
  /** Current note; goes into the system prompt only, never stored. */
  note?: { title: string; content: string }
  maxTokens?: number
}

export interface AiPort {
  listProviders(options?: CallOptions): Promise<AiProvider[]>
  saveProvider(provider: AiProviderSave, options?: CallOptions): Promise<AiProvider[]>
  deleteProvider(id: string, options?: CallOptions): Promise<{ ok: true }>
  revealKey(endpointId: string, options?: CallOptions): Promise<string>
  probe(endpointId: string, options?: CallOptions): Promise<AiProbeResult>
  roles(options?: CallOptions): Promise<AiRoleBinding[]>
  setRole(role: AiRole, binding: AiModelRef | null, options?: CallOptions): Promise<AiRoleBinding[]>
  listConversations(options?: CallOptions): Promise<AiConversationSummary[]>
  getConversation(id: string, options?: CallOptions): Promise<AiConversation>
  deleteConversation(id: string, options?: CallOptions): Promise<{ ok: true }>
  chat(
    request: AiChatRequest,
    onEvent: (event: AiChatEvent) => void,
    options?: CallOptions,
  ): Promise<{ conversationId: string }>
  write(
    request: AiWriteRequest,
    onEvent: (event: AiWriteEvent) => void,
    options?: CallOptions,
  ): Promise<{ model: AiModelRef; isFallback: boolean }>
}

export function aiPort(transport: Pick<IpcTransport, 'invoke' | 'aiChat' | 'aiWrite'>): AiPort {
  return {
    listProviders: (options) => transport.invoke('ai_providers_list', undefined, options),
    saveProvider: (provider, options) => transport.invoke('ai_provider_save', { provider }, options),
    deleteProvider: (id, options) => transport.invoke('ai_provider_delete', { id }, options),
    revealKey: async (endpointId, options) =>
      (await transport.invoke('ai_endpoint_key_reveal', { id: endpointId }, options)).key,
    probe: (endpointId, options) => transport.invoke('ai_endpoint_probe', { id: endpointId }, options),
    roles: (options) => transport.invoke('ai_roles_get', undefined, options),
    setRole: (role, binding, options) => transport.invoke('ai_roles_set', { role, binding }, options),
    listConversations: (options) => transport.invoke('ai_conversations_list', undefined, options),
    getConversation: (id, options) => transport.invoke('ai_conversation_get', { id }, options),
    deleteConversation: (id, options) => transport.invoke('ai_conversation_delete', { id }, options),
    chat: (request, onEvent, options) => transport.aiChat(request, onEvent, options),
    write: (request, onEvent, options) => transport.aiWrite(request, onEvent, options),
  }
}

