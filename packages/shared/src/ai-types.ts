/** Product-level AI contract shared by Desktop Tauri and Web transports. */
export interface AiCallOptions {
  signal?: AbortSignal
}

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
  kind: 'missing_key' | 'unauthorized' | 'not_found' | 'rate_limited' | 'status' | 'timeout' | 'connect' | 'invalid_body'
  status: number | null
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
  | { kind: 'delta'; text: string }
  | { kind: 'done'; inputTokens: number | null; outputTokens: number | null }

export interface AiChatRequest {
  conversationId?: string
  content: string
  regenerate?: boolean
  role?: AiRole
  model?: AiModelRef
  note?: { id?: string; title: string; content: string }
  maxTokens?: number
}

export interface AiPort {
  listProviders(options?: AiCallOptions): Promise<AiProvider[]>
  saveProvider(provider: AiProviderSave, options?: AiCallOptions): Promise<AiProvider[]>
  deleteProvider(id: string, options?: AiCallOptions): Promise<{ ok: true }>
  revealKey(endpointId: string, options?: AiCallOptions): Promise<string>
  probe(endpointId: string, options?: AiCallOptions): Promise<AiProbeResult>
  roles(options?: AiCallOptions): Promise<AiRoleBinding[]>
  setRole(role: AiRole, binding: AiModelRef | null, options?: AiCallOptions): Promise<AiRoleBinding[]>
  listConversations(options?: AiCallOptions): Promise<AiConversationSummary[]>
  getConversation(id: string, options?: AiCallOptions): Promise<AiConversation>
  deleteConversation(id: string, options?: AiCallOptions): Promise<{ ok: true }>
  chat(
    request: AiChatRequest,
    onEvent: (event: AiChatEvent) => void,
    options?: AiCallOptions,
  ): Promise<{ conversationId: string }>
  write(
    request: AiWriteRequest,
    onEvent: (event: AiWriteEvent) => void,
    options?: AiCallOptions,
  ): Promise<{ model: AiModelRef; isFallback: boolean }>
}

export type AiWriteAction = 'polish' | 'rewrite' | 'shorten' | 'expand' | 'continue'

export interface AiWriteRequest {
  action: AiWriteAction
  noteId: string
  selectedText: string
  beforeText: string
  afterText: string
  cursorOffset: number
  language: string
  title: string
}

export type AiWriteEvent =
  | { kind: 'delta'; text: string }
  | { kind: 'done'; inputTokens: number | null; outputTokens: number | null }

export interface AiWriteResult {
  model: AiModelRef
  isFallback: boolean
}
