import { invoke, type InvokeOptions } from '@tauri-apps/api/core'
import { backendErrorFromPayload } from '@app/backend/errors'

export async function call<T>(
  command: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: InvokeOptions,
): Promise<T> {
  try {
    return await invoke<T>(command, args, options)
  } catch (error) {
    throw backendErrorFromPayload({ error }, { code: 'internal', status: 0, message: 'Desktop command failed' })
  }
}
