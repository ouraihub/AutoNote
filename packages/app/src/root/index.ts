import { mount, unmount } from 'svelte'
import type { FlushResult } from '@shared/backend-types'
import { OverlayNotifier } from '../components/ui/overlay-notifier.svelte'
import { I18nState } from '../i18n/runtime.svelte'
import { OrganizeActions } from '../state/mutations'
import { NotesState } from '../state/notes.svelte'
import { SessionState } from '../state/session.svelte'
import { SettingsState } from '../state/settings.svelte'
import { UiState } from '../state/ui.svelte'
import AppRoot from './AppRoot.svelte'
import type { AppDeps, AppHandle } from './types'

export type { AppDeps, AppHandle, HostExtensions, HostPanel, HostSettingsSection } from './types'
export { getBackend, getClock, getExtensions, getI18n, getLogger, getNotes, getNotifier,
  getOrganize, getPrefs, getSession, getSettings, getUi } from './context'

function validateCapabilities({ backend }: AppDeps): void {
  const { capabilities } = backend
  if (capabilities.accounts !== (backend.session.account !== undefined))
    throw new Error('Account capability does not match session port')
  if (capabilities.totp && !capabilities.accounts)
    throw new Error('TOTP capability requires accounts')
  if (capabilities.share !== (backend.share !== undefined))
    throw new Error('Share capability does not match share port')
  if (capabilities.remoteBackup !== (backend.backup !== undefined))
    throw new Error('Remote backup capability does not match backup port')
  if ((capabilities.mcp === null) !== (backend.mcp === undefined) ||
    (capabilities.mcp === 'local' && (!backend.mcp || !('status' in backend.mcp))) ||
    (capabilities.mcp === 'remote' && (!backend.mcp || !('get' in backend.mcp))))
    throw new Error('MCP capability does not match MCP port')
  if (capabilities.updateCheck !== (backend.update !== undefined))
    throw new Error('Update capability does not match update port')
}

export function mountApp(target: HTMLElement, deps: AppDeps): AppHandle {
  validateCapabilities(deps)
  const i18n = new I18nState({ prefs: deps.prefs })
  const flushers = new Set<() => Promise<void>>()
  const registerFlush = (flush: () => Promise<void>): (() => void) => {
    flushers.add(flush)
    return () => { flushers.delete(flush) }
  }
  const overlay = deps.notifier instanceof OverlayNotifier
    ? deps.notifier
    : new OverlayNotifier((key, params) => i18n.t(key as Parameters<I18nState['t']>[0], params))
  const notes = new NotesState({ backend: deps.backend, logger: deps.logger })
  const settings = new SettingsState({ port: deps.backend.settings, logger: deps.logger, notifier: deps.notifier })
  const session = new SessionState({
    port: deps.backend.session,
    settings,
    notifier: deps.notifier,
    logger: deps.logger,
    clock: deps.clock,
    flushNotes: () => notes.flush(),
  })
  const ui = new UiState({ prefs: deps.prefs, logger: deps.logger, notifier: deps.notifier })
  const organize = new OrganizeActions({
    backend: deps.backend,
    state: { read: () => notes.readOrganizeSnapshot(), write: (patch) => notes.writeOrganizePatch(patch) },
    notifier: deps.notifier,
    now: () => deps.clock.now(),
  })
  const component = mount(AppRoot, {
    target,
    props: { deps, i18n, notes, settings, session, ui, organize, notifier: deps.notifier, overlay, registerFlush },
  })
  let destroyed = false
  let destroying: Promise<void> | null = null

  async function flush(): Promise<FlushResult> {
    if (destroyed) throw new Error('App is destroyed')
    const [result, saved] = await Promise.all([notes.flush(), settings.flush(), ui.flush()])
    await Promise.all([...flushers].map((save) => save()))
    if (!saved) return { pending: result.pending, failed: result.failed + 1 }
    return result
  }

  return {
    flush,
    destroy(): Promise<void> {
      if (destroyed) return Promise.resolve()
      destroying ??= (async () => {
        const result = await flush()
        if (result.failed || result.pending)
          throw new Error('Local changes are not safely persisted')
        session.dispose()
        notes.dispose()
        settings.dispose()
        while (overlay.active) overlay.dismiss()
        await unmount(component)
        destroyed = true
        await deps.backend.dispose()
      })().finally(() => { destroying = null })
      return destroying
    },
  }
}
