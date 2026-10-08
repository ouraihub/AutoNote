import { BrainCircuit, Monitor, RefreshCw } from '@lucide/svelte'
import type { HostExtensions } from '@app/root'
import type { BackendCapabilities } from '@app/backend'
import DesktopGeneralSection from './DesktopGeneralSection.svelte'
import DesktopAboutPanel from './DesktopAboutPanel.svelte'
import DesktopSyncSection from './DesktopSyncSection.svelte'
import McpSection from './McpSection.svelte'
export function desktopSettingsSections(capabilities: BackendCapabilities): HostExtensions {
  return { settingsSections: [{ id: 'desktop', order: 5, titleKey: 'settings.desktop', icon: Monitor, canShow: () => true, component: DesktopGeneralSection }, { id: 'desktop-sync', order: 15, titleKey: 'settings.sync', icon: RefreshCw, canShow: () => capabilities.remoteSync, component: DesktopSyncSection }, { id: 'desktop-mcp', order: 25, titleKey: 'settings.mcp', icon: BrainCircuit, canShow: () => capabilities.mcp === 'local', component: McpSection }], aboutPanels: [{ id: 'desktop', order: 1, titleKey: 'settings.about', component: DesktopAboutPanel }] }
}
