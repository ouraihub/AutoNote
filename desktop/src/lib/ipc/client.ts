import { invoke } from '@tauri-apps/api/core'
import type { AppErrorPayload, AppInfo } from './types'

export interface AppClient {
  appInfo(): Promise<AppInfo>
}

export class IpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error) {
    const payload = error as Partial<AppErrorPayload> | string
    if (typeof payload === 'object' && payload && typeof payload.code === 'string') {
      throw new IpcError(payload.code, payload.message ?? payload.code)
    }
    throw new IpcError('IPC_FAILED', String(error))
  }
}

export const tauriClient: AppClient = {
  appInfo: () => call<AppInfo>('app_info'),
}
