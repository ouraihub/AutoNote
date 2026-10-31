import type { Attachment } from '@shared/types'
import type {
  FilesPort,
  FoldersPort,
  NotesPort,
  SettingsPort,
  TagsPort,
} from '../port'

export type WriteConflictMode = 'reject' | 'rebase'

export interface ContractBackend {
  readonly notes: Pick<
    NotesPort,
    | 'snapshot'
    | 'list'
    | 'get'
    | 'create'
    | 'patch'
    | 'remove'
    | 'restore'
    | 'purge'
    | 'emptyTrash'
    | 'versions'
    | 'version'
    | 'flush'
  >
  readonly folders: Pick<FoldersPort, 'list' | 'create'>
  readonly tags: Pick<TagsPort, 'list' | 'create'>
  readonly files: Pick<FilesPort, 'list' | 'upload'>
  readonly settings: Pick<SettingsPort, 'get' | 'save'>
  dispose(): Promise<void>
}

/** A disposable isolated library/account, shared by independently opened backend connections. */
export interface ContractLibrary<B extends ContractBackend> {
  /** Open a real online backend with a fresh view of the same isolated library. */
  open(): Promise<B>
  /** Fetch bytes through the actual host's attachment URL/protocol, not the upload source buffer. */
  readAttachment(backend: B, attachment: Attachment): Promise<Uint8Array>
  dispose(): Promise<void>
}

/** Host-owned factory: use a fresh library/account for each case; no production data or fake. */
export interface BackendContractFixture<
  B extends ContractBackend = ContractBackend,
> {
  /** Choose 'rebase' for Web text outbox; direct HTTP API and Desktop writes use 'reject'. */
  readonly writeConflictMode: WriteConflictMode
  createLibrary(): Promise<ContractLibrary<B>>
}

export interface BackendContractCase {
  readonly name: string
  run(fixture: BackendContractFixture): Promise<void>
}

export type BackendContractResult =
  | { readonly name: string; readonly ok: true }
  | { readonly name: string; readonly ok: false; readonly error: unknown }
