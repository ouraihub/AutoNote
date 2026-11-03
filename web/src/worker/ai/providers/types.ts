import type {
  ModelPricing,
  ModelType,
  Protocol,
  Provider,
  ReasoningConfig,
  KeyStrategy,
} from '@ouraihub/aether-ui/ports'
import type { KitFailure } from '../kit'

export interface Connection {
  baseUrl: string
  imageBaseUrl: string | null
  imageEditBaseUrl: string | null
  protocol: Protocol
  headers: Record<string, string>
  apiKeys: string[]
  setAside:
    ((key: string, until: number, reason: string) => Promise<void>) | null
  exhaustion?: { failure: KitFailure | null }
  modelId: string
  endpointId: string
  contextWindow: number | null
  maxOutput: number | null
  supportsTools: boolean | null
  reasoning: ReasoningConfig | null
  nativeWebSearch: boolean
  canVision: boolean
  pricing: ModelPricing | null
}

export interface EndpointRow {
  id: string
  providerId: string
  slug: string
  baseUrl: string
  protocol: Protocol
  imageBaseUrl: string | null
  imageEditBaseUrl: string | null
  headers: string
  keyStrategy: KeyStrategy
}

export interface KeyRow {
  id: string
  endpointId: string
  label: string
  enabled: number
  keyCiphertext: string
  exhaustedUntil: number | null
  exhaustedReason: string | null
}

export interface ModelRow {
  endpointId: string
  modelType: ModelType
  id: string
  typeSource: 'inferred' | 'user'
  contextWindow: number | null
  maxOutput: number | null
  canVision: number
  supportsTools: number | null
  reasoning: string | null
  nativeWebSearch: number
  name: string | null
  groupName: string | null
  pricing: string | null
}

export type ListedProvider = Pick<
  Provider,
  'id' | 'name' | 'enabled' | 'notes' | 'presetId'
>
