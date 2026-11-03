export type BackupFileKind =
  'note' | 'attachment' | 'readme' | 'manifest' | 'complete'

export interface BackupFile {
  path: string
  byteLength: number
  sha256: string
  contentType: string
  kind: BackupFileKind
  open: () => Promise<ReadableStream<Uint8Array>>
}

export interface MaterializedBackupFile {
  path: string
  body: Uint8Array
  contentType: string
}

export interface Snapshot {
  payloadFiles: BackupFile[]
  manifestFile: BackupFile
  completeFile: BackupFile
  noteCount: number
  attachmentCount: number
  bytes: number
  stamp: string
  createdAt: Date
}

export interface AttachmentSnapshotRow {
  id: string
  user_id: string
  filename: string
  mime: string
  size: number
  sha256: string
  storage: string
  created_at: number
}
