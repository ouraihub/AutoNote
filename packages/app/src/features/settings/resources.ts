import { createContext } from 'svelte'
import type { Backend } from '@app/backend'
import type { SettingsResourceId } from './sections'

export function createSettingsResource<T>(fetcher: (signal: AbortSignal) => Promise<T>) {
  let value: T | undefined
  let pending: Promise<T | undefined> | undefined
  let controller: AbortController | undefined
  let revision = 0

  return {
    peek: () => value,
    load(): Promise<T | undefined> {
      if (pending) return pending
      if (value !== undefined) return Promise.resolve(value)
      const current = ++revision
      controller = new AbortController()
      const signal = controller.signal
      const request = fetcher(signal)
        .then((result) => {
          if (revision === current && !signal.aborted) value = result
          return revision === current && !signal.aborted ? result : undefined
        })
        .finally(() => {
          if (pending === request) {
            pending = undefined
            controller = undefined
          }
        })
      pending = request
      return request
    },
    cancel(): void {
      if (!pending) return
      revision++
      controller?.abort()
      pending = undefined
      controller = undefined
    },
    clear(): void {
      revision++
      controller?.abort()
      pending = undefined
      controller = undefined
      value = undefined
    },
  }
}

export function createSettingsResources(backend: Backend): SettingsResources {
  const resources = {
    backupTargets: createSettingsResource((signal) => backend.backup!.targets({ signal })),
    backupRuns: createSettingsResource((signal) => backend.backup!.runs({ signal })),
    mcp: createSettingsResource((signal) => backend.mcp!.getPreferences({ signal })),
    stats: createSettingsResource((signal) => backend.settings.stats({ signal })),
    totp: createSettingsResource((signal) => backend.session.account!.totp.status({ signal })),
    shares: createSettingsResource((signal) => backend.share!.list({ signal })),
  }
  let epoch: number | undefined
  return {
    peek: (id: SettingsResourceId) => resources[id].peek(),
    load: (id: SettingsResourceId, nextEpoch: number) => {
      if (epoch !== nextEpoch) {
        Object.values(resources).forEach((resource) => resource.clear())
        epoch = nextEpoch
      }
      return resources[id].load()
    },
    cancel: () => Object.values(resources).forEach((resource) => resource.cancel()),
    clear: () => {
      Object.values(resources).forEach((resource) => resource.clear())
      epoch = undefined
    },
  }
}

export interface SettingsResources {
  peek(id: SettingsResourceId): unknown
  load(id: SettingsResourceId, epoch: number): Promise<unknown>
  cancel(): void
  clear(): void
}
export const [getSettingsResources, setSettingsResources] = createContext<SettingsResources>()
