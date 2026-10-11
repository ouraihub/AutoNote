import { mountApp, type AppHandle } from '@app/root'
import { OverlayNotifier } from '@app/components/ui/overlay-notifier.svelte'
import { I18nState } from '@app/i18n/runtime.svelte'
import { TauriTransport, observeIpcFailures } from '../ipc/transport'
import { createIpcBackend } from '../ipc/ipc-backend'
import { IpcLogger } from '../log/ipc-logger'
import { DesktopPrefs } from '../prefs/local-prefs'
import { desktopSettingsSections } from '../settings/sections'

export async function bootDesktop(target: HTMLElement): Promise<AppHandle> {
  const transport = new TauriTransport()
  const backend = createIpcBackend(transport)
  const logger = new IpcLogger(transport)
  observeIpcFailures((command, code) => logger.warn('ipc.command.failed', { command, code }))
  const prefs = new DesktopPrefs()
  const i18n = new I18nState({ prefs })
  const notifier = new OverlayNotifier((key, params) => i18n.t(key as Parameters<I18nState['t']>[0], params))
  let stage = 'initialization'
  let handle: AppHandle | undefined
  try {
    stage = 'changes.start'
    await backend.changes.start()
    stage = 'mcp.startListening'
    await backend.mcp.startListening()
    stage = 'session.load'
    const session = backend.session.load()
    stage = 'i18n.init'
    const language = i18n.init()
    await Promise.all([session, language])
    stage = 'listenIntents'
    const intentListeners = new Set<(intent: 'new-note') => void>()
    await transport.listenIntents((intent) => {
      for (const listener of intentListeners) listener(intent)
    })
    stage = 'mountApp'
    handle = mountApp(target, {
      backend,
      clock: { now: () => Date.now() },
      logger,
      prefs,
      notifier,
      extensions: {
        ...desktopSettingsSections(backend.capabilities),
        subscribeIntents(listener) {
          intentListeners.add(listener)
          return () => {
            intentListeners.delete(listener)
          }
        },
      },
    })
    stage = 'onPrepareClose'
    await transport.onPrepareClose(
      async () => {
        const result = handle ? await handle.flush() : { pending: 0, failed: 1 }
        await logger.flush()
        return result
      },
      (active) => {
        target.inert = active
      },
    )
    const mounted = handle
    return {
      flush: () => mounted.flush(),
      openNote: (id, pane) => mounted.openNote(id, pane),
      async destroy() {
        const result = await mounted.flush()
        if (result.pending || result.failed) throw new Error('Local changes are not safely persisted')
        observeIpcFailures(undefined)
        await logger.dispose()
        await mounted.destroy()
      },
    }
  } catch (cause) {
    if (handle) await handle.destroy()
    observeIpcFailures(undefined)
    await logger.dispose()
    await backend.dispose()
    throw new Error(`desktop startup failed at ${stage}`, { cause })
  }
}
