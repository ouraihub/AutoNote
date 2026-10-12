import {
  BackendError,
  ChangeFeedEmitter,
  type Backend,
  type CallOptions,
  type ChangeEvent,
  type NotesPort,
} from '@app/backend'
import type { PasswordLoginResult } from '@shared/types'
import type { Clock } from '@app/platform/clock'
import type { Logger } from '@app/log/logger'
import type { BackendSession } from '@shared/backend-types'
import { DEFAULT_SETTINGS } from '@shared/constants'
import type { UserSettings } from '@shared/types'
import { createLocalDb, type KvStore } from '../local'
import type { PageSignals, Timers } from '../platform'
import { LeaseReplayLock, NavigatorReplayLock, type ReplayLock } from '../outbox'
import { SyncPuller, SyncEngine, type SocketFactory } from '../sync'
import { HttpTransport, type FetchLike } from './transport'
import { BroadcastTabBus, type TabBus, type TabMessage } from './tab-bus'
import { HttpSessionPort } from './ports/session'
import { HttpSettingsPort } from './ports/settings'
import { HttpNotesPort } from './ports/notes-port'
import { HttpFoldersPort } from './ports/folders'
import { HttpTagsPort } from './ports/tags'
import { HttpSearchPort } from './ports/search'
import { HttpFilesPort } from './ports/files'
import { HttpTransferPort } from './ports/transfer'
import { HttpSharePort } from './ports/share'
import { HttpBackupPort } from './ports/backup'
import { HttpUpdatePort } from './ports/update'
import { HttpRemoteMcpPort } from './ports/mcp'
import { HttpAiPort } from './ports/ai'
import { createHttpAiHostPort } from './ports/ai-host'

export interface WebBackendDeps {
  fetch: FetchLike
  kv: KvStore
  bus?: TabBus
  lock?: ReplayLock
  sockets: SocketFactory | null
  resolveFileUrl?: (url: string) => string
  timers: Timers
  page: PageSignals
  clock: Clock
  logger: Logger
  getLocale(): string
  clientId: string
}

class AccountTabBus implements TabBus {
  readonly #listeners = new Set<(message: TabMessage) => void>()
  #bus: TabBus | null = null
  #unsubscribe: (() => void) | null = null
  constructor(private readonly supplied?: TabBus) {}
  bind(userId: string | null): void {
    this.#unsubscribe?.()
    if (this.#bus !== this.supplied) this.#bus?.close()
    this.#bus = userId ? (this.supplied ?? new BroadcastTabBus(userId)) : null
    this.#unsubscribe =
      this.#bus?.subscribe((message) => {
        if (message.userId !== undefined && message.userId !== userId) return
        for (const listener of this.#listeners) listener(message)
      }) ?? null
  }
  post(message: TabMessage): void {
    this.#bus?.post(message)
    for (const listener of this.#listeners) listener(message)
  }
  subscribe(listener: (message: TabMessage) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  close(): void {
    this.bind(null)
    this.supplied?.close()
    this.#listeners.clear()
  }
}

export function createWebBackend(deps: WebBackendDeps): Backend {
  const lifetime = new AbortController()
  const changes = new ChangeFeedEmitter()
  const bus = new AccountTabBus(deps.bus)
  const localDb = createLocalDb({
    kv: deps.kv,
    timers: deps.timers,
    onReadFailure: (key) =>
      deps.logger.warn('local.read.failed', {
        keyKind: key.includes('outbox')
          ? 'outbox'
          : key.includes('note:')
            ? 'content'
            : key === 'session'
              ? 'session'
              : 'shell',
        code: 'internal',
        count: 1,
      }),
    onMigrationFailure: () =>
      deps.logger.error('local.migration.failed', { keyKind: 'user', code: 'internal', count: 1 }),
  })
  const lock =
    deps.lock ??
    new NavigatorReplayLock(new LeaseReplayLock(deps.kv, localDb, deps.clock), () => localDb.activeUserId())
  let accountController = new AbortController()
  const transport = new HttpTransport({
    ...deps,
    bus,
    captureCurrent: () => {
      const epoch = accountController
      return () => accountController === epoch && !epoch.signal.aborted && !lifetime.signal.aborted
    },
    fetch: async (request) => {
      const epoch = accountController
      const signal = AbortSignal.any([request.signal, lifetime.signal, epoch.signal])
      const response = await deps.fetch(new Request(request, { signal }))
      if (signal.aborted || accountController !== epoch)
        throw new BackendError('cancelled', 0, 'Account request superseded')
      return response
    },
  })
  let owner: string | null = null
  let settings = DEFAULT_SETTINGS
  let siteRealtime = false
  let notes: HttpNotesPort | null = null
  let engine: SyncEngine | null = null
  let disposed = false
  let disposing: Promise<void> | null = null
  const emitChange = (event: ChangeEvent): void => {
    if (disposed) return
    changes.emit(event)
    if (
      event.kind === 'sync' &&
      (event.payload.settingsChanged || event.payload.profileChanged || event.payload.siteChanged)
    )
      changes.emit({ kind: 'settings' })
  }
  const adoptSettings = (value: UserSettings): void => {
    settings = value
    engine?.updateConfig(siteRealtime && value.sync.realtime, value.sync.pollIntervalMs)
  }
  const adoptSession = (value: BackendSession): BackendSession => {
    if (disposed) throw new BackendError('cancelled', 0, 'Backend disposed')
    const next = value.user?.id ?? null
    if (next !== owner) {
      accountController.abort()
      accountController = new AbortController()
      settings = DEFAULT_SETTINGS
      engine?.stop()
      notes?.dispose()
      notes = null
      engine = null
      owner = next
      bus.bind(next)
      if (next) {
        const emitAccountChange = (event: ChangeEvent): void => {
          if (owner === next && notes === port) emitChange(event)
        }
        const puller = new SyncPuller({
          transport,
          localDb,
          emitChange: emitAccountChange,
          clock: deps.clock,
          logger: deps.logger,
        })
        const onUnauthenticated = (): void => {
          if (owner !== next || notes !== port) return
          accountController.abort()
          accountController = new AbortController()
          engine?.pause()
          port.pause()
        }
        const port = new HttpNotesPort({
          ...deps,
          transport,
          localDb,
          lock,
          bus,
          emitChange: emitAccountChange,
          puller,
          getAutoSaveDelay: () => settings.editor.autoSaveDelay,
          onUnauthenticated,
          requestPull: (force) => {
            if (owner === next && notes === port) void engine?.pullNow({ force }).catch(() => undefined)
          },
        })
        engine = new SyncEngine({
          ...deps,
          bus,
          emitChange: emitAccountChange,
          onUnauthenticated,
          pull: (force, signal) => puller.pull(force, { signal }),
          replay: (signal) => port.flush(undefined, { signal }),
        })
        const sync = engine
        notes = port
        const snapshot = port.snapshot.bind(port)
        port.snapshot = async (options?: CallOptions) => {
          const result = await snapshot(options)
          if (notes === port && !options?.signal?.aborted && !disposed) sync.start(result.cursor)
          return result
        }
      }
    }
    siteRealtime = value.site.realtimeEnabled
    adoptSettings(value.settings ?? settings)
    engine?.resume()
    notes?.resume()
    return value
  }
  const sessionPort = new HttpSessionPort({
    transport,
    localDb,
    bus,
    clientId: deps.clientId,
    waitForLocalCommit: async () => {
      await notes?.waitForLocalCommit()
    },
    flush: async () => {
      await notes?.flush()
    },
    pending: async () => (notes ? notes.flush() : { pending: 0, failed: 0 }),
  })
  const account = sessionPort.account
  const requireNotes = (): HttpNotesPort => {
    if (!notes || disposed) throw new BackendError(disposed ? 'cancelled' : 'unauthenticated', 401, 'No active session')
    return notes
  }
  const notesPort: NotesPort = {
    snapshot: (options) => requireNotes().snapshot(options),
    list: (query, options) => requireNotes().list(query, options),
    get: (id, options) => requireNotes().get(id, options),
    create: (body, options) => requireNotes().create(body, options),
    patch: (id, body, options) => requireNotes().patch(id, body, options),
    remove: (id, options) => requireNotes().remove(id, options),
    restore: (id, options) => requireNotes().restore(id, options),
    purge: (id, options) => requireNotes().purge(id, options),
    duplicate: (id, body, options) => requireNotes().duplicate(id, body, options),
    emptyTrash: (options) => requireNotes().emptyTrash(options),
    versions: (id, options) => requireNotes().versions(id, options),
    version: (id, versionId, options) => requireNotes().version(id, versionId, options),
    restoreVersion: (id, versionId, options) => requireNotes().restoreVersion(id, versionId, options),
    backlinks: (id, options) => requireNotes().backlinks(id, options),
    flush: async (id, options) => (notes ? notes.flush(id, options) : { pending: 0, failed: 0 }),
    syncNow: (options) => requireNotes().syncNow(options),
  }
  const assertAllSaved = async (options?: CallOptions): Promise<void> => {
    const result = await requireNotes().flush(undefined, options)
    const journal = await localDb.getOutbox()
    if (result.pending || result.failed || journal.length)
      throw new BackendError('conflict', 409, 'Local changes are still pending')
  }
  const settingsPort = new HttpSettingsPort({ transport, bus, clientId: deps.clientId })
  const ai = new HttpAiPort({ transport })
  return {
    kind: 'web',
    capabilities: {
      accounts: true,
      totp: true,
      share: true,
      remoteBackup: true,
      semanticSearch: true,
      ai: true,
      realtime: deps.sockets !== null,
      mcp: 'remote',
      remoteSync: false,
      updateCheck: true,
    },
    changes,
    session: {
      load: async (options) => adoptSession(await sessionPort.load(options)),
      logout: async (options) => {
        await sessionPort.logout(options)
        accountController.abort()
        accountController = new AbortController()
        engine?.stop()
        notes?.dispose()
        notes = null
        engine = null
        owner = null
        bus.bind(null)
      },
      account: {
        totp: account.totp,
        register: async (...args) => adoptSession(await account.register(...args)),
        login: async (...args) => {
          const value = await account.login(...args)
          return 'twoFactorRequired' in value ? value : (adoptSession(value as BackendSession) as PasswordLoginResult)
        },
        completeTotpLogin: async (...args) => {
          const value = await account.completeTotpLogin(...args)
          adoptSession(value as BackendSession)
          return value
        },
        setPassword: (...args) => account.setPassword(...args),
        updateProfile: async (...args) => {
          const value = await account.updateProfile(...args)
          emitChange({ kind: 'settings' })
          return value
        },
        updateRegistration: async (...args) => {
          const value = await account.updateRegistration(...args)
          emitChange({ kind: 'settings' })
          return value
        },
      },
    },
    notes: notesPort,
    settings: {
      get: async (options) => {
        const user = owner
        const value = await settingsPort.get(options)
        if (disposed || owner !== user || options?.signal?.aborted)
          throw new BackendError('cancelled', 0, 'Settings request superseded')
        adoptSettings(value)
        return value
      },
      save: async (patch, options) => {
        const user = owner
        const value = await settingsPort.save(patch, options)
        if (disposed || owner !== user || options?.signal?.aborted)
          throw new BackendError('cancelled', 0, 'Settings request superseded')
        adoptSettings(value)
        return value
      },
      stats: (options) => settingsPort.stats(options),
    },
    folders: new HttpFoldersPort({
      transport,
      beforeRemove: async (strategy, options) => {
        if (strategy === 'delete') await assertAllSaved(options)
      },
    }),
    tags: new HttpTagsPort({ transport, beforeTextChange: assertAllSaved }),
    search: new HttpSearchPort({ transport }),
    files: new HttpFilesPort({ transport, ...(deps.resolveFileUrl ? { resolveFileUrl: deps.resolveFileUrl } : {}) }),
    transfer: new HttpTransferPort({ transport, logger: deps.logger, clock: deps.clock }),
    ai,
    aiHost: createHttpAiHostPort(transport),
    share: new HttpSharePort({ transport }),
    backup: new HttpBackupPort({ transport }),
    mcp: new HttpRemoteMcpPort({ transport }),
    update: new HttpUpdatePort({ transport }),
    dispose() {
      if (disposed) return Promise.resolve()
      if (disposing) return disposing
      disposing = (async () => {
        await notes?.waitForLocalCommit()
        disposed = true
        lifetime.abort()
        accountController.abort()
        engine?.stop()
        notes?.dispose()
        bus.close()
        changes.dispose()
      })().finally(() => {
        disposing = null
      })
      return disposing
    },
  }
}

export { HttpSessionPort, createHttpSessionPort } from './ports/session'
export type { LogoutPending, SessionPortDeps } from './ports/session'
export { HttpSettingsPort, createHttpSettingsPort } from './ports/settings'
export type { SettingsPortDeps } from './ports/settings'
export { HttpFoldersPort } from './ports/folders'
export { HttpTagsPort } from './ports/tags'
export { HttpSearchPort } from './ports/search'
export { HttpFilesPort } from './ports/files'
export { HttpNotesTextWriter } from './ports/notes'
export type { NotesTextWriterDeps } from './ports/notes'
export { HttpNotesPort } from './ports/notes-port'
export type { HttpNotesPortDeps } from './ports/notes-port'
export { HttpTransferPort } from './ports/transfer'
export type { TransferPortDeps } from './ports/transfer'
export { HttpSharePort } from './ports/share'
export type { SharePortDeps } from './ports/share'
export { HttpBackupPort } from './ports/backup'
export type { BackupPortDeps } from './ports/backup'
export { HttpRemoteMcpPort } from './ports/mcp'
export type { RemoteMcpPortDeps } from './ports/mcp'
export { HttpUpdatePort } from './ports/update'
export { HttpAiPort } from './ports/ai'
export type { UpdatePortDeps } from './ports/update'
export { browserSocketFactory } from '../sync'
export type { SocketFactory, SyncSocket } from '../sync'
