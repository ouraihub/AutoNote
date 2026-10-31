import type { Backend, BackendCapabilities } from '@app/backend'
import type { HostSettingsSection } from '@app/root/types'

export type SettingsSectionId =
  | 'appearance'
  | 'editor'
  | 'backup'
  | 'sync'
  | 'mcp'
  | 'relay'
  | 'account'
  | 'data'
  | 'shares'
  | 'about'

export type SettingsResourceId =
  'backupTargets' | 'backupRuns' | 'mcp' | 'stats' | 'totp' | 'shares'

export interface BuiltinSettingsSection {
  id: SettingsSectionId
  titleKey: string
  resources: readonly SettingsResourceId[]
}

const BUILTINS: readonly (BuiltinSettingsSection & {
  canShow(capabilities: BackendCapabilities): boolean
})[] = [
  {
    id: 'appearance',
    titleKey: 'settings.appearance',
    resources: [],
    canShow: () => true,
  },
  {
    id: 'editor',
    titleKey: 'settings.editor',
    resources: [],
    canShow: () => true,
  },
  {
    id: 'backup',
    titleKey: 'settings.backup',
    resources: ['backupTargets', 'backupRuns'],
    canShow: (c) => c.remoteBackup,
  },
  {
    id: 'sync',
    titleKey: 'settings.sync',
    resources: [],
    canShow: (c) => c.realtime || c.remoteSync,
  },
  {
    id: 'mcp',
    titleKey: 'settings.mcp',
    resources: ['mcp'],
    canShow: (c) => c.mcp === 'remote',
  },
  {
    id: 'relay',
    titleKey: 'settings.relay',
    resources: [],
    canShow: () => true,
  },
  {
    id: 'account',
    titleKey: 'settings.account',
    resources: ['totp'],
    canShow: (c) => c.accounts,
  },
  { id: 'data', titleKey: 'settings.data', resources: [], canShow: () => true },
  {
    id: 'shares',
    titleKey: 'share.shared_notes',
    resources: ['shares'],
    canShow: (c) => c.share,
  },
  {
    id: 'about',
    titleKey: 'settings.about',
    resources: [],
    canShow: () => true,
  },
]

export type VisibleSettingsSection =
  BuiltinSettingsSection | HostSettingsSection

export function settingsSections(
  backend: Backend,
  extensions: readonly HostSettingsSection[],
  role?: string,
): VisibleSettingsSection[] {
  const builtins: VisibleSettingsSection[] = BUILTINS.filter(
    (section) =>
      section.canShow(backend.capabilities) &&
      (section.id !== 'relay' || (!!backend.relay && role === 'owner')) &&
      (backend.kind === 'web' ||
        !['backup', 'sync', 'mcp', 'relay', 'account', 'shares'].includes(
          section.id,
        )),
  ).map(({ id, titleKey, resources }) => ({ id, titleKey, resources }))
  const ids = new Set(builtins.map((section) => section.id))
  const hosted: HostSettingsSection[] = []
  for (const section of [...extensions].sort((a, b) => a.order - b.order)) {
    if (ids.has(section.id) || !section.canShow()) continue
    hosted.push(section)
    ids.add(section.id)
  }
  const about = builtins.findIndex((section) => section.id === 'about')
  return about < 0
    ? [...builtins, ...hosted]
    : [...builtins.slice(0, about), ...hosted, ...builtins.slice(about)]
}

export function sectionResources(
  section: VisibleSettingsSection,
  capabilities: BackendCapabilities,
): readonly SettingsResourceId[] {
  if (!('resources' in section)) return []
  if (section.id === 'account' && !capabilities.totp) return []
  return section.resources
}
