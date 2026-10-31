import type { Hono } from 'hono'
import type { McpSettingsInfo } from '@shared/types'
import type { DemoState } from './state'

export interface DemoRouteContext {
  app: Hono
  state: DemoState
  mcp: McpSettingsInfo
  unlockedShares: Set<string>
}
