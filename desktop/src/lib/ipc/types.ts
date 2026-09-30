export interface AppInfo {
  name: string
  version: string
  dataDir: string
  schemaVersion: number
}

export interface AppErrorPayload {
  code: string
  message: string
}
