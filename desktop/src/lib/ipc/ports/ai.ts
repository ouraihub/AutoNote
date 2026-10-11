import type { AiCallOptions, AiPort, AiChatEvent, AiChatRequest, AiConversation, AiConversationSummary, AiEndpoint, AiEndpointSave, AiModel, AiModelRef, AiModelType, AiProbeError, AiProbeResult, AiProtocol, AiProvider, AiProviderSave, AiRole, AiRoleBinding, AiStoredMessage, AiWriteAction, AiWriteEvent, AiWriteRequest } from '@shared/ai-types'
import type { IpcTransport } from '../transport'

export type {
  AiCallOptions,
  AiChatEvent,
  AiChatRequest,
  AiConversation,
  AiConversationSummary,
  AiEndpoint,
  AiEndpointSave,
  AiModel,
  AiModelRef,
  AiProbeError,
  AiProbeResult,
  AiModelType,
  AiProtocol,
  AiProvider,
  AiProviderSave,
  AiRole,
  AiRoleBinding,
  AiStoredMessage,
  AiWriteAction,
  AiWriteEvent,
  AiWriteRequest,
  AiPort,
}

export function aiPort(transport: Pick<IpcTransport, 'invoke' | 'aiChat' | 'aiWrite'>): AiPort {
  return {
    listProviders: (options) => transport.invoke('ai_providers_list', undefined, options),
    saveProvider: (provider, options) => transport.invoke('ai_provider_save', { provider }, options),
    deleteProvider: (id, options) => transport.invoke('ai_provider_delete', { id }, options),
    revealKey: async (endpointId, options) =>
      (await transport.invoke('ai_endpoint_key_reveal', { id: endpointId }, options)).key,
    probe: (endpointId, options) => transport.invoke('ai_endpoint_probe', { id: endpointId, jobId: crypto.randomUUID() }, options),
    roles: (options) => transport.invoke('ai_roles_get', undefined, options),
    setRole: (role, binding, options) => transport.invoke('ai_roles_set', { role, binding }, options),
    listConversations: (options) => transport.invoke('ai_conversations_list', undefined, options),
    getConversation: (id, options) => transport.invoke('ai_conversation_get', { id }, options),
    deleteConversation: (id, options) => transport.invoke('ai_conversation_delete', { id }, options),
    chat: (request, onEvent, options) => transport.aiChat(request, onEvent, options),
    write: (request, onEvent, options) => transport.aiWrite(request, onEvent, options),
  }
}
