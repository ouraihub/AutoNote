import { call } from './transport'
import type { AppInfo, LogEntry } from './types'

export interface AppClient {
  appInfo(): Promise<AppInfo>
}

export interface LogsClient {
  readLogs(limit: number): Promise<LogEntry[]>
}

export const tauriClient: AppClient & LogsClient = {
  appInfo: () => call<AppInfo>('app_info'),
  readLogs: (limit) => call<LogEntry[]>('app_logs_tail', { limit }),
}
