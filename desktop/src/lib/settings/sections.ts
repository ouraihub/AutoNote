import type { HostExtensions } from '@app/root'
import type { BackendCapabilities } from '@app/backend'
import DesktopGeneralSection from './DesktopGeneralSection.svelte'
import DesktopAboutPanel from './DesktopAboutPanel.svelte'
import DesktopSyncSection from './DesktopSyncSection.svelte'
export function desktopSettingsSections(capabilities: BackendCapabilities): HostExtensions {
  return { settingsSections: [{ id: 'desktop', order: 5, titleKey: 'settings.desktop', canShow: () => true, component: DesktopGeneralSection }, { id: 'desktop-sync', order: 15, titleKey: 'settings.sync', canShow: () => capabilities.remoteSync, component: DesktopSyncSection }], aboutPanels: [{ id: 'desktop', order: 1, titleKey: 'settings.about', component: DesktopAboutPanel }] }
}
