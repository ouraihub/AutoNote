import { BrainCircuit, Monitor, RefreshCw, ScrollText } from '@lucide/svelte'
import type { HostAccountAction, HostExtensions } from '@app/root'
import type { Backend } from '@app/backend'
import type { Notifier } from '@app/platform/notifier'
import { listenSyncStatus } from '../ipc/transport'
import { syncPort, type SyncStatus } from '../ipc/ports/remote-sync'
import { confirmUnbind } from './sync-unbind'
import DesktopGeneralSection from './DesktopGeneralSection.svelte'
import DesktopAboutPanel from './DesktopAboutPanel.svelte'
import DesktopSyncSection from './DesktopSyncSection.svelte'
import McpSection from './McpSection.svelte'
import LogSettings from '../log/LogSettings.svelte'
import { aiHostExtensions } from '@app/features/ai'

export function desktopSettingsSections(backend: Backend, notifier: Notifier): HostExtensions {
  const { capabilities } = backend
  const ai = aiHostExtensions(backend)
  return {
    settingsSections: [
      {
        id: 'desktop',
        order: 5,
        titleKey: 'settings.desktop',
        icon: Monitor,
        canShow: () => true,
        component: DesktopGeneralSection,
      },
      {
        id: 'desktop-sync',
        order: 15,
        titleKey: 'settings.sync',
        icon: RefreshCw,
        canShow: () => capabilities.remoteSync,
        component: DesktopSyncSection,
      },
      {
        id: 'desktop-mcp',
        order: 25,
        titleKey: 'settings.mcp',
        icon: BrainCircuit,
        canShow: () => capabilities.mcp === 'local',
        component: McpSection,
      },
      ...ai.settingsSections,
      {
        id: 'desktop-logs',
        order: 35,
        titleKey: 'desktop.logsTitle',
        icon: ScrollText,
        canShow: () => true,
        component: LogSettings,
      },
    ],
    aboutPanels: [{ id: 'desktop', order: 1, titleKey: 'settings.about', component: DesktopAboutPanel }],
    ...(ai.workspacePanel ? { workspacePanel: ai.workspacePanel } : {}),
    ...(ai.writingToolbar ? { writingToolbar: ai.writingToolbar } : {}),
    ...(capabilities.remoteSync
      ? {
          // The local library has no account: the account menu signs in to, or unbinds from, remote sync.
          subscribeAccountAction(listener: (action: HostAccountAction | null) => void) {
            let active = true
            let unlisten: (() => void) | undefined
            const show = (status: SyncStatus) => {
              if (!active) return
              listener(
                status.phase === 'unbound'
                  ? { labelKey: 'desktopSync.menuSignIn', destructive: false, run: { settingsSection: 'desktop-sync' } }
                  : {
                      labelKey: 'desktopSync.menuUnbind',
                      destructive: true,
                      run: async () => void (await confirmUnbind(notifier)),
                    },
              )
            }
            void listenSyncStatus(show)
              .then((dispose) => {
                if (active) unlisten = dispose
                else dispose()
                return syncPort.status()
              })
              .then(show)
              .catch(() => active && listener(null))
            return () => {
              active = false
              unlisten?.()
            }
          },
        }
      : {}),
  }
}
