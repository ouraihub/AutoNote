export interface AppInfo {
  name: string
  version: string
  dataDir: string
  schemaVersion: number
}


export interface LogEntry {
  seq: number
  time: string
  level: string
  target: string
  message: string
}
