/// <reference types="vite/client" />
import type { AppDeps } from '@app/root'
import { aiHostExtensions } from '@app/features/ai'
import { I18nState } from '@app/i18n/runtime.svelte'
import { OverlayNotifier } from '@app/components/ui/overlay-notifier.svelte'
import { createWebBackend, browserSocketFactory } from './backend'
import type { FetchLike } from './backend/transport'
import { MemoryTabBus } from './backend/tab-bus'
import { IdbKvStore } from './local'
import { ConsoleRingLogger, DiagnosticsPanel } from './log'
import { browserPageSignals, browserTimers, WebPrefsStore } from './platform'
import type { ReplayLock } from './outbox/replay-lock'

export const CLIENT_DATABASE_NAME =
  import.meta.env.MODE === 'demo' ? 'autonote-demo' : 'autonote'
export const IS_DEMO_MODE = import.meta.env.MODE === 'demo'
export function createClientId(
  randomUuid: () => string = () => crypto.randomUUID(),
): string {
  return randomUuid()
}
export const CLIENT_ID = createClientId()

export interface WebServices {
  logger: ConsoleRingLogger
  language: I18nState
  notifier: OverlayNotifier
  prefs: AppDeps['prefs']
  kv: IdbKvStore
  fetch: FetchLike
  resolveFileUrl?: (url: string) => string
  demoUserId?: string
  dispose(): void
}

export async function createWebServices(): Promise<WebServices> {
  const logger = new ConsoleRingLogger({ includeDebug: import.meta.env.DEV })
  const storage = new WebPrefsStore()
  const language = new I18nState({ prefs: storage })
  await language.init()
  const prefs: AppDeps['prefs'] = {
    load: (key) => storage.load(key),
    save: async (key, value) => {
      await storage.save(key, value)
      if (
        key === 'appearance.language' &&
        (value === 'en-US' || value === 'zh-CN')
      )
        await language.setLocale(value, false)
    },
    remove: (key) => storage.remove(key),
  }
  const notifier = new OverlayNotifier((key, params) =>
    language.t(key as Parameters<I18nState['t']>[0], params),
  )
  const kv = new IdbKvStore({ databaseName: CLIENT_DATABASE_NAME })
  if (IS_DEMO_MODE) {
    const { createDemoRuntime } = await import('./demo')
    await kv.clear()
    const demo = createDemoRuntime()
    return {
      logger,
      language,
      notifier,
      prefs,
      kv,
      fetch: demo.fetch,
      resolveFileUrl: demo.resolveFileUrl,
      demoUserId: demo.userId,
      dispose: demo.dispose,
    }
  }
  return {
    logger,
    language,
    notifier,
    prefs,
    kv,
    fetch: (request) => globalThis.fetch(request),
    dispose: () => undefined,
  }
}

export function createWebRuntime(services: WebServices): AppDeps {
  let replay: Promise<void> = Promise.resolve()
  const lock: ReplayLock = {
    run: async (_owner, task) => {
      const next = replay
        .catch(() => undefined)
        .then(() => task(async () => true))
      replay = next
      await next
      return true
    },
  }
  const backend = createWebBackend({
    fetch: services.fetch,
    kv: services.kv,
    sockets: IS_DEMO_MODE ? null : browserSocketFactory,
    ...(services.demoUserId
      ? { bus: new MemoryTabBus(services.demoUserId), lock }
      : {}),
    ...(services.resolveFileUrl
      ? { resolveFileUrl: services.resolveFileUrl }
      : {}),
    timers: browserTimers,
    page: browserPageSignals,
    clock: { now: () => Date.now() },
    logger: services.logger,
    clientId: CLIENT_ID,
    getLocale: () => services.language.locale,
  })
  const actualBackend = { ...backend }
  if (IS_DEMO_MODE) {
    delete actualBackend.update
    delete actualBackend.aiHost
    delete actualBackend.relay
    actualBackend.capabilities = {
      ...backend.capabilities,
      totp: false,
      semanticSearch: false,
      updateCheck: false,
    }
  }
  const aiExtensions = aiHostExtensions(actualBackend)
  return {
    backend: actualBackend,
    clock: { now: () => Date.now() },
    logger: services.logger,
    prefs: services.prefs,
    notifier: services.notifier,
    extensions: {
      settingsSections: [...aiExtensions.settingsSections],
      aboutPanels: [
        {
          id: 'diagnostics',
          order: 100,
          titleKey: 'host.diagnostics',
          component: DiagnosticsPanel,
        },
      ],
      ...(aiExtensions.workspacePanel
        ? { workspacePanel: aiExtensions.workspacePanel }
        : {}),
      ...(aiExtensions.writingToolbar
        ? { writingToolbar: aiExtensions.writingToolbar }
        : {}),
    },
    ...(IS_DEMO_MODE
      ? { authDefaults: { username: 'admin', password: 'password' } }
      : {}),
  }
}
